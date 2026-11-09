import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type Order, type OrderSummary } from '../api';
import { decimals, money, parseAmount, round } from '../money';
import { boot, failedCount, online, openToPack, queue, register } from '../state';
import { shopDate, shopDateTime, shopTime } from '../time';
import { discardQueued, flushQueue, pollStock, pollToPack, retryQueued } from '../sync';
import { refundTotal } from '../totals';
import { Modal, requestIds, Spinner, Stepper } from '../ui';
import { EmailReceipt, giftFromOrder, printReceipt, receiptFromOrder } from './receipt';

/** A moment in the shop's clock, said the way a counter reads it: just now, minutes ago, the time today. */
const when = (ts: number | null) => {
  if (!ts) return '';
  const now = Date.now() / 1000;
  const diff = now - ts;
  if (diff < 45) return 'just now';
  if (diff < 45 * 60) return `${Math.max(1, Math.round(diff / 60))} min ago`;
  if (shopDate(ts) === shopDate(now)) return shopTime(ts);
  return shopDateTime(ts);
};

/**
 * The same id for a retry of the same request, so a lost response doesn't apply it twice, and a new one
 * once the cashier changes it, so the change isn't taken for a retry.
 */
function Refund({ order, onDone, onClose }: { order: Order; onDone: (o: Order) => void; onClose: () => void }) {
  const methods = Object.entries(boot.value?.payment_methods ?? {});
  // A split payment defaults to whatever took the most; a method switched off since falls back to the first.
  const largest = [...order.payments].sort((a, b) => b.amount - a.amount)[0]?.method;
  const original = methods.some(([k]) => k === largest) ? largest! : methods[0]?.[0] ?? '';
  const [qty, setQty] = useState<Record<number, number>>({});
  const [byAmount, setByAmount] = useState(false);
  const [amount, setAmount] = useState('');
  const [restock, setRestock] = useState(true);
  const [method, setMethod] = useState(original);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requests = requestIds(`refund ${order.id}`);

  const refundable = order.items.map((i) => ({ item: i, left: i.qty - i.qty_refunded })).filter((x) => x.left > 0);
  const lineTotal = refundTotal(order.items, qty, decimals());
  // Items still come back after an amount refund has paid out what they were worth.
  const total = byAmount ? round(parseAmount(amount)) : Math.min(lineTotal, order.remaining_refund);
  const picked = Object.values(qty).some((q) => q > 0);
  // Goods not paid for yet come off what is owed before any money goes back.
  const offOwed = Math.min(total, order.owed);
  const back = round(total - offOwed);
  const ready = byAmount ? total > 0 && total <= order.remaining_refund + 0.001 : picked;

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setError('');
    try {
      const body = byAmount
        ? { amount: total, method, reason, register_id: register.value?.id }
        : {
            lines: Object.entries(qty)
              .filter(([, q]) => q > 0)
              .map(([id, q]) => ({ item_id: Number(id), qty: q })),
            restock,
            method,
            reason,
            register_id: register.value?.id,
          };
      const id = requests.id(body);
      const refunded = await api.refund(order.id, { ...body, request_id: id });
      requests.answered(id);
      // Goods back on the shelf can be sold again straight away.
      if (!byAmount && restock) void pollStock().catch(() => {});
      onDone(refunded);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Refund order #${order.number}`}
      onClose={onClose}
      wide
      footer={
        <button class="danger" type="submit" form={`refund-${order.id}`} disabled={busy || !ready}>
          {busy ? <Spinner /> : `Refund ${money(total || 0)}`}
        </button>
      }
    >
      <div class="toggle">
        <button class={byAmount ? '' : 'active'} aria-pressed={!byAmount} onClick={() => setByAmount(false)}>
          Items
        </button>
        <button class={byAmount ? 'active' : ''} aria-pressed={byAmount} onClick={() => setByAmount(true)}>
          Amount
        </button>
      </div>
      <form id={`refund-${order.id}`} onSubmit={submit}>
        {byAmount ? (
          <label class="form">
            Amount (up to {money(order.remaining_refund)})
            <input inputMode="decimal" value={amount} onInput={(e) => setAmount(e.currentTarget.value)} autofocus />
            {amount.trim() && Number.isNaN(parseAmount(amount)) && <span class="error">That is not a number.</span>}
          </label>
        ) : (
          <>
            {refundable.length > 1 && (
              <div class="row-actions">
                {/* The whole-order return is the common one; one tap picks everything. */}
                <button
                  type="button"
                  onClick={() => {
                    const all: Record<number, number> = {};
                    for (const { item, left } of refundable) all[item.id] = left;
                    setQty(all);
                  }}
                >
                  All items
                </button>
              </div>
            )}
            <table class="refund-lines">
              <tbody>
                {refundable.map(({ item, left }) => (
                  <tr key={item.id}>
                    <td>{item.name}</td>
                    <td class="muted">{left} refundable</td>
                    <td>
                      <Stepper
                        value={qty[item.id] ?? 0}
                        onChange={(n) => setQty({ ...qty, [item.id]: n })}
                        max={left}
                        less={`Fewer ${item.name}`}
                        more={`More ${item.name}`}
                      >
                        <span>{qty[item.id] ?? 0}</span>
                      </Stepper>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {refundable.length === 0 && <p class="muted">Every item has been refunded. Use Amount for anything else.</p>}
            <label class="check">
              <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.currentTarget.checked)} /> Put items back in stock
            </label>
          </>
        )}
        <div class="form">
          {(back > 0 || !order.owed) && (
            <label>
              Refund with
              <select value={method} onChange={(e) => setMethod(e.currentTarget.value)}>
                {methods.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Reason
            <input value={reason} onInput={(e) => setReason(e.currentTarget.value)} />
          </label>
        </div>
        {order.owed > 0 && offOwed > 0 ? (
          <p class="muted small">
            {money(offOwed)} comes off what is still owed{back > 0 ? `. Pay ${money(back)} back through the method chosen.` : '. No money goes back.'}
          </p>
        ) : (
          <p class="muted small">This records the refund in WooCommerce. Pay the money back through the method chosen.</p>
        )}
        {!byAmount && lineTotal > order.remaining_refund + 0.001 && (
          <p class="warn small">Only {money(order.remaining_refund)} can be paid out; an amount refund already took the rest.</p>
        )}
        {error && <p class="error">{error}</p>}
      </form>
    </Modal>
  );
}

function TakePayment({ order, onDone, onClose }: { order: Order; onDone: (o: Order) => void; onClose: () => void }) {
  const methods = Object.entries(boot.value?.payment_methods ?? {});
  const [method, setMethod] = useState(methods[0]?.[0] ?? 'cash');
  const [amount, setAmount] = useState(String(order.owed));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requests = requestIds(`pay ${order.id}`);
  const value = round(parseAmount(amount));

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = { payments: [{ method, amount: value }], register_id: register.value?.id };
      const id = requests.id(body);
      const paid = await api.pay(order.id, { ...body, request_id: id });
      requests.answered(id);
      onDone(paid);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Take payment on #${order.number}`} onClose={onClose}>
      <form class="form" onSubmit={submit}>
        <label>
          Amount (owed {money(order.owed)})
          <input inputMode="decimal" value={amount} onInput={(e) => setAmount(e.currentTarget.value)} onFocus={(e) => e.currentTarget.select()} autofocus />
        </label>
        <label>
          Paid with
          <select value={method} onChange={(e) => setMethod(e.currentTarget.value)}>
            {methods.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        {error && <p class="error">{error}</p>}
        <button class="primary" disabled={busy || !(value > 0 && value <= order.owed + 0.001)}>
          {busy ? <Spinner /> : `Take ${money(value || 0)}`}
        </button>
      </form>
    </Modal>
  );
}

const FULFIL: Record<string, string> = { processing: 'Processing', 'on-hold': 'On hold', completed: 'Completed' };
const STATUSES: Record<string, string> = { ...FULFIL, pending: 'Pending payment', refunded: 'Refunded', cancelled: 'Cancelled' };

/** Where an order goes and how far along it is, for packing it or handing it over at the counter. */
function Fulfilment({ order, onChange }: { order: Order; onChange: (o: Order) => void }) {
  // A till sale on hold is waiting for its money, which only a payment moves on.
  const options = Object.entries(FULFIL).filter(([k]) => !order.pos || k !== 'on-hold');
  // Applied with a button, because arrowing through the list fires a change, and a customer email, per step.
  const [status, setStatus] = useState(order.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const move = async (status: string) => {
    setBusy(true);
    setError('');
    try {
      onChange(await api.setStatus(order.id, status));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const contact = [order.phone, order.email].filter(Boolean);
  return (
    <div class="fulfilment">
      {order.fulfil === 'collect' && (
        <p>
          <strong>To collect</strong>
        </p>
      )}
      {order.shipping_address.length > 0 && (
        <p>
          <strong>
            {order.pos ? 'Deliver to' : 'Ship to'}
            {order.shipping_method && ` · ${order.shipping_method}`}
          </strong>
          {'\n' + order.shipping_address.join('\n')}
        </p>
      )}
      {!order.shipping_address.length && order.shipping_method && (
        <p>
          <strong>{order.shipping_method}</strong>
        </p>
      )}
      {(order.billing_address.length > 0 || contact.length > 0) && (
        <p>
          <strong>Customer</strong>
          {'\n' + [...order.billing_address, ...contact].join('\n')}
        </p>
      )}
      {(order.pos || boot.value?.user.can_manage_orders) && options.some(([k]) => k === order.status) && (
        <div class="search-bar">
          <label>
            Status
            <select value={status} disabled={busy} onChange={(e) => setStatus(e.currentTarget.value)}>
              {options.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <button disabled={busy || status === order.status} onClick={() => void move(status)}>
            {busy ? <Spinner /> : 'Set status'}
          </button>
        </div>
      )}
      {error && <p class="error">{error}</p>}
    </div>
  );
}

function AddNote({ order, onDone, onClose }: { order: Order; onDone: (o: Order) => void; onClose: () => void }) {
  const [note, setNote] = useState('');
  const [toCustomer, setToCustomer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requests = requestIds(`note ${order.id}`);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = { note: note.trim(), customer: toCustomer };
      const id = requests.id(body);
      const saved = await api.addNote(order.id, { ...body, request_id: id });
      requests.answered(id);
      onDone(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Note on #${order.number}`} onClose={onClose}>
      <form class="form" onSubmit={submit}>
        <textarea rows={4} maxLength={1000} value={note} onInput={(e) => setNote(e.currentTarget.value)} autofocus aria-label="Note" />
        <label class="check">
          <input type="checkbox" checked={toCustomer} disabled={!order.email} onChange={(e) => setToCustomer(e.currentTarget.checked)} /> Send to the customer
        </label>
        {toCustomer && <p class="muted small">Emailed to {order.email} if the shop sends customer emails from the till.</p>}
        {error && <p class="error">{error}</p>}
        <button class="primary" disabled={busy || !note.trim()}>
          {busy ? <Spinner /> : 'Add note'}
        </button>
      </form>
    </Modal>
  );
}

export function OrderDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<'refund' | 'email' | 'pay' | 'note' | null>(null);
  useEffect(() => {
    api.order(id).then(setOrder, (e) => setError(e.message));
  }, [id]);

  return (
    <Modal
      title={order ? `Order #${order.number}` : 'Order'}
      onClose={onClose}
      wide
      footer={
        order && (
          <>
            <button onClick={() => printReceipt(receiptFromOrder(order))}>Reprint</button>
            {order.items.some((i) => i.qty > i.qty_refunded) && <button onClick={() => printReceipt(giftFromOrder(order))}>Gift receipt</button>}
            <button onClick={() => setDialog('email')}>Email</button>
            {order.owed > 0 && (
              <button class="primary" onClick={() => setDialog('pay')}>
                Take payment
              </button>
            )}
            {boot.value?.user.can_refund && (order.remaining_refund > 0 || order.items.some((i) => i.qty > i.qty_refunded)) && (
              <button class="danger" onClick={() => setDialog('refund')}>
                Refund
              </button>
            )}
          </>
        )
      }
    >
      {error && <p class="error">{error}</p>}
      {!order && !error && <Spinner />}
      {order && (
        <div class="order-detail">
          <p class="muted">
            {when(order.date)} · {order.status}
            {order.register && ` · ${order.register.name}`}
            {order.customer && ` · ${order.customer}`}
          </p>
          {(!order.pos || order.fulfil) && <Fulfilment key={order.status} order={order} onChange={setOrder} />}
          <table>
            <tbody>
              {order.items.map((i) => (
                <tr key={i.id}>
                  <td>
                    {i.qty} × {i.name}
                    {i.qty_refunded > 0 && <span class="badge out">{i.qty_refunded} refunded</span>}
                    {i.meta.length > 0 && <small>{i.meta.map((m) => `${m.key}: ${m.value}`).join(', ')}</small>}
                  </td>
                  <td class="num">{money(order.prices_include_tax ? i.subtotal + i.subtotal_tax : i.subtotal)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              {order.discount_total > 0 && (
                <tr>
                  <td>Discount {order.coupons.map((c) => c.code).join(', ')}</td>
                  <td class="num">−{money(order.prices_include_tax ? order.discount_total + order.discount_tax : order.discount_total)}</td>
                </tr>
              )}
              {order.taxes.map((t) => (
                <tr key={t.label} class="muted">
                  <td>{order.prices_include_tax ? `Includes ${t.label}` : t.label}</td>
                  <td class="num">{money(t.amount)}</td>
                </tr>
              ))}
              <tr class="grand">
                <td>Total</td>
                <td class="num">{money(order.total)}</td>
              </tr>
              {order.owed > 0 && (
                <tr class="warn">
                  <td>Still owed</td>
                  <td class="num">{money(order.owed)}</td>
                </tr>
              )}
              {order.payments.map((p, i) => (
                <tr key={i}>
                  <td>
                    {p.label ?? p.method}
                    {p.change ? ` (tendered ${money(p.tendered ?? 0)}, change ${money(p.change)})` : ''}
                  </td>
                  <td class="num">{money(p.amount)}</td>
                </tr>
              ))}
              {order.refunds.map((r) => (
                <tr key={r.id} class="refund">
                  <td>
                    Refund {when(r.date)}
                    {r.reason && ` · ${r.reason}`}
                  </td>
                  <td class="num">−{money(r.amount)}</td>
                </tr>
              ))}
            </tfoot>
          </table>
          {order.note && <p>Note: {order.note}</p>}
          <details class="notes">
            <summary>Notes ({order.notes.length})</summary>
            <ul>
              {order.notes.map((n) => (
                <li key={n.id}>
                  {n.content}
                  <small>
                    {when(n.date)}
                    {n.by && ` · ${n.by}`}
                    {n.customer && ' · to the customer'}
                  </small>
                </li>
              ))}
            </ul>
            <button onClick={() => setDialog('note')}>Add note</button>
          </details>
        </div>
      )}
      {order && dialog === 'refund' && (
        <Refund
          order={order}
          onClose={() => setDialog(null)}
          onDone={(o) => {
            setOrder(o);
            setDialog(null);
          }}
        />
      )}
      {order && dialog === 'pay' && (
        <TakePayment
          order={order}
          onClose={() => setDialog(null)}
          onDone={(o) => {
            setOrder(o);
            setDialog(null);
          }}
        />
      )}
      {order && dialog === 'note' && (
        <AddNote
          order={order}
          onClose={() => setDialog(null)}
          onDone={(o) => {
            setOrder(o);
            setDialog(null);
          }}
        />
      )}
      {order && dialog === 'email' && <EmailReceipt orderId={order.id} initial={order.email} onClose={() => setDialog(null)} />}
    </Modal>
  );
}

function Queued() {
  if (!queue.value.length) return <p class="muted">Every sale has been saved to the shop.</p>;
  return (
    <ul class="order-list">
      {queue.value.map((q) => (
        <li key={q.client_id} class={q.status}>
          <div class="grow">
            <strong>{money(q.receipt.total)}</strong> <span class="muted">{new Date(q.created_at).toLocaleString()}</span>
            <div class="small">{q.receipt.lines.map((l) => `${l.qty} × ${l.name}`).join(', ')}</div>
            <div class="small">
              {q.status === 'failed' ? <span class="error">{q.error}</span> : q.error ? `Waiting to sync (${q.error})` : 'Waiting to sync'}
              {q.email_to && <span class="muted">. Receipt goes to {q.email_to}.</span>}
            </div>
          </div>
          <button onClick={() => printReceipt({ ...q.receipt, copy: true })}>Reprint</button>
          <button onClick={() => printReceipt({ ...q.receipt, gift: true })}>Gift receipt</button>
          {q.status === 'failed' && (
            <>
              <button onClick={() => void retryQueued(q.client_id)}>Retry</button>
              <button class="danger" onClick={() => confirm('Discard this sale? It will not reach WooCommerce.') && void discardQueued(q.client_id)}>
                Discard
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export function Orders() {
  const [tab, setTab] = useState<'shop' | 'queue'>(queue.value.length ? 'queue' : 'shop');
  const [search, setSearch] = useState('');
  const [source, setSource] = useState<'pos' | 'web' | 'all' | 'later'>('pos');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<{ orders: OrderSummary[]; total_pages: number } | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<number | null>(null);

  const latest = useRef(0);
  const load = () => {
    const request = ++latest.current;
    setError('');
    api.orders(search.trim(), page, source, status).then(
      (r) => request === latest.current && setResult(r),
      (e) => request === latest.current && setError(e.message),
    );
  };
  useEffect(() => {
    const to = openToPack.value;
    if (!to) return;
    openToPack.value = null;
    setTab('shop');
    setSource(to);
    setStatus('processing');
    setSearch('');
    setPage(1);
  }, [openToPack.value]);
  useEffect(() => {
    if (tab !== 'shop' || !online.value) return;
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [tab, search, source, status, page, online.value, queue.value.length]);

  return (
    <main class="orders">
      <div class="tabs">
        <button class={tab === 'shop' ? 'active' : ''} aria-pressed={tab === 'shop'} onClick={() => setTab('shop')}>
          Orders
        </button>
        <button class={tab === 'queue' ? 'active' : ''} aria-pressed={tab === 'queue'} onClick={() => setTab('queue')}>
          Not yet synced {queue.value.length > 0 && <span class={failedCount.value ? 'badge out' : 'badge'}>{queue.value.length}</span>}
        </button>
        {tab === 'queue' && queue.value.length > 0 && <button onClick={() => void flushQueue()}>Sync now</button>}
      </div>
      {tab === 'queue' ? (
        <Queued />
      ) : !online.value ? (
        <p class="muted">Order history needs a connection. Sales taken offline are under "Not yet synced".</p>
      ) : (
        <>
          <div class="search-bar">
            <input
              type="search"
              placeholder="Order number, name or email"
              value={search}
              onInput={(e) => {
                setSearch(e.currentTarget.value);
                setPage(1);
              }}
              aria-label="Search orders"
            />
            <select value={source} onChange={(e) => (setSource(e.currentTarget.value as typeof source), setPage(1))} aria-label="Source">
              <option value="pos">Till sales</option>
              <option value="later">Collect or deliver</option>
              <option value="web">Web orders</option>
              <option value="all">All orders</option>
            </select>
            <select value={status} onChange={(e) => (setStatus(e.currentTarget.value), setPage(1))} aria-label="Status">
              <option value="">Any status</option>
              {Object.entries(STATUSES).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          {error && <p class="error">{error}</p>}
          {!result && !error && <Spinner />}
          <ul class="order-list">
            {result?.orders.map((o) => (
              <li key={o.id}>
                <button class="row-button grow" onClick={() => setOpen(o.id)}>
                  <strong>#{o.number}</strong>
                  <span class="muted">{when(o.date)}</span>
                  <span>{o.customer || 'Walk-in'}</span>
                  <span class="muted">
                    {o.item_count} item{o.item_count === 1 ? '' : 's'} · {o.payment}
                    {!o.pos && o.shipping_method && ` · ${o.shipping_method}`}
                    {o.fulfil && ` · ${o.fulfil === 'collect' ? 'To collect' : 'To deliver'}`}
                  </span>
                  <span class={`status ${o.status}`}>{o.status}</span>
                  <strong class="num">
                    {money(o.total)}
                    {o.refunded > 0 && <small class="error"> −{money(o.refunded)}</small>}
                  </strong>
                </button>
              </li>
            ))}
            {result && result.orders.length === 0 && <li class="muted">No orders found.</li>}
          </ul>
          {result && result.total_pages > 1 && (
            <div class="pager">
              <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Newer
              </button>
              <span>
                Page {page} of {result.total_pages}
              </span>
              <button disabled={page >= result.total_pages} onClick={() => setPage(page + 1)}>
                Older
              </button>
            </div>
          )}
        </>
      )}
      {open !== null && <OrderDetail id={open} onClose={() => (setOpen(null), load(), void pollToPack().catch(() => {}))} />}
    </main>
  );
}
