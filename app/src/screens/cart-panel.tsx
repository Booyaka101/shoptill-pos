import { Fragment } from 'preact';
import { signal } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, ApiError } from '../api';
import { couponKey, effectiveDiscounts, emptyCart, totals, uid, wireLines, type Cart, type CartLine } from '../cart';
import { db, getKv, setKv, type ParkedCart } from '../db';
import { decimals, money, parseAmount, round } from '../money';
import { room } from '../selling';
import { boot, cart, cartTotals, checkingOut, notify, online, products } from '../state';
import { Modal, Stepper } from '../ui';
import { Checkout } from './checkout';
import { AddressFields, addressLines, CustomerPicker, shipToFor } from './customer';
import { ProductEditor } from './product-editor';

const update = (fn: (c: Cart) => Cart) => (cart.value = fn(cart.value));

function setLine(key: string, patch: Partial<CartLine> | null) {
  update((c) => ({
    ...c,
    lines: patch === null ? c.lines.filter((l) => l.key !== key) : c.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)),
  }));
}

function LineEditor({ line, onClose }: { line: CartLine; onClose: () => void }) {
  const [qty, setQty] = useState(String(line.qty));
  const [price, setPrice] = useState(String(line.price));
  const [discount, setDiscount] = useState(line.discount ? String(line.discount) : '');
  const [percent, setPercent] = useState(false);
  const [editing, setEditing] = useState(false);
  const product = line.productId ? products.value.get(line.productId) : undefined;
  if (editing && product) return <ProductEditor product={product} onClose={onClose} />;

  // The line's total answers as the numbers are typed, not after Save. Blank fields keep
  // what was there, exactly as saving does; a mistype shows nothing rather than a guess.
  const preview = useMemo(() => {
    const num = (s: string, fallback: number) => (s.trim() ? parseAmount(s) : fallback);
    const q = num(qty, line.qty);
    const p = num(price, line.price);
    const raw = num(discount, 0);
    if ([q, p, raw].some(Number.isNaN)) return null;
    const whole = Math.max(0, Number.isInteger(line.qty) ? Math.floor(q) : q);
    const gross = Math.max(0, p) * whole;
    const d = Math.min(gross, percent ? (gross * Math.min(Math.max(raw, 0), 100)) / 100 : Math.max(raw, 0));
    return Math.max(0, gross - d);
  }, [qty, price, discount, percent]);

  // Removed with the sale still on screen: the line goes, and a moment of Undo puts it back where it was.
  const removeLine = () => {
    const index = cart.value.lines.findIndex((l) => l.key === line.key);
    setLine(line.key, null);
    notify(`${line.name} removed.`, 'info', () => {
      if (cart.value.lines.some((l) => l.key === line.key)) return;
      update((c) => ({ ...c, lines: [...c.lines.slice(0, index), line, ...c.lines.slice(index)] }));
    });
    onClose();
  };

  const save = () => {
    const typed = [qty, price, discount].map(parseAmount);
    if (typed.some(Number.isNaN)) return notify('That is not a number.', 'error');
    // Blank input keeps what was there rather than zeroing the line.
    // A weighed line keeps its fraction of a kilo; whole lines stay whole.
    let q = qty.trim() ? Math.max(0, Number.isInteger(line.qty) ? Math.floor(typed[0]) : typed[0]) : line.qty;
    const most = product ? room(product, cart.value.lines, line.key) : Infinity;
    // Stock caps raising a line, never lowering it.
    if (q > line.qty && q > most) {
      notify(product?.sold_individually ? `${line.name} is sold one at a time.` : `Only ${most} ${line.name} in stock.`, 'error');
      q = Math.max(most, line.qty);
    }
    if (!q) {
      removeLine();
      return;
    }
    const p = price.trim() ? Math.max(0, typed[1]) : line.price;
    const raw = Math.max(0, typed[2]);
    const gross = p * q;
    const d = Math.min(gross, percent ? (gross * Math.min(raw, 100)) / 100 : raw);
    setLine(line.key, { qty: q, price: p, discount: Math.round(d * 10 ** decimals()) / 10 ** decimals() });
    onClose();
  };

  return (
    <Modal
      title={line.name}
      onClose={onClose}
      footer={
        <>
          <button class="danger" onClick={removeLine}>
            Remove
          </button>
          {product && boot.value?.user.can_edit && online.value && <button onClick={() => setEditing(true)}>Edit product</button>}
          <button class="primary" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <form
        class="form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label for="line-qty">
          Quantity
          <Stepper value={parseFloat(qty) || 0} onChange={(n) => setQty(String(n))} less="One fewer" more="One more">
            <input id="line-qty" aria-label="Quantity" inputMode="decimal" value={qty} onInput={(e) => setQty(e.currentTarget.value)} onFocus={(e) => e.currentTarget.select()} autofocus />
          </Stepper>
        </label>
        {(boot.value?.may_change_prices ?? true) && (
          <label>
            Unit price{line.listPrice !== null && line.price !== line.listPrice && <span class="muted"> (list {money(line.listPrice)})</span>}
            <input inputMode="decimal" value={price} onInput={(e) => setPrice(e.currentTarget.value)} />
          </label>
        )}
        {(boot.value?.may_change_prices ?? true) && (
          <label>
            Discount on this line
            <div class="inline">
              <input inputMode="decimal" value={discount} onInput={(e) => setDiscount(e.currentTarget.value)} placeholder="0" />
              <div class="toggle">
                <button type="button" class={percent ? '' : 'active'} aria-pressed={!percent} onClick={() => setPercent(false)}>
                  {boot.value?.currency.symbol}
                </button>
                <button type="button" class={percent ? 'active' : ''} aria-pressed={percent} onClick={() => setPercent(true)}>
                  %
                </button>
              </div>
            </div>
          </label>
        )}
        <p class="muted small" style="margin:0">
          Line total <strong class="num">{preview === null ? '—' : money(preview)}</strong>
        </p>
        <button hidden />
      </form>
    </Modal>
  );
}

/** A custom item this device has rung up before, offered again as a one-tap chip. */
interface SavedCustom {
  name: string;
  price: number;
  qty: number;
  taxClass: string;
}

function CustomItem({ onClose }: { onClose: () => void }) {
  const classes = boot.value?.tax.classes ?? { '': 'Standard' };
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState('1');
  const [taxClass, setTaxClass] = useState('');
  const [again, setAgain] = useState<SavedCustom[]>([]);
  // The last few custom items, this device's own: the shop that sells the same
  // bespoke thing all day shouldn't keep typing it.
  useEffect(() => {
    void getKv<SavedCustom[]>('customItems').then((list) => Array.isArray(list) && setAgain(list.slice(0, 8)));
  }, []);
  const remember = (c: SavedCustom) => {
    const list = [c, ...again.filter((x) => x.name.toLowerCase() !== c.name.toLowerCase() || x.price !== c.price)].slice(0, 8);
    setAgain(list);
    void setKv('customItems', list);
  };
  const put = (line: CartLine) => update((c) => ({ ...c, lines: [...c.lines, line] }));
  const add = (e: Event) => {
    e.preventDefault();
    const p = parseAmount(price);
    if (!name.trim()) return;
    if (!(p > 0)) return notify('Give the item a price.', 'error');
    const item: SavedCustom = { name: name.trim(), price: p, qty: Math.max(1, Math.floor(Number(qty)) || 1), taxClass };
    put({ key: uid(), productId: null, name: item.name, sku: '', price: p, listPrice: null, qty: item.qty, taxable: true, taxClass, discount: 0, meta: '' });
    remember(item);
    onClose();
  };
  const addAgain = (c: SavedCustom) => {
    put({ key: uid(), productId: null, name: c.name, sku: '', price: c.price, listPrice: null, qty: c.qty, taxable: true, taxClass: c.taxClass, discount: 0, meta: '' });
    remember(c);
    onClose();
  };
  return (
    <Modal title="Custom item" onClose={onClose}>
      {again.length > 0 && (
        <div class="quick">
          {again.map((c) => (
            <button type="button" key={`${c.name}|${c.price}`} aria-label={`Add ${c.name} again`} onClick={() => addAgain(c)}>
              {c.name} · {money(c.price)}
            </button>
          ))}
        </div>
      )}
      <form class="form" onSubmit={add}>
        <label>
          Description
          <input value={name} onInput={(e) => setName(e.currentTarget.value)} autofocus required />
        </label>
        <div class="inline">
          <label>
            Price
            <input inputMode="decimal" value={price} onInput={(e) => setPrice(e.currentTarget.value)} required />
          </label>
          <label>
            Qty
            <input inputMode="numeric" value={qty} onInput={(e) => setQty(e.currentTarget.value)} />
          </label>
        </div>
        {boot.value?.tax.enabled && (
          <label>
            Tax class
            <select value={taxClass} onChange={(e) => setTaxClass(e.currentTarget.value)}>
              {Object.entries(classes).map(([slug, label]) => (
                <option key={slug} value={slug}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
        <button class="primary">Add to sale</button>
      </form>
    </Modal>
  );
}

function CartDiscount({ onClose }: { onClose: () => void }) {
  const current = cart.value.cartDiscount;
  const [value, setValue] = useState(current ? String(current.value) : '');
  const [type, setType] = useState<'percent' | 'fixed'>(current?.type ?? 'percent');
  const apply = (e: Event) => {
    e.preventDefault();
    const v = Math.max(0, parseAmount(value));
    if (Number.isNaN(v)) return notify('That is not a number.', 'error');
    update((c) => ({ ...c, cartDiscount: v ? { type, value: type === 'percent' ? Math.min(v, 100) : v } : null }));
    onClose();
  };
  return (
    <Modal title="Discount the whole sale" onClose={onClose}>
      <form class="form" onSubmit={apply}>
        <div class="inline">
          <input inputMode="decimal" value={value} onInput={(e) => setValue(e.currentTarget.value)} autofocus aria-label="Discount" />
          <div class="toggle">
            <button type="button" class={type === 'percent' ? 'active' : ''} aria-pressed={type === 'percent'} onClick={() => setType('percent')}>
              %
            </button>
            <button type="button" class={type === 'fixed' ? 'active' : ''} aria-pressed={type === 'fixed'} onClick={() => setType('fixed')}>
              {boot.value?.currency.symbol}
            </button>
          </div>
        </div>
        <div class="quick">
          {[5, 10, 15, 20, 50].map((p) => (
            <button
              type="button"
              key={p}
              onClick={() => {
                update((c) => ({ ...c, cartDiscount: { type: 'percent', value: p } }));
                onClose();
              }}
            >
              {p}%
            </button>
          ))}
        </div>
        <button class="primary">Apply</button>
      </form>
    </Modal>
  );
}

function CouponEntry({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const apply = async (e: Event) => {
    e.preventDefault();
    const c = code.trim().toLowerCase();
    if (!c) return;
    const next = { ...cart.value, coupons: [...new Set([...cart.value.coupons, c])] };
    setBusy(true);
    setError('');
    try {
      cart.value = await withCouponPreview(next);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Coupon" onClose={onClose}>
      <form class="form" onSubmit={apply}>
        <input value={code} onInput={(e) => setCode(e.currentTarget.value)} placeholder="Coupon code" autofocus aria-label="Coupon code" data-scan />
        {!online.value && <p class="muted">Coupons are checked with the shop, so they need a connection.</p>}
        {error && <p class="error">{error}</p>}
        <button class="primary" disabled={busy || !online.value}>
          Apply coupon
        </button>
      </form>
    </Modal>
  );
}

let lastPreviewKey = '';

/** Asks WooCommerce what the cart's coupons take off each line. Throws the coupon's own error if it doesn't apply. */
async function withCouponPreview(c: Cart): Promise<Cart> {
  if (!c.coupons.length || !c.lines.length) return { ...c, couponDiscounts: {} };
  const res = await api.preview({
    lines: wireLines({ ...c, couponDiscounts: {}, cartDiscount: null }, decimals()).map(({ discount, ...l }: any) => l),
    coupons: c.coupons,
    customer_id: c.customer?.id ?? 0,
  });
  lastPreviewKey = couponKey(c);
  const couponDiscounts: Record<string, number> = {};
  c.lines.forEach((l, i) => (couponDiscounts[l.key] = res.lines[i]?.coupon_discount ?? 0));
  return { ...c, couponDiscounts };
}

/**
 * Keeps coupon amounts current as the cart changes. Offline, the last preview stands and the server settles it on sync.
 * Pending while the shop hasn't priced the cart as it is, so a total about to change can't be charged.
 */
function useCouponRefresh() {
  const key = couponKey(cart.value);
  const [stale, setStale] = useState(false);
  const [failed, setFailed] = useState('');
  useEffect(() => {
    if (!cart.value.coupons.length) {
      if (Object.keys(cart.value.couponDiscounts).length) update((c) => ({ ...c, couponDiscounts: {} }));
      setStale(false);
      return;
    }
    // Payments may already be taken against the total on screen.
    if (key === lastPreviewKey || checkingOut.value) return;
    if (!online.value) {
      setStale(true);
      return;
    }
    // A cart back in a shape that failed before is priced again, and pending until it is.
    setFailed('');
    let cancelled = false;
    const timer = setTimeout(async () => {
      const snapshot = cart.value;
      try {
        const refreshed = await withCouponPreview(snapshot);
        // Checkout opened or the connection went while it was asked, so it is asked again after.
        if (cancelled) return void (lastPreviewKey = '');
        // A discount or note edited meanwhile doesn't change what the coupons take off.
        if (couponKey(cart.value) === couponKey(snapshot)) update((c) => ({ ...c, couponDiscounts: refreshed.couponDiscounts }));
        setStale(false);
      } catch (e) {
        if (cancelled || couponKey(cart.value) !== couponKey(snapshot)) return;
        const code = e instanceof ApiError && e.code === 'shoptill_coupon' && typeof e.data.code === 'string' ? e.data.code : null;
        if (code) {
          notify(`Coupon removed: ${e instanceof Error ? e.message : code}`, 'error');
          update((c) => ({ ...c, coupons: c.coupons.filter((k) => k !== code), couponDiscounts: {} }));
        } else {
          setStale(true);
          setFailed(couponKey(snapshot));
        }
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, online.value, checkingOut.value]);
  const pending = cart.value.coupons.length > 0 && online.value && key !== lastPreviewKey && key !== failed;
  return { stale, pending };
}

const parkedCount = signal(0);
const countParked = async () => (parkedCount.value = await (await db()).count('parked'));

function Parked({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<ParkedCart[]>([]);
  const load = async () => {
    const all = await (await db()).getAll('parked');
    setList(all.sort((a, b) => b.parked_at - a.parked_at));
    parkedCount.value = all.length;
  };
  useEffect(() => void load(), []);
  const restoring = useRef(false);
  const restore = async (p: ParkedCart) => {
    if (restoring.current) return;
    restoring.current = true;
    try {
      // Another tab may have restored it already.
      if (!(await (await db()).get('parked', p.id))) {
        await load();
        return;
      }
      if (cart.value.lines.length) await park(cart.value);
      cart.value = p.cart as Cart;
      lastPreviewKey = '';
      // Saved as the open sale before it stops being a parked one, so a crash between can't lose it.
      await setKv('cart', p.cart);
      await (await db()).delete('parked', p.id);
      await countParked();
      onClose();
    } finally {
      restoring.current = false;
    }
  };
  return (
    <Modal title="Parked sales" onClose={onClose}>
      {list.length === 0 && <p class="muted">Nothing parked.</p>}
      {list.map((p) => (
        <div class="row-button" key={p.id}>
          <button class="link grow" onClick={() => restore(p)}>
            <strong>{p.label}</strong>
            <span class="muted"> {new Date(p.parked_at).toLocaleTimeString()}</span>
          </button>
          <strong>{money(totals(p.cart as Cart, boot.value!.tax).total)}</strong>
          <button
            class="icon"
            aria-label="Delete parked sale"
            onClick={async () => {
              if (!confirm(`Delete the parked sale for ${p.label}?`)) return;
              await (await db()).delete('parked', p.id);
              await load();
            }}
          >
            🗑
          </button>
        </div>
      ))}
    </Modal>
  );
}

async function park(c: Cart) {
  const items = c.lines.reduce((n, l) => n + l.qty, 0);
  const who = c.customer ? `${c.customer.first_name} ${c.customer.last_name}`.trim() || c.customer.email : 'Walk-in';
  await (await db()).put('parked', { id: uid(), label: `${who}, ${items} item${items === 1 ? '' : 's'}`, parked_at: Date.now(), cart: c });
  await countParked();
}

type Dialog = 'line' | 'custom' | 'discount' | 'coupon' | 'customer' | 'parked' | 'note' | 'fulfil' | 'checkout' | null;

/** Whether the cart sheet is pulled up on a phone. Left open across screens, like the sale itself. */
const sheetOpen = signal(false);

export function CartPanel() {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [editing, setEditing] = useState<CartLine | null>(null);
  const { stale, pending } = useCouponRefresh();
  const c = cart.value;
  const t = cartTotals.value;
  const inclusive = boot.value?.tax.prices_include_tax ?? false;
  const close = () => setDialog(null);
  const dp = decimals();
  const tabRef = useRef<HTMLButtonElement>(null);
  const totalRef = useRef<HTMLElement>(null);
  const lineOff = (l: CartLine) => l.discount + (c.couponDiscounts[l.key] ?? 0);
  const saleOff = c.cartDiscount ? effectiveDiscounts(c, dp).reduce((n, d, i) => n + d - c.lines[i].discount, 0) : 0;
  useEffect(() => void countParked(), []);
  // A dialog opened from the collapsed tab brings the sale up behind it.
  useEffect(() => {
    if (dialog) sheetOpen.value = true;
  }, [dialog]);

  const items = c.lines.reduce((n, l) => n + l.qty, 0);
  const canCharge = !!c.lines.length && !!t && !pending;

  // With the sheet closed on a phone, the count on the tab is the only sign a
  // tap landed; it pops so the cashier's eye catches it.
  const prevItems = useRef(items);
  useEffect(() => {
    if (items !== prevItems.current && tabRef.current) {
      tabRef.current.classList.remove('pop');
      void tabRef.current.offsetWidth; // restart the animation when it is already on
      tabRef.current.classList.add('pop');
    }
    prevItems.current = items;
  }, [items]);

  // The total answers too, on any layout: a price change or a discount shows it moved.
  const prevTotal = useRef(t?.total);
  useEffect(() => {
    if (t && t.total !== prevTotal.current && totalRef.current) {
      totalRef.current.classList.remove('pop');
      void totalRef.current.offsetWidth;
      totalRef.current.classList.add('pop');
    }
    prevTotal.current = t?.total;
  }, [t?.total]);

  // Cleared before the await, so a second tap finds nothing to park, and put back if it can't be saved.
  const parkCurrent = async () => {
    const sale = cart.value;
    if (!sale.lines.length) return;
    cart.value = emptyCart();
    try {
      await park(sale);
      notify('Sale parked.');
    } catch {
      if (!cart.value.lines.length) cart.value = sale;
      notify("Couldn't park the sale on this device.", 'error');
    }
  };

  // A parked sale can outlast the stock it was rung up against.
  const charge = () => {
    const short = c.lines.find((l) => {
      const p = l.productId ? products.value.get(l.productId) : undefined;
      return p && l.qty > room(p, c.lines, l.key);
    });
    if (short) notify(`Not enough ${short.name} in stock for this sale. Change the quantity first.`, 'error');
    else setDialog('checkout');
  };

  return (
    <aside class={sheetOpen.value ? 'cart open' : 'cart'} id="cart">
      {/* The phone's collapsed sheet: what the sale comes to, and charge without pulling it up. */}
      <div class="cart-tab">
        <button class="tab-info" ref={tabRef} aria-expanded={sheetOpen.value} aria-controls="cart" onClick={() => (sheetOpen.value = !sheetOpen.value)}>
          <strong>
            {items} item{items === 1 ? '' : 's'}
          </strong>
          <span class="grow">{t ? money(t.total) : ''}</span>
          <span class="chevron" aria-hidden="true">
            {sheetOpen.value ? '▾' : '▴'}
          </span>
        </button>
        <button class="tab-charge" disabled={!canCharge} onClick={charge}>
          {pending ? 'Checking coupons…' : 'Charge'}
        </button>
      </div>

      <div class="cart-head">
        <button class="customer-button" onClick={() => setDialog('customer')}>
          {c.customer ? `${c.customer.first_name} ${c.customer.last_name}`.trim() || c.customer.email : '+ Customer'}
        </button>
        <button class="link" onClick={() => setDialog('parked')}>
          Parked{parkedCount.value ? ` (${parkedCount.value})` : ''}
        </button>
      </div>

      <ul class="lines">
        {c.lines.map((l, i) => {
          const r = t?.lines[i];
          const photo = l.productId ? products.value.get(l.productId)?.image : undefined;
          return (
            <li key={l.key}>
              <button
                class="line"
                onClick={() => {
                  setEditing(l);
                  setDialog('line');
                }}
              >
                {photo && <img src={photo} alt="" loading="lazy" />}
                <span class="qty">{l.qty}×</span>
                <span class="desc">
                  {l.name}
                  {l.meta && <small>{l.meta}</small>}
                  {l.listPrice !== null && l.price !== l.listPrice && <small>Price changed from {money(l.listPrice)}</small>}
                  {lineOff(l) > 0 && <small class="saving">−{money(lineOff(l))}</small>}
                </span>
                <span class="amount">{r ? money(c.cartDiscount ? r.displaySubtotal - lineOff(l) : r.display) : ''}</span>
              </button>
            </li>
          );
        })}
        {c.lines.length === 0 && <li class="muted empty">Tap a product or scan a barcode.</li>}
      </ul>

      <div class="cart-tools">
        <button onClick={() => setDialog('custom')}>Custom item</button>
        <button onClick={() => setDialog('discount')} disabled={!c.lines.length || boot.value?.may_change_prices === false}>
          Discount
        </button>
        <button onClick={() => setDialog('coupon')} disabled={!c.lines.length}>
          Coupon
        </button>
        <button onClick={() => setDialog('note')}>Note</button>
        <button onClick={() => setDialog('fulfil')} disabled={!c.lines.length}>
          {!c.fulfil ? 'Collect or deliver' : c.fulfil.how === 'collect' ? 'To collect' : 'To deliver'}
        </button>
        <button onClick={parkCurrent} disabled={!c.lines.length}>
          Park
        </button>
        <button
          onClick={() => {
            // Cleared in one tap, with a moment to change your mind: safer than a confirm
            // in the way, faster for the sure-fingered.
            const sale = cart.value;
            cart.value = emptyCart();
            notify('Sale cleared.', 'info', () => {
              // Only an empty sale can be brought back, so a newer one is never overwritten.
              if (!cart.value.lines.length) cart.value = sale;
            });
          }}
          disabled={!c.lines.length && !c.customer && !c.note && !c.cartDiscount && !c.coupons.length && !c.fulfil}
        >
          Clear
        </button>
      </div>

      {t && c.lines.length > 0 && (
        <dl class="totals">
          <dt>Subtotal</dt>
          <dd>{money(t.displaySubtotal)}</dd>
          {c.coupons.map((code) => (
            <Fragment key={code}>
              <dt>
                Coupon <code>{code}</code>{' '}
                <button class="link small" onClick={() => update((x) => ({ ...x, coupons: x.coupons.filter((k) => k !== code) }))}>
                  remove
                </button>
              </dt>
              <dd />
            </Fragment>
          ))}
          {c.cartDiscount && (
            <>
              <dt>
                Sale discount {c.cartDiscount.type === 'percent' ? `${c.cartDiscount.value}%` : ''}{' '}
                <button class="link small" onClick={() => update((x) => ({ ...x, cartDiscount: null }))}>
                  remove
                </button>
              </dt>
              <dd>−{money(saleOff)}</dd>
            </>
          )}
          {t.displayDiscount > 0 && (!c.cartDiscount || c.lines.some((l) => lineOff(l) > 0)) && (
            <>
              <dt>{c.cartDiscount ? 'All discounts' : 'Discounts'}</dt>
              <dd>−{money(t.displayDiscount)}</dd>
            </>
          )}
          {t.shipping && (
            <>
              <dt>Delivery</dt>
              <dd>{money(t.shipping.display)}</dd>
            </>
          )}
          {t.taxLines.map((tax) => (
            <Fragment key={tax.id}>
              <dt class="muted tax-line">
                {inclusive ? `Includes ${tax.label}` : tax.label}
              </dt>
              <dd class="muted tax-line">{money(tax.amount)}</dd>
            </Fragment>
          ))}
          {t.taxLines.length > 0 && (
            <>
              <dt class="muted tax-sum">{inclusive ? 'Includes tax' : 'Tax'}</dt>
              <dd class="muted tax-sum">{money(t.tax)}</dd>
            </>
          )}
          <dt class="grand">Total</dt>
          <dd class="grand" ref={totalRef}>
            {money(t.total)}
          </dd>
        </dl>
      )}
      {stale && <p class="warn small">Coupon amounts will be confirmed when the sale syncs.</p>}
      {c.note && (
        <p class="muted small">
          {c.notePrivate ? 'Staff note' : 'Note'}: {c.note}
        </p>
      )}
      {c.fulfil && (
        <p class="muted small">
          {c.fulfil.how === 'collect'
            ? 'To be collected later.'
            : `To deliver to ${addressLines(c.fulfil.to).join(', ')}${c.fulfil.charge ? ` for ${money(c.fulfil.charge)}` : ''}.`}
        </p>
      )}

      <button class="primary charge" disabled={!c.lines.length || !t || pending} onClick={charge}>
        {pending ? 'Checking coupons…' : `Charge ${t ? money(t.total) : ''}`}
      </button>

      {dialog === 'line' && editing && <LineEditor line={editing} onClose={close} />}
      {dialog === 'custom' && <CustomItem onClose={close} />}
      {dialog === 'discount' && <CartDiscount onClose={close} />}
      {dialog === 'coupon' && <CouponEntry onClose={close} />}
      {dialog === 'customer' && <CustomerPicker onClose={close} />}
      {dialog === 'parked' && <Parked onClose={close} />}
      {dialog === 'note' && <NoteEditor onClose={close} />}
      {dialog === 'fulfil' && <FulfilEditor onClose={close} />}
      {dialog === 'checkout' && <Checkout onClose={close} />}
    </aside>
  );
}

function NoteEditor({ onClose }: { onClose: () => void }) {
  const [note, setNote] = useState(cart.value.note);
  const [staff, setStaff] = useState(!!cart.value.notePrivate);
  return (
    <Modal
      title="Order note"
      onClose={onClose}
      footer={
        <button
          class="primary"
          onClick={() => {
            update((c) => ({ ...c, note: note.trim(), notePrivate: staff || undefined }));
            onClose();
          }}
        >
          Save
        </button>
      }
    >
      <textarea rows={4} value={note} onInput={(e) => setNote(e.currentTarget.value)} autofocus aria-label="Order note" />
      <label class="check">
        <input type="checkbox" checked={staff} onChange={(e) => setStaff(e.currentTarget.checked)} /> Staff only, not on the receipt
      </label>
      <p class="muted small">{staff ? 'Saved with the order notes in WooCommerce, which the customer never sees.' : 'Saved on the order as the customer note and printed on the receipt.'}</p>
    </Modal>
  );
}

function FulfilEditor({ onClose }: { onClose: () => void }) {
  const current = cart.value.fulfil;
  const [how, setHow] = useState(current?.how ?? 'collect');
  const [to, setTo] = useState(current?.how === 'deliver' ? current.to : shipToFor(cart.value.customer));
  const [charge, setCharge] = useState(current?.how === 'deliver' && current.charge ? String(current.charge) : '');
  const field = (k: 'first_name' | 'last_name' | 'phone', title: string) => (
    <label>
      {title}
      <input type={k === 'phone' ? 'tel' : 'text'} value={to[k]} onInput={(e) => setTo({ ...to, [k]: e.currentTarget.value })} />
    </label>
  );
  const save = (e: Event) => {
    e.preventDefault();
    const amount = charge.trim() ? parseAmount(charge) : 0;
    if (Number.isNaN(amount) || amount < 0) return notify('The delivery charge is not a number.', 'error');
    update((c) => ({
      ...c,
      fulfil: how === 'collect' ? { how } : { how, to, ...(amount > 0 ? { charge: round(amount) } : {}) },
    }));
    onClose();
  };
  return (
    <Modal
      title="Collect or deliver later"
      onClose={onClose}
      footer={
        <>
          {current && (
            <button
              onClick={() => {
                update((c) => ({ ...c, fulfil: undefined }));
                onClose();
              }}
            >
              Taken now
            </button>
          )}
          <button class="primary" type="submit" form="fulfil">
            Save
          </button>
        </>
      }
    >
      <form id="fulfil" class="form" onSubmit={save}>
        <div class="toggle">
          <button type="button" class={how === 'collect' ? 'active' : ''} aria-pressed={how === 'collect'} onClick={() => setHow('collect')}>
            Collect
          </button>
          <button type="button" class={how === 'deliver' ? 'active' : ''} aria-pressed={how === 'deliver'} onClick={() => setHow('deliver')}>
            Deliver
          </button>
        </div>
        {how === 'deliver' && (
          <>
            <div class="inline">
              {field('first_name', 'First name')}
              {field('last_name', 'Last name')}
            </div>
            {field('phone', 'Phone')}
            <AddressFields value={to} onInput={(a) => setTo({ ...to, ...a })} countries={boot.value?.ship_countries} required />
            <label>
              Delivery charge
              <input inputMode="decimal" value={charge} onInput={(e) => setCharge(e.currentTarget.value)} placeholder="0" aria-label="Delivery charge" />
            </label>
          </>
        )}
        <p class="muted small">The sale waits under Orders, in Collect or deliver, until it is marked completed.</p>
      </form>
    </Modal>
  );
}
