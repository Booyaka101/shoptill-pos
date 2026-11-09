// Mirrors how WooCommerce totals an order (WC_Abstract_Order::calculate_totals and WC_Tax), so the
// till can show the exact total offline. The server recalculates and its answer is authoritative.

import type { OrderItem } from './api';

export interface TaxRate {
  id: number;
  rate: number;
  label: string;
  compound: boolean;
}

export interface TaxConfig {
  enabled: boolean;
  prices_include_tax: boolean;
  round_at_subtotal: boolean;
  rounding_mode: 'half_up' | 'half_down';
  rounding_precision: number;
  price_decimals: number;
  classes: Record<string, string>;
  rates: Record<string, TaxRate[]>;
}

export interface TotalsLine {
  /** Unit price in the shop's price terms (tax inclusive when the shop enters prices with tax). */
  price: number;
  qty: number;
  taxable: boolean;
  taxClass: string;
  /** Manual discount for the whole line, in shop price terms. */
  discount: number;
  /** Coupon discount for the whole line as reported by the server preview, in shop price terms. */
  couponDiscount: number;
}

export interface LineResult {
  subtotalEx: number;
  totalEx: number;
  taxes: Record<number, number>;
  /** What the customer sees for the line after discounts, in shop price terms, rounded. */
  display: number;
  /** Line before discounts, in shop price terms, rounded. */
  displaySubtotal: number;
}

export interface Totals {
  lines: LineResult[];
  subtotal: number;
  discount: number;
  taxLines: { id: number; label: string; amount: number }[];
  tax: number;
  total: number;
  /** Subtotal and discount in shop price terms, for display. */
  displaySubtotal: number;
  displayDiscount: number;
  /** The delivery charge, once a sale is marked to deliver with one, in shop price terms. */
  shipping: { display: number; tax: number } | null;
}

/**
 * What refunding these quantities gives back, worked out the way the refund on the server does: each
 * line and tax rate rounded on its own, and the last units back taking whatever is left of the line.
 */
export function refundTotal(items: OrderItem[], qty: Record<number, number>, dp: number): number {
  let sum = 0;
  for (const item of items) {
    const n = qty[item.id] ?? 0;
    if (!n) continue;
    const last = n >= item.qty - item.qty_refunded;
    const share = n / item.qty;
    sum += phpRound(last ? item.total - item.refunded : item.total * share, dp);
    item.taxes.forEach((tax, k) => (sum += phpRound(last ? tax - (item.tax_refunded[k] ?? 0) : tax * share, dp)));
  }
  return phpRound(sum, dp);
}

/** PHP's round(): pre-rounds to 15 significant digits to absorb binary noise, then rounds half up or down. */
export function phpRound(value: number, precision = 0, mode: 'half_up' | 'half_down' = 'half_up'): number {
  if (!Number.isFinite(value) || value === 0) return value;
  const factor = 10 ** precision;
  const sign = value < 0 ? -1 : 1;
  const scaled = Number((Math.abs(value) * factor).toPrecision(15));
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded: number;
  if (diff > 0.5) rounded = floor + 1;
  else if (diff < 0.5) rounded = floor;
  else rounded = mode === 'half_up' ? floor + 1 : floor;
  return sign * Number((rounded / factor).toFixed(Math.max(0, precision)));
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

function calcInclusive(price: number, rates: TaxRate[], precision: number): Record<number, number> {
  const taxes: Record<number, number> = {};
  const regular: TaxRate[] = [];
  const compound: TaxRate[] = [];
  for (const r of rates) {
    taxes[r.id] = 0;
    (r.compound ? compound : regular).push(r);
  }
  let nonCompound = price;
  for (const r of [...compound].reverse()) {
    const amount = nonCompound - nonCompound / (1 + r.rate / 100);
    taxes[r.id] += amount;
    nonCompound -= amount;
  }
  const regularRate = 1 + sum(regular.map((r) => r.rate)) / 100;
  for (const r of regular) {
    const theRate = r.rate / 100 / regularRate;
    const net = price - theRate * nonCompound;
    taxes[r.id] += price - net;
  }
  for (const id in taxes) taxes[id] = phpRound(taxes[id], precision);
  return taxes;
}

function calcExclusive(price: number, rates: TaxRate[], precision: number): Record<number, number> {
  const taxes: Record<number, number> = {};
  for (const r of rates) {
    if (!r.compound) taxes[r.id] = (taxes[r.id] ?? 0) + price * (r.rate / 100);
  }
  let preCompound = sum(Object.values(taxes));
  for (const r of rates) {
    if (!r.compound) continue;
    taxes[r.id] = (taxes[r.id] ?? 0) + (price + preCompound) * (r.rate / 100);
    preCompound = sum(Object.values(taxes));
  }
  for (const id in taxes) taxes[id] = phpRound(taxes[id], precision);
  return taxes;
}

export function calculate(lines: TotalsLine[], cfg: TaxConfig, deliveryCharge = 0): Totals {
  const dp = cfg.price_decimals;
  const prec = cfg.rounding_precision;
  const inclusive = cfg.enabled && cfg.prices_include_tax;
  const roundItem = (v: number) => (cfg.round_at_subtotal ? v : phpRound(v, dp));
  const roundTax = (v: number) => (cfg.round_at_subtotal ? v : phpRound(v, dp, cfg.rounding_mode));

  const rateLabels = new Map<number, string>();
  const cartTaxes = new Map<number, number>();

  const results = lines.map((line): LineResult => {
    const taxable = cfg.enabled && line.taxable;
    const rates = taxable ? (cfg.rates[line.taxClass] ?? []) : [];
    rates.forEach((r) => rateLabels.set(r.id, r.label));
    const exclude = (amount: number) =>
      inclusive && taxable ? amount - sum(Object.values(calcInclusive(amount, rates, prec))) : amount;

    // The server splits a tax-inclusive line again from its price with tax (Orders::keep_shelf_prices).
    const fromGross = (ex: number, taxes: Record<number, number>): [number, Record<number, number>] => {
      const gross = phpRound(ex + sum(Object.values(taxes)), dp);
      const split = calcInclusive(gross, rates, prec);
      for (const id in split) split[id] = roundTax(split[id]);
      return [gross - sum(Object.values(split)), split];
    };

    const linePrice = line.price * line.qty;
    let subtotalEx = exclude(linePrice);
    const afterCoupon = Math.max(0, subtotalEx - (line.couponDiscount ? exclude(line.couponDiscount) : 0));
    let totalEx = Math.max(0, afterCoupon - (line.discount ? exclude(line.discount) : 0));

    let taxes = taxable ? calcExclusive(totalEx, rates, prec) : {};
    let subtotalTaxes = taxable ? calcExclusive(subtotalEx, rates, prec) : {};
    if (inclusive && taxable) {
      [subtotalEx, subtotalTaxes] = fromGross(subtotalEx, subtotalTaxes);
      [totalEx, taxes] = fromGross(totalEx, taxes);
    }
    for (const [id, amount] of Object.entries(taxes)) {
      cartTaxes.set(Number(id), (cartTaxes.get(Number(id)) ?? 0) + roundTax(amount));
    }

    const lineTax = sum(Object.values(taxes).map(roundTax));
    const lineSubtotalTax = sum(Object.values(subtotalTaxes).map(roundTax));
    return {
      subtotalEx,
      totalEx,
      taxes,
      display: phpRound(inclusive ? roundItem(totalEx) + lineTax : totalEx, dp),
      displaySubtotal: phpRound(inclusive ? roundItem(subtotalEx) + lineSubtotalTax : linePrice, dp),
    };
  });

  const subtotal = sum(results.map((r) => roundItem(r.subtotalEx)));
  let cartTotal = sum(results.map((r) => roundItem(r.totalEx)));
  // A delivery charge is taxed at the standard rate like the rest of the sale, the way the server
  // splits it again (Orders::keep_delivery_price): the charge, in shop price terms, is what is charged.
  let shipping: Totals['shipping'] = null;
  if (deliveryCharge > 0) {
    let ex = deliveryCharge;
    let tax = 0;
    if (cfg.enabled) {
      const rates = cfg.rates[''] ?? [];
      rates.forEach((r) => rateLabels.set(r.id, r.label));
      const taxes = inclusive ? calcInclusive(deliveryCharge, rates, prec) : calcExclusive(deliveryCharge, rates, prec);
      for (const id in taxes) {
        const amount = roundTax(taxes[id]);
        taxes[id] = amount;
        tax += amount;
        cartTaxes.set(Number(id), (cartTaxes.get(Number(id)) ?? 0) + amount);
      }
      if (inclusive) ex = phpRound(deliveryCharge - tax, dp);
    }
    shipping = { display: deliveryCharge, tax };
    cartTotal += ex;
  }
  const cartTax = sum([...cartTaxes.values()]);
  const total = phpRound(cartTotal + cartTax, dp);
  const displaySubtotal = phpRound(sum(results.map((r) => r.displaySubtotal)), dp);

  return {
    lines: results,
    subtotal: phpRound(subtotal, dp),
    discount: phpRound(subtotal - cartTotal, dp),
    taxLines: [...cartTaxes.entries()]
      .filter(([, amount]) => amount !== 0)
      .map(([id, amount]) => ({ id, label: rateLabels.get(id) ?? '', amount: phpRound(amount, dp, cfg.rounding_mode) })),
    tax: phpRound(cartTax, dp, cfg.rounding_mode),
    total,
    displaySubtotal,
    displayDiscount: phpRound(inclusive ? displaySubtotal - total : subtotal - cartTotal, dp),
    shipping,
  };
}

/**
 * Spread a whole-cart discount over lines in proportion to what each line costs after its own
 * discounts, in cents, with the rounding remainder on the largest line.
 */
export function distributeDiscount(amounts: number[], discount: number, decimals: number): number[] {
  const factor = 10 ** decimals;
  const cents = amounts.map((a) => Math.round(a * factor));
  const base = sum(cents);
  const target = Math.min(Math.round(discount * factor), base);
  if (base <= 0 || target <= 0) return amounts.map(() => 0);
  const shares = cents.map((c) => Math.floor((c * target) / base));
  let remainder = target - sum(shares);
  const order = cents.map((c, i) => [c, i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; remainder > 0; k = (k + 1) % order.length) {
    const i = order[k][1];
    if (shares[i] < cents[i]) {
      shares[i]++;
      remainder--;
    }
  }
  return shares.map((s) => s / factor);
}
