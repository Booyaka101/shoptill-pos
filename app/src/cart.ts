import { calculate, distributeDiscount, type TaxConfig, type Totals } from './totals';
import type { Customer, Product, ShipTo } from './api';

export interface CartLine {
  key: string;
  productId: number | null;
  name: string;
  sku: string;
  /** Unit price in shop price terms. */
  price: number;
  /** The catalogue price, to tell whether the cashier overrode it. */
  listPrice: number | null;
  qty: number;
  taxable: boolean;
  taxClass: string;
  /** Unit cost from the catalogue, carried on staff tills so a sale that syncs late is costed as the stock it sold. */
  cost?: number;
  /** Manual discount for the whole line. */
  discount: number;
  meta: string;
}

export interface Cart {
  lines: CartLine[];
  customer: Customer | null;
  coupons: string[];
  /** Coupon discount per line key, from the last server preview. */
  couponDiscounts: Record<string, number>;
  /** Discount on the whole sale, spread over lines when the order is sent. */
  cartDiscount: { type: 'percent' | 'fixed'; value: number } | null;
  note: string;
  /** Kept with the order's notes for staff, off the receipt. */
  notePrivate?: boolean;
  /** Paid for now and handed over later. A delivery can carry a charge, in shop price terms. */
  fulfil?: { how: 'collect' } | { how: 'deliver'; to: ShipTo; charge?: number };
}

export const emptyCart = (): Cart => ({
  lines: [],
  customer: null,
  coupons: [],
  couponDiscounts: {},
  cartDiscount: null,
  note: '',
});

export function uid() {
  return crypto.randomUUID();
}

export function lineFromProduct(p: Product, parent?: Product): CartLine {
  const attrs = p.attributes ? Object.entries(p.attributes).map(([k, v]) => `${k}: ${v}`).join(', ') : '';
  return {
    key: uid(),
    productId: p.id,
    name: parent ? parent.name : p.name,
    sku: p.sku,
    price: p.price ?? 0,
    listPrice: p.price,
    qty: 1,
    taxable: p.tax_status === 'taxable',
    taxClass: p.tax_class,
    cost: p.cost ?? undefined,
    discount: 0,
    meta: attrs,
  };
}

/** Adds a product, bumping the quantity of an untouched line for the same product instead of adding a new one. */
export function addProduct(cart: Cart, p: Product, parent?: Product): Cart {
  if (p.sold_individually && cart.lines.some((l) => l.productId === p.id)) return cart;
  const existing = cart.lines.find(
    (l) => l.productId === p.id && l.price === l.listPrice && l.discount === 0,
  );
  if (existing) {
    return { ...cart, lines: cart.lines.map((l) => (l === existing ? { ...l, qty: l.qty + 1 } : l)) };
  }
  return { ...cart, lines: [...cart.lines, lineFromProduct(p, parent)] };
}

/** Line discounts actually sent to the server: the line's own discount plus its share of the cart discount. */
export function effectiveDiscounts(cart: Cart, decimals: number): number[] {
  const afterOwn = cart.lines.map((l) =>
    Math.max(0, l.price * l.qty - (cart.couponDiscounts[l.key] ?? 0) - l.discount),
  );
  let shares = cart.lines.map(() => 0);
  if (cart.cartDiscount && cart.cartDiscount.value > 0) {
    const base = afterOwn.reduce((a, b) => a + b, 0);
    const target =
      cart.cartDiscount.type === 'percent' ? (base * Math.min(100, cart.cartDiscount.value)) / 100 : cart.cartDiscount.value;
    shares = distributeDiscount(afterOwn, target, decimals);
  }
  return cart.lines.map((l, i) => round(l.discount + shares[i], decimals));
}

const round = (v: number, dp: number) => Math.round((v + Number.EPSILON) * 10 ** dp) / 10 ** dp;

export function totals(cart: Cart, tax: TaxConfig): Totals {
  const discounts = effectiveDiscounts(cart, tax.price_decimals);
  const charge = cart.fulfil?.how === 'deliver' ? cart.fulfil.charge ?? 0 : 0;
  return calculate(
    cart.lines.map((l, i) => ({
      price: l.price,
      qty: l.qty,
      taxable: l.taxable,
      taxClass: l.taxClass,
      discount: discounts[i],
      couponDiscount: cart.couponDiscounts[l.key] ?? 0,
    })),
    tax,
    charge,
  );
}

/** Cart lines in the shape POST /orders and /orders/preview take. */
export function wireLines(cart: Cart, decimals: number) {
  const discounts = effectiveDiscounts(cart, decimals);
  return cart.lines.map((l, i) => {
    // Price, name and tax class go along so a sale queued offline keeps what the customer paid,
    // even if the product changes or is deleted in WooCommerce before it syncs.
    const base = l.productId
      ? {
          product_id: l.productId,
          qty: l.qty,
          price: l.price,
          name: l.name,
          tax_class: l.taxClass,
          taxable: l.taxable,
          ...(l.cost !== undefined ? { cost: l.cost } : {}),
          ...(l.listPrice !== null && l.price !== l.listPrice ? { price_changed: true } : {}),
        }
      : { name: l.name, qty: l.qty, price: l.price, tax_class: l.taxClass };
    return discounts[i] > 0 ? { ...base, discount: discounts[i] } : base;
  });
}

/** Coupon previews depend on the products, quantities, prices and customer, not on manual discounts. */
export function couponKey(cart: Cart) {
  return JSON.stringify([
    cart.coupons,
    cart.customer?.id ?? 0,
    cart.lines.map((l) => [l.productId, l.name, l.qty, l.price, l.taxClass]),
  ]);
}
