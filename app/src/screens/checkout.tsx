import { useEffect, useRef, useState } from 'preact/hooks';
import { emptyCart, uid, wireLines } from '../cart';
import type { Receipt } from '../db';
import { kick, printer } from '../escpos';
import { decimals, money, quickCash, round } from '../money';
import { boot, cart, cartTotals, checkingOut, heldCart, notify, register } from '../state';
import { saleChime } from '../sound';
import { enqueue, shopNow } from '../sync';
import { amountToCents, centsToAmount, Keypad, Modal, Spinner } from '../ui';
import { addressLines } from './customer';
import { SaleDone } from './receipt';

interface Tender {
  method: string;
  label: string;
  amount: number;
  tendered?: number;
  change?: number;
  reference?: string;
}

export function Checkout({ onClose }: { onClose: () => void }) {
  const t = cartTotals.value!;
  const methods = Object.entries(boot.value?.payment_methods ?? {});
  const dp = decimals();
  const [payments, setPayments] = useState<Tender[]>([]);
  const [method, setMethod] = useState(methods[0]?.[0] ?? 'cash');
  const [reference, setReference] = useState('');
  const [tip, setTip] = useState(0);
  const showTips = !!boot.value?.tips && payments.length === 0;
  const tipTotal = round(t.total + tip);
  const paid = round(payments.reduce((s, p) => s + p.amount, 0));
  const remaining = round(tipTotal - paid);
  const [cents, setCents] = useState(amountToCents(tipTotal, dp));
  useEffect(() => {
    if (!payments.length) setCents(amountToCents(tipTotal, dp));
  }, [tipTotal]);
  const [done, setDone] = useState<{ receipt: Receipt; change: number } | null>(null);
  useEffect(() => {
    checkingOut.value = true;
    return () => {
      checkingOut.value = false;
    };
  }, []);
  // One id for the whole checkout, and one save: a second tap or a retry can never ring the sale up twice.
  const [clientId] = useState(uid);
  const finishing = useRef(false);
  const lastTake = useRef({ at: 0, method: '' });
  const [saving, setSaving] = useState(false);

  if (done) {
    return <SaleDone receipt={done.receipt} change={done.change} onClose={onClose} />;
  }

  const close = () => {
    if (finishing.current) return;
    if (payments.length && !confirm('Close without finishing the sale? The payments taken so far will be dropped, so refund any card payment on the terminal.')) return;
    onClose();
  };

  const suggest = (amount: number) => setCents(amountToCents(amount, dp));

  const finish = async (all: Tender[], payLater = false) => {
    const c = cart.value;
    if (finishing.current || !c.lines.length) return;
    // Another tab may have charged this sale already.
    if (heldCart.value) {
      const refund = all.length ? ' Give back the payments taken for it, and refund any card payment on the terminal.' : '';
      notify(`This sale was changed or finished on another tab, so it was not saved here.${refund} Check it before taking payment again.`, 'error');
      onClose();
      return;
    }
    finishing.current = true;
    setSaving(true);
    const b = boot.value!;
    const lines = wireLines(c, dp);
    const receipt: Receipt = {
      client_id: clientId,
      number: null,
      date: Date.now(),
      lines: c.lines.map((l, i) => ({
        name: l.name,
        qty: l.qty,
        unit: l.price,
        total: t.lines[i].display,
        discount: round(t.lines[i].displaySubtotal - t.lines[i].display),
        sku: l.sku,
        meta: l.meta,
      })),
      subtotal: t.displaySubtotal,
      discount: t.displayDiscount,
      coupons: c.coupons.map((code) => ({ code, discount: 0 })),
      taxes: t.taxLines.map((x) => ({ label: x.label, amount: x.amount })),
      tax: t.tax,
      total: tipTotal,
      fees: tip > 0 ? [{ label: 'Tip', amount: tip }] : undefined,
      prices_include_tax: b.tax.prices_include_tax,
      payments: all.map(({ method, label, amount, tendered, change }) => ({ method, label, amount, tendered, change })),
      customer: c.customer ? `${c.customer.first_name} ${c.customer.last_name}`.trim() || c.customer.email : '',
      email: c.customer?.email ?? '',
      note: c.notePrivate ? '' : c.note,
      fulfil: c.fulfil && { how: c.fulfil.how, to: c.fulfil.how === 'deliver' ? addressLines(c.fulfil.to) : [] },
      delivery: c.fulfil?.how === 'deliver' && c.fulfil.charge ? { label: 'Delivery', amount: c.fulfil.charge } : undefined,
      register: register.value?.name ?? '',
      cashier: b.user.name,
      refunded: 0,
      owed: payLater ? round(tipTotal - all.reduce((s, p) => s + p.amount, 0)) : 0,
    };
    try {
      await enqueue({
        client_id: clientId,
        status: 'pending',
        attempts: 0,
        created_at: Date.now(),
        receipt,
        payload: {
          client_id: clientId,
          register_id: register.value?.id,
          cashier_id: b.user.id,
          lines,
          coupons: c.coupons,
          customer_id: c.customer?.id ?? 0,
          note: c.note,
          note_private: c.notePrivate || undefined,
          fulfil: c.fulfil?.how,
          ship_to: c.fulfil?.how === 'deliver' ? c.fulfil.to : undefined,
          delivery_charge: c.fulfil?.how === 'deliver' && c.fulfil.charge ? c.fulfil.charge : undefined,
          payments: all.map(({ method, amount, tendered, reference }) => ({ method, amount, tendered, reference })),
          created_at: shopNow(),
          expected_total: tipTotal,
          pay_later: payLater || undefined,
          tip: tip > 0 ? tip : undefined,
        },
      });
    } catch (e) {
      finishing.current = false;
      setSaving(false);
      notify(`This device could not store the sale, so nothing was saved: ${e instanceof Error ? e.message : String(e)}`, 'error');
      return;
    }
    heldCart.value = null;
    cart.value = emptyCart();
    checkingOut.value = false;
    // Cash went into the drawer, so the drawer opens: the one POS sound every
    // shop knows. Only when a thermal printer is connected (the kick rides USB).
    if (printer.connected.value && all.some((p) => p.method === 'cash')) void kick();
    saleChime();
    setDone({ receipt, change: all.reduce((s, p) => s + (p.change ?? 0), 0) });
  };

  const take = (amount: number) => {
    if (finishing.current || remaining <= 0 || amount <= 0) return;
    // A double tap would land on the button already relabelled with what is left, and take it on the same method.
    if (lastTake.current.method === method && Date.now() - lastTake.current.at < 400) return;
    lastTake.current = { at: Date.now(), method };
    const label = boot.value?.payment_methods[method] ?? method;
    let tender: Tender;
    if (method === 'cash') {
      const applied = Math.min(amount, remaining);
      tender = { method, label, amount: applied, tendered: amount, change: round(amount - applied) };
    } else {
      tender = { method, label, amount: Math.min(amount, remaining), reference: reference.trim() || undefined };
    }
    const next = tender.amount > 0 ? [...payments, tender] : payments;
    const left = round(tipTotal - next.reduce((s, p) => s + p.amount, 0));
    setPayments(next);
    setReference('');
    if (left <= 0) void finish(next);
    else suggest(left);
  };

  const removePayment = (i: number) => {
    const next = payments.filter((_, j) => j !== i);
    setPayments(next);
    suggest(round(tipTotal - next.reduce((s, p) => s + p.amount, 0)));
  };

  const entered = centsToAmount(cents, dp);
  const overpayNonCash = method !== 'cash' && entered > remaining;

  if (saving) {
    return (
      <Modal title={`Charge ${money(tipTotal)}`} onClose={() => {}} wide>
        <p class="saving">
          <Spinner /> Saving the sale…
        </p>
      </Modal>
    );
  }

  return (
    <Modal title={`Charge ${money(tipTotal)}`} onClose={close} wide>
      <div class="checkout">
        <div class="checkout-left">
          {showTips && (
            <div class="tips">
              <p class="muted small" style="margin:0">Add a tip?</p>
              <div class="quick">
                <button class={tip === 0 ? 'active' : ''} aria-pressed={tip === 0} onClick={() => setTip(0)}>No tip</button>
                <button class={tip === round(t.total * 0.1) ? 'active' : ''} aria-pressed={tip === round(t.total * 0.1)} onClick={() => setTip(round(t.total * 0.1))}>10%</button>
                <button class={tip === round(t.total * 0.15) ? 'active' : ''} aria-pressed={tip === round(t.total * 0.15)} onClick={() => setTip(round(t.total * 0.15))}>15%</button>
                <button class={tip === round(t.total * 0.2) ? 'active' : ''} aria-pressed={tip === round(t.total * 0.2)} onClick={() => setTip(round(t.total * 0.2))}>20%</button>
              </div>
            </div>
          )}
          <div class="methods">
            {methods.map(([key, label]) => (
              <button key={key} class={method === key ? 'method active' : 'method'} aria-pressed={method === key} onClick={() => setMethod(key)}>
                {label}
              </button>
            ))}
          </div>
          <div class="due">
            <span>{payments.length ? 'Left to pay' : 'To pay'}</span>
            <strong>{money(remaining)}</strong>
          </div>
          {payments.length > 0 && (
            <ul class="tenders">
              {payments.map((p, i) => (
                <li key={i}>
                  <span>{p.label}</span>
                  <span>{money(p.amount)}</span>
                  <button class="link small" onClick={() => removePayment(i)} aria-label={`Remove ${p.label} payment of ${money(p.amount)}`}>
                    remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {remaining <= 0 ? null : method === 'cash' ? (
            <div class="quick">
              {quickCash(remaining).map((v) => (
                <button key={v} onClick={() => take(v)}>
                  {v === remaining ? 'Exact' : money(v)}
                </button>
              ))}
            </div>
          ) : (
            <input value={reference} onInput={(e) => setReference(e.currentTarget.value)} placeholder="Reference (optional)" aria-label="Payment reference" />
          )}
          {remaining <= 0 && (
            <p class="muted">Nothing left to pay.</p>
          )}
          {boot.value?.pay_later && cart.value.customer && remaining > 0 && (
            <button onClick={() => confirm(`Put ${money(remaining)} on ${cart.value.customer!.first_name || cart.value.customer!.email}'s account?`) && void finish(payments, true)}>
              Pay later
            </button>
          )}
          {remaining <= 0 && (
            <button class="primary big" onClick={() => void finish(payments)}>
              Complete sale
            </button>
          )}
        </div>
        <div class="checkout-right">
          <div class="entry" aria-live="polite">
            {money(entered)}
          </div>
          <Keypad cents={cents} suggestion={`${tipTotal}:${payments.length}`} onChange={setCents} onEnter={(typed) => take(centsToAmount(typed, dp))} />
          {overpayNonCash && <p class="warn small">Only {money(remaining)} can go on {boot.value?.payment_methods[method]}.</p>}
          <button class="primary big" disabled={entered <= 0 || remaining <= 0} onClick={() => take(entered)}>
            {method === 'cash' && entered > remaining
              ? `Take ${money(entered)}, change ${money(entered - remaining)}`
              : entered < remaining
                ? `Take ${money(entered)} (split)`
                : `Take ${money(Math.min(entered, remaining))}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
