import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { api, config, type Order } from '../api';
import { listenForScans } from '../barcode';
import type { Receipt } from '../db';
import { kick, printReceipt as thermal, printer } from '../escpos';
import { money, round } from '../money';
import { sellCode } from '../selling';
import { boot, online, queue } from '../state';
import { shopDateTime } from '../time';
import { emailReceipt, retryQueued, synced } from '../sync';
import { Modal, Spinner } from '../ui';

const printing = signal<Receipt | null>(null);
let endPrint = () => {};
// A second tap while the first waits for the logo or a frame takes over, so one dialog opens.
let latest = {};

/** The thermal printer prints the same heading and footer as the paper one. */
const receiptStore = () => ({
  name: config.shopName,
  address: boot.value?.store.address,
  footer: boot.value?.store.footer || undefined,
});

export async function printReceipt(r: Receipt) {
  endPrint();
  const me = {};
  latest = me;
  // The receipt only renders for printing, too late for a logo that isn't loaded yet.
  const logo = boot.value?.store.logo;
  if (logo) await Promise.race([Object.assign(new Image(), { src: logo }).decode().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
  if (latest !== me) return;
  printing.value = r;
  const page = document.createElement('style');
  // A roll printer's driver knows its paper length; only its margins are ours to set.
  page.textContent = boot.value?.store.width === 'a4' ? '@page { size: A4; margin: 15mm; }' : '@page { margin: 0; }';
  document.head.append(page);
  document.documentElement.classList.add('printing-receipt');
  // Put away once the dialog closes: print() returns at once on phones and tablets, before the page is taken.
  const done = () => {
    window.removeEventListener('afterprint', done);
    page.remove();
    if (endPrint !== done) return;
    printing.value = null;
    document.documentElement.classList.remove('printing-receipt');
    endPrint = () => {};
  };
  endPrint = done;
  window.addEventListener('afterprint', done);
  // Let Preact render the receipt before the print dialog snapshots the page.
  requestAnimationFrame(() => requestAnimationFrame(() => latest === me && window.print()));
}

/** A gift receipt for a server order, leaving out what has been refunded since. */
export function giftFromOrder(o: Order): Receipt {
  const r = receiptFromOrder(o);
  const lines = r.lines.map((l, i) => ({ ...l, qty: l.qty - o.items[i].qty_refunded })).filter((l) => l.qty > 0);
  return { ...r, lines, gift: true };
}

/** Receipt data from a server order, for reprints from order history. */
export function receiptFromOrder(o: Order): Receipt {
  const inclusive = o.prices_include_tax;
  return {
    client_id: o.client_id,
    number: o.number,
    date: (o.date ?? Date.now() / 1000) * 1000,
    lines: o.items.map((i) => {
      const total = inclusive ? i.total + i.total_tax : i.total;
      const before = inclusive ? i.subtotal + i.subtotal_tax : i.subtotal;
      return {
        name: i.name,
        qty: i.qty,
        unit: i.qty ? before / i.qty : 0,
        total,
        discount: Math.max(0, before - total),
        sku: i.sku,
        meta: i.meta.map((m) => `${m.key}: ${m.value}`).join(', '),
      };
    }),
    subtotal: inclusive ? o.items.reduce((s, i) => s + i.subtotal + i.subtotal_tax, 0) : o.subtotal,
    discount: inclusive ? o.discount_total + o.discount_tax : o.discount_total,
    coupons: o.coupons,
    taxes: o.taxes,
    tax: o.total_tax,
    total: o.total,
    fees: o.fees?.map((f) => ({ label: f.name, amount: round(f.total + (inclusive ? f.total_tax : 0)) })),
    prices_include_tax: inclusive,
    payments: o.payments.map((p) => ({ ...p, label: p.label ?? p.method })),
    customer: o.customer,
    email: o.email,
    note: o.note,
    fulfil: o.fulfil ? { how: o.fulfil, to: o.shipping_address } : undefined,
    delivery:
      o.shipping_total > 0
        ? { label: o.shipping_method || 'Delivery', amount: inclusive ? o.shipping_total + o.shipping_tax : o.shipping_total }
        : undefined,
    register: o.register?.name ?? '',
    cashier: o.cashier_name ?? '',
    refunded: o.refunded,
    owed: o.owed,
    copy: true,
  };
}

export function ReceiptView({ r }: { r: Receipt }) {
  const store = boot.value?.store;
  const number = r.number ?? synced.value[r.client_id]?.number ?? null;
  return (
    <div class={`receipt w${store?.width ?? '80'}`}>
      {store?.logo && <img class="logo" src={store.logo} alt="" />}
      <h3>{store?.store_name ?? config.shopName}</h3>
      {r.gift ? <div class="copy">Gift receipt</div> : r.copy && <div class="copy">Copy</div>}
      {store?.address.map((a) => <div key={a}>{a}</div>)}
      {store?.phone && <div>{store.phone}</div>}
      {store?.header && <div class="pre">{store.header}</div>}
      {store?.tax_number && <div>Tax no. {store.tax_number}</div>}
      <hr />
      <div class="row">
        <span>{number ? `Order #${number}` : 'Order pending sync'}</span>
        <span>{shopDateTime(r.date / 1000)}</span>
      </div>
      {r.register && <div>Register: {r.register}</div>}
      {r.cashier && <div>Served by: {r.cashier}</div>}
      {r.customer && !r.gift && <div>Customer: {r.customer}</div>}
      {r.fulfil && !r.gift && <div class="pre">{r.fulfil.how === 'collect' ? 'To collect' : ['Deliver to', ...r.fulfil.to].join('\n')}</div>}
      <hr />
      {r.lines.map((l, i) => (
        <div class="item" key={i}>
          <div class="row">
            <span>
              {l.qty} × {l.name}
            </span>
            {!r.gift && <span>{money(l.total + l.discount)}</span>}
          </div>
          {(l.meta || (store?.show_sku && l.sku)) && <div class="sub">{[l.meta, store?.show_sku ? l.sku : ''].filter(Boolean).join(' · ')}</div>}
          {l.qty > 1 && !r.gift && <div class="sub">@ {money(l.unit)}</div>}
          {l.discount > 0.001 && !r.gift && <div class="sub">Discount −{money(l.discount)}</div>}
        </div>
      ))}
      {!r.gift && <Takings r={r} />}
      {store?.footer && (
        <>
          <hr />
          <div class="pre center">{store.footer}</div>
        </>
      )}
    </div>
  );
}

/** Everything on a receipt about money, which a gift receipt leaves out. */
function Takings({ r }: { r: Receipt }) {
  return (
    <>
      <hr />
      <div class="row">
        <span>Subtotal</span>
        <span>{money(r.subtotal)}</span>
      </div>
      {r.discount > 0.001 && (
        <div class="row">
          <span>Discount{r.coupons.length ? ` (${r.coupons.map((c) => c.code).join(', ')})` : ''}</span>
          <span>−{money(r.discount)}</span>
        </div>
      )}
      {r.delivery && (
        <div class="row">
          <span>{r.delivery.label}</span>
          <span>{money(r.delivery.amount)}</span>
        </div>
      )}
      {r.fees?.map((f, i) => (
        <div class="row" key={i}>
          <span>{f.label}</span>
          <span>{money(f.amount)}</span>
        </div>
      ))}
      {!r.prices_include_tax &&
        r.taxes.map((t, i) => (
          <div class="row" key={i}>
            <span>{t.label}</span>
            <span>{money(t.amount)}</span>
          </div>
        ))}
      <div class="row total">
        <span>Total</span>
        <span>{money(r.total)}</span>
      </div>
      {r.prices_include_tax &&
        r.taxes.map((t, i) => (
          <div class="row sub" key={i}>
            <span>Includes {t.label}</span>
            <span>{money(t.amount)}</span>
          </div>
        ))}
      <hr />
      {r.payments.map((p, i) => (
        <div key={i}>
          <div class="row">
            <span>{p.label}</span>
            <span>{money(p.tendered ?? p.amount)}</span>
          </div>
          {p.change !== undefined && p.change > 0 && (
            <div class="row">
              <span>Change</span>
              <span>{money(p.change)}</span>
            </div>
          )}
        </div>
      ))}
      {(r.owed ?? 0) > 0 && (
        <div class="row">
          <span>To pay later</span>
          <span>{money(r.owed!)}</span>
        </div>
      )}
      {r.refunded > 0 && (
        <div class="row">
          <span>Refunded</span>
          <span>−{money(r.refunded)}</span>
        </div>
      )}
      {r.note && <div class="pre note">{r.note}</div>}
    </>
  );
}

/** Rendered once at the app root; only visible to the printer. */
export function PrintRoot() {
  return <div id="print-root">{printing.value && <ReceiptView r={printing.value} />}</div>;
}

/** Emails a synced order's receipt, or with `clientId` a sale still waiting to sync, which goes once it does. */
export function EmailReceipt({ orderId, clientId, initial, onClose }: { orderId: number | null; clientId?: string; initial: string; onClose: () => void }) {
  const [email, setEmail] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState('');
  const send = async (e: Event) => {
    e.preventDefault();
    const to = email.trim();
    if (!orderId && !clientId) return;
    setBusy(true);
    setMessage('');
    try {
      if (orderId) await api.email(orderId, to);
      const now = orderId ? true : await emailReceipt(clientId!, to);
      setMessage(now ? `Sent to ${to}.` : `It goes to ${to} as soon as the sale reaches the shop.`);
      setSent(true);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Email receipt" onClose={onClose}>
      <form class="form" onSubmit={send}>
        <input type="email" value={email} onInput={(e) => setEmail(e.currentTarget.value)} placeholder="customer@example.com" required autofocus aria-label="Email" />
        {orderId && !online.value && <p class="muted">Emailing needs a connection.</p>}
        {message && <p>{message}</p>}
        {sent ? (
          <button type="button" class="primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <button class="primary" disabled={busy || (orderId ? !online.value : !clientId)}>
            {busy ? <Spinner /> : 'Send'}
          </button>
        )}
      </form>
    </Modal>
  );
}

function SaveStatus({ clientId }: { clientId: string }) {
  const saved = synced.value[clientId];
  const queued = queue.value.find((q) => q.client_id === clientId);
  if (saved) return <p class="muted">Saved as order #{saved.number}.</p>;
  if (queued?.status === 'failed') {
    return (
      <p class="error">
        The shop refused this sale: {queued.error}{' '}
        <button class="link" onClick={() => void retryQueued(clientId)}>
          Try again
        </button>
      </p>
    );
  }
  if (queued && !online.value) return <p class="muted">Offline. The sale is kept on this device and goes to the shop when the connection is back.</p>;
  if (queued?.error) return <p class="warn">Not saved to the shop yet ({queued.error}). The till keeps trying.</p>;
  if (queued) return <p class="muted">Saving to the shop…</p>;
  return <p class="muted">Saved.</p>;
}

/** Shown after a sale: change due, print, email, next sale. Scanning the next item starts the next sale. */
export function SaleDone({ receipt, change, onClose }: { receipt: Receipt; change: number; onClose: () => void }) {
  const [emailing, setEmailing] = useState(false);
  const orderId = synced.value[receipt.client_id]?.id ?? null;
  useEffect(
    () =>
      listenForScans((code) => {
        if (document.querySelectorAll('.modal').length > 1) return;
        onClose();
        sellCode(code);
      }),
    [],
  );
  // A thermal printer answers instantly and kicks the drawer on cash sales;
  // without one the browser's print dialog takes over, as it always did.
  const print = async () => {
    if (printer.connected.value && (await thermal(receipt, receiptStore()))) return;
    void printReceipt(receipt);
  };
  return (
    <Modal
      title="Sale complete"
      onClose={onClose}
      wide
      footer={
        <>
          <button onClick={() => void print()}>{printer.connected.value ? 'Print' : 'Print receipt'}</button>
          <button onClick={() => printReceipt({ ...receipt, gift: true })}>Gift receipt</button>
          <button onClick={() => setEmailing(true)}>Email receipt</button>
          <button class="primary" onClick={onClose} autofocus>
            New sale
          </button>
        </>
      }
    >
      <div class="sale-done">
        {change > 0 ? (
          <p class="change">
            Change <strong>{money(change)}</strong>
          </p>
        ) : (receipt.owed ?? 0) > 0 ? (
          <p class="change">
            To pay later <strong>{money(receipt.owed!)}</strong>
          </p>
        ) : (
          <p class="change">
            Paid <strong>{money(receipt.total)}</strong>
          </p>
        )}
        <SaveStatus clientId={receipt.client_id} />
        <div class="receipt-preview">
          <ReceiptView r={receipt} />
        </div>
      </div>
      {emailing && <EmailReceipt orderId={orderId} clientId={receipt.client_id} initial={receipt.email} onClose={() => setEmailing(false)} />}
    </Modal>
  );
}
