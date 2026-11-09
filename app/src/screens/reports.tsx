import { useEffect, useState } from 'preact/hooks';
import { api, NetworkError, type CashMove, type DrawerClose, type Summary } from '../api';
import { toCsv } from '../csv';
import { money, parseAmount, round } from '../money';
import { boot, failedCount, online, pendingCount, register } from '../state';
import { shopDay, shopTime } from '../time';
import { shopNow } from '../sync';
import { requestIds, Spinner } from '../ui';

const today = () => shopDay(shopNow());

function download(d: Summary, scope: string) {
  const t = d.totals;
  const rows: (string | number)[][] = [
    ['ShopTill report', d.date, scope],
    [],
    ['Transactions', t.orders],
    ['Items', t.items],
    ['Gross', t.gross],
    ['Refunds', t.refunds],
    ['Net', t.net],
    ['Tax collected', t.tax],
    ['Discounts given', t.discounts],
    ['Still owed', t.owed],
    ['Paid off earlier sales', t.repaid],
    ['Refunds on web orders', t.web_refunds],
    ['Delivery charges', t.shipping],
    ['Tips', t.tips ?? 0],
    ['Cash paid in', t.paid_in],
    ['Cash paid out', t.paid_out],
  ];
  // Costs and profit are for staff only; a cashier's report has none of them.
  if (t.cost !== undefined) {
    rows.push(['Cost of goods', t.cost], ['Profit', t.profit!], ['Sold without a cost', t.uncosted!]);
  }
  rows.push(
    [],
    ['Payment method', 'Sales', 'Refunds', 'Net'],
    ...d.by_method.map((m) => [m.label, m.sales, m.refunds, round(m.sales - m.refunds)]),
    [],
    d.by_product.some((p) => p.cost !== undefined)
      ? ['Product', 'SKU', 'Sold', 'Returned', 'Sales', 'Cost']
      : ['Product', 'SKU', 'Sold', 'Sales'],
    ...d.by_product.map((p) => {
      if (p.cost === undefined) return [p.name, p.sku, p.qty, p.sales];
      // The row's cost is net of returns, like the day's totals; its sales stay gross like its sold count.
      const known = (p.cost ?? 0) > 0 || !p.uncosted;
      return [p.name, p.sku, p.qty, p.refunded, p.sales, known ? (p.cost ?? 0) : ''];
    }),
    [],
    ['Cashier', 'Transactions', 'Sales'],
    ...d.by_cashier.map((c) => [c.name, c.orders, c.sales]),
    [],
    ['Cash in or out', 'Amount', 'Register', 'By', 'At', 'Note'],
    ...d.cash_moves.map((m) => [m.reason, m.amount, registerName(m.register_id), m.cashier_name, time(m.at), m.after_close ? 'After the drawer was counted' : '']),
    [],
    ['Drawer closed', 'Counted', 'Expected', 'Float', 'Difference', 'By', 'At'],
    ...d.closes.map((c) => [registerName(c.register_id), c.counted, c.expected, c.float, c.difference, c.cashier_name, time(c.at)]),
  );
  const a = document.createElement('a');
  // The byte order mark is how Excel knows the file is UTF-8 rather than mangling accented names.
  a.href = URL.createObjectURL(new Blob(['\uFEFF', toCsv(rows)], { type: 'text/csv' }));
  a.download = `shoptill-${d.date}-${scope.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.csv`;
  a.click();
  // Safari starts the download after click returns, so the URL has to outlive it.
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** A table of names against a count and sales, left out when there is nothing in it. */
function Breakdown({
  head,
  rows,
  withCost = false,
}: {
  head: [string, string];
  rows: { key: string | number; name: string; count: number; refunded?: number; sales: number; cost?: number | null; uncosted?: boolean }[];
  withCost?: boolean;
}) {
  if (!rows.length) return null;
  return (
    <table>
      <thead>
        <tr>
          <th>{head[0]}</th>
          <th class="num">{head[1]}</th>
          <th class="num">Sales</th>
          {withCost && <th class="num">Cost</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          // A dash when nothing the shop sold of it ever had a cost; a number, even if other lines didn't.
          const known = (r.cost ?? 0) > 0 || !r.uncosted;
          return (
            <tr key={r.key}>
              <td>{r.name}</td>
              <td class="num">{r.refunded ? `${r.count} (−${r.refunded})` : r.count}</td>
              <td class="num">{money(r.sales)}</td>
              {withCost && <td class="num">{known ? money(r.cost ?? 0) : '—'}</td>}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const registerName = (id: string) => boot.value?.registers.find((r) => r.id === id)?.name ?? id;
const time = (at: number) => shopTime(at);

function CloseLine({ c }: { c: DrawerClose }) {
  const off = Math.abs(c.difference) >= 0.005;
  return (
    <p>
      {registerName(c.register_id)}: {money(c.counted)} counted against {money(c.expected)} expected, {money(c.float)} of it float, by {c.cashier_name} at{' '}
      {time(c.at)}.{' '}
      <strong class={off ? 'error' : ''}>{!off ? 'Balanced.' : c.difference > 0 ? `Over by ${money(c.difference)}.` : `Short by ${money(-c.difference)}.`}</strong>
    </p>
  );
}

function MoveLine({ m }: { m: CashMove }) {
  return (
    <p>
      {registerName(m.register_id)}: {m.amount < 0 ? `${money(-m.amount)} paid out` : `${money(m.amount)} paid in`} for {m.reason}, by {m.cashier_name} at{' '}
      {time(m.at)}
      {m.after_close && <span class="warn"> — after the drawer was counted, so count again to include it</span>}.
    </p>
  );
}

/** Sends something recorded against the drawer, once however often it is retried. */
function useDrawerEntry<B extends { request_id: string }>(scope: string, post: (body: B) => Promise<unknown>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requests = requestIds(scope);
  const send = async (body: Omit<B, 'request_id'>) => {
    setBusy(true);
    setError('');
    try {
      const id = requests.id(body);
      await post({ ...body, request_id: id } as B);
      requests.answered(id);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, send };
}

/** Counting the drawer at close. The shop works out what should be in it from the day's cash. */
function DrawerCount(props: { date: string; float: string; setFloat: (v: string) => void; counted: string; setCounted: (v: string) => void; onSaved: () => void }) {
  const { date, float, setFloat, counted, setCounted, onSaved } = props;
  const entry = useDrawerEntry(`close ${date}`, api.closeDrawer);
  const value = parseAmount(counted);
  const save = async (e: Event) => {
    e.preventDefault();
    const amounts = { float: parseAmount(float), counted: value };
    if (Number.isNaN(amounts.float + amounts.counted)) return entry.setError('That is not a number.');
    if (await entry.send({ date, register_id: register.value!.id, ...amounts })) {
      setCounted('');
      onSaved();
    }
  };
  return (
    <form class="search-bar drawer-count" onSubmit={save}>
      <input inputMode="decimal" value={float} onInput={(e) => setFloat(e.currentTarget.value)} placeholder="Opening float" aria-label="Opening float" />
      <input inputMode="decimal" value={counted} onInput={(e) => setCounted(e.currentTarget.value)} placeholder="Cash counted" aria-label="Cash counted" required />
      <button class="primary" disabled={entry.busy || !counted.trim()}>
        {entry.busy ? <Spinner /> : Number.isNaN(value) || !counted.trim() ? 'Close drawer' : `Close drawer with ${money(value)}`}
      </button>
      {entry.error && <span class="error">{entry.error}</span>}
    </form>
  );
}

/** Cash put in or taken out of the drawer outside a sale, so the count at close still balances. */
function CashMoveForm({ date, onSaved }: { date: string; onSaved: () => void }) {
  const [out, setOut] = useState(true);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const entry = useDrawerEntry(`cash ${register.value!.id}`, api.moveCash);
  const value = round(parseAmount(amount));
  const save = async (e: Event) => {
    e.preventDefault();
    if (!(value > 0)) return entry.setError('Enter the cash as an amount.');
    if (await entry.send({ date, register_id: register.value!.id, amount: out ? -value : value, reason: reason.trim() })) {
      setAmount('');
      setReason('');
      onSaved();
    }
  };
  return (
    <form class="search-bar drawer-count" onSubmit={save}>
      <select value={out ? 'out' : 'in'} onChange={(e) => setOut(e.currentTarget.value === 'out')} aria-label="Cash in or out">
        <option value="out">Paid out</option>
        <option value="in">Paid in</option>
      </select>
      <input inputMode="decimal" value={amount} onInput={(e) => setAmount(e.currentTarget.value)} placeholder="Amount" aria-label="Cash amount" required />
      <input value={reason} onInput={(e) => setReason(e.currentTarget.value)} placeholder="What for" aria-label="What the cash was for" required />
      <button disabled={entry.busy || !amount.trim() || !reason.trim()}>{entry.busy ? <Spinner /> : value > 0 ? `Record ${money(value)}` : 'Record'}</button>
      {entry.error && <span class="error">{entry.error}</span>}
    </form>
  );
}

/** End-of-day takings, the numbers a cashier counts the drawer against. */
export function Reports() {
  const [date, setDate] = useState(today());
  const [scope, setScope] = useState<'register' | 'all'>('register');
  const [data, setData] = useState<Summary | null>(null);
  // Here rather than in the count form, which unmounts while a recount reloads the numbers or the connection drops.
  const [float, setFloat] = useState('');
  const [counted, setCounted] = useState('');
  // Refused sales are missing from the numbers too, until someone retries or discards them.
  const unsent = pendingCount.value + failedCount.value;
  const [error, setError] = useState('');
  const [loads, setLoads] = useState(0);

  // A reload after a count keeps the old numbers up, so the forms and what was typed in them stay.
  useEffect(() => setData(null), [date, scope]);
  useEffect(() => {
    if (!online.value) return;
    let current = true;
    setError('');
    api.summary(date, scope === 'register' ? (register.value?.id ?? '') : '').then(
      (d) => current && setData(d),
      (e) => current && setError(e instanceof NetworkError ? 'Reports need a connection.' : e.message),
    );
    return () => {
      current = false;
    };
  }, [date, scope, online.value, loads]);

  if (!online.value) return <main class="reports"><p class="muted">Reports need a connection.</p></main>;

  const cash = data?.by_method.find((m) => m.method === 'cash');
  const moved = data ? data.totals.paid_in - data.totals.paid_out : 0;
  const scopeName = scope === 'register' ? (register.value?.name ?? '') : 'All registers';

  return (
    <main class="reports">
      <div class="search-bar">
        <input
          type="date"
          value={date}
          max={today()}
          onInput={(e) => {
            // max only marks a typed date invalid, and a drawer can't be closed for a day to come.
            const picked = e.currentTarget.value;
            setDate(picked > today() ? today() : picked);
            setFloat('');
            setCounted('');
          }}
          aria-label="Report date"
        />
        <div class="toggle">
          <button class={scope === 'register' ? 'active' : ''} aria-pressed={scope === 'register'} onClick={() => setScope('register')}>
            {register.value?.name ?? 'This register'}
          </button>
          <button class={scope === 'all' ? 'active' : ''} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
            All registers
          </button>
        </div>
        <button onClick={() => window.print()} disabled={!data}>
          Print
        </button>
        <button onClick={() => data && download(data, scopeName)} disabled={!data}>
          Download CSV
        </button>
      </div>
      {unsent > 0 && (
        <p class="warn">
          {unsent} sale{unsent === 1 ? '' : 's'} on this device {unsent === 1 ? "hasn't" : "haven't"} reached the shop yet, so {unsent === 1 ? "it isn't" : "they aren't"} in these numbers.
        </p>
      )}
      {error && <p class="error">{error}</p>}
      {!data && !error && <Spinner />}
      {data && (
        <div class="report printable">
          <h2>
            {boot.value?.store.store_name} · {data.date}
          </h2>
          <p class="muted">{scopeName}</p>
          <div class="stats">
            <div>
              <span>Transactions</span>
              <strong>{data.totals.orders}</strong>
            </div>
            <div>
              <span>Items</span>
              <strong>{data.totals.items}</strong>
            </div>
            <div>
              <span>Gross</span>
              <strong>{money(data.totals.gross)}</strong>
            </div>
            <div>
              <span>Refunds</span>
              <strong>{money(data.totals.refunds)}</strong>
            </div>
            <div>
              <span>Net</span>
              <strong>{money(data.totals.net)}</strong>
            </div>
            {data.totals.owed > 0 && (
              <div>
                <span>Still owed</span>
                <strong>{money(data.totals.owed)}</strong>
              </div>
            )}
            {data.totals.repaid > 0 && (
              <div>
                <span>Paid off earlier sales</span>
                <strong>{money(data.totals.repaid)}</strong>
              </div>
            )}
            {data.totals.web_refunds > 0 && (
              <div>
                <span>Refunds on web orders</span>
                <strong>{money(data.totals.web_refunds)}</strong>
              </div>
            )}
            {data.totals.shipping > 0 && (
              <div>
                <span>Delivery charges</span>
                <strong>{money(data.totals.shipping)}</strong>
              </div>
            )}
            {(data.totals.tips ?? 0) > 0 && (
              <div>
                <span>Tips</span>
                <strong>{money(data.totals.tips!)}</strong>
              </div>
            )}
            {data.totals.cost !== undefined && (
              <>
                <div>
                  <span>Cost of goods</span>
                  <strong>{money(data.totals.cost)}</strong>
                </div>
                <div>
                  <span>
                    Profit{data.totals.net > 0 && ` (${Math.round((data.totals.profit! / data.totals.net) * 100)}%)`}
                  </span>
                  <strong>{money(data.totals.profit!)}</strong>
                </div>
                {data.totals.uncosted! > 0.005 && (
                  <div>
                    <span>Sold without a cost</span>
                    <strong>{money(data.totals.uncosted!)}</strong>
                  </div>
                )}
              </>
            )}
            {data.totals.paid_in > 0 && (
              <div>
                <span>Cash paid in</span>
                <strong>{money(data.totals.paid_in)}</strong>
              </div>
            )}
            {data.totals.paid_out > 0 && (
              <div>
                <span>Cash paid out</span>
                <strong>{money(data.totals.paid_out)}</strong>
              </div>
            )}
          </div>
          <table>
            <thead>
              <tr>
                <th>Payment method</th>
                <th class="num">Sales</th>
                <th class="num">Refunds</th>
                <th class="num">Net</th>
              </tr>
            </thead>
            <tbody>
              {data.by_method.map((m) => (
                <tr key={m.method}>
                  <td>{m.label}</td>
                  <td class="num">{money(m.sales)}</td>
                  <td class="num">{money(m.refunds)}</td>
                  <td class="num">{money(m.sales - m.refunds)}</td>
                </tr>
              ))}
              {data.by_method.length === 0 && (
                <tr>
                  <td colSpan={4} class="muted">
                    No sales on this day.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td>Tax collected</td>
                <td class="num">{money(data.totals.tax)}</td>
                <td />
                <td />
              </tr>
              <tr>
                <td>Discounts given</td>
                <td class="num">{money(data.totals.discounts)}</td>
                <td />
                <td />
              </tr>
            </tfoot>
          </table>
          <Breakdown head={['Product', 'Sold']} withCost={data.by_product.some((p) => p.cost !== undefined)} rows={data.by_product.map((p) => ({ key: p.key, name: p.name, count: p.qty, refunded: p.refunded, sales: p.sales, cost: p.cost, uncosted: p.uncosted }))} />
          <Breakdown head={['Cashier', 'Transactions']} rows={data.by_cashier.map((c) => ({ key: c.id, name: c.name, count: c.orders, sales: c.sales }))} />
          {(cash || data.cash_moves.length > 0) && (
            <p>
              Cash expected in the drawer from sales{data.cash_moves.length > 0 && ' and cash paid in and out'}:{' '}
              <strong>{money((cash ? cash.sales - cash.refunds : 0) + moved)}</strong> (plus your opening float).
            </p>
          )}
          {data.cash_moves.map((m, i) => (
            <MoveLine key={i} m={m} />
          ))}
          {data.closes.map((c, i) => (
            <CloseLine key={i} c={c} />
          ))}
          {scope === 'register' && data.date === today() && <CashMoveForm date={data.date} onSaved={() => setLoads((n) => n + 1)} />}
          {scope === 'register' && (
            <DrawerCount date={data.date} float={float} setFloat={setFloat} counted={counted} setCounted={setCounted} onSaved={() => setLoads((n) => n + 1)} />
          )}
        </div>
      )}
    </main>
  );
}
