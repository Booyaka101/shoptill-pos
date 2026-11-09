import type { Product } from './api';
import { decodeScan, findByCode } from './barcode';
import { addProduct, lineFromProduct, type Cart, type CartLine } from './cart';
import { boot, cart, notify, products, reserved, stockHolder } from './state';

/** Stock left once sales still waiting to sync are taken off, or null when the product doesn't track stock. */
export function available(p: Product): number | null {
  if (!p.manage_stock || p.stock_quantity === null) return null;
  return p.stock_quantity - (reserved.value.get(stockHolder(p.id)) ?? 0);
}

export function inStock(p: Product) {
  const left = available(p);
  return p.stock_status !== 'outofstock' && (left === null || left > 0);
}

export const onBackorder = (p: Product) => !!p.backorders || p.stock_status === 'onbackorder';

/** Units one cart line can hold of a product, given what the cart's other lines already take of its stock. */
export function room(p: Product, lines: CartLine[], except?: string): number {
  const most = p.sold_individually ? 1 : Infinity;
  if (boot.value?.allow_oversell || onBackorder(p)) return most;
  const left = available(p);
  if (p.stock_status === 'outofstock') return 0;
  if (left === null) return most;
  const holder = stockHolder(p.id);
  const taken = lines.reduce((n, l) => (l.key !== except && l.productId && stockHolder(l.productId) === holder ? n + l.qty : n), 0);
  return Math.min(most, Math.max(0, left - taken));
}

export const canSell = (p: Product) => room(p, []) > 0;

/** Adds a sellable product, refusing out-of-stock items when the shop doesn't allow overselling. */
export function sell(p: Product) {
  if (p.price === null) {
    notify(`${p.name} has no price in WooCommerce yet.`, 'error');
    return;
  }
  const holder = stockHolder(p.id);
  const inCart = cart.value.lines.some((l) => l.productId && stockHolder(l.productId) === holder);
  if (p.sold_individually && cart.value.lines.some((l) => l.productId === p.id)) {
    notify(`${p.name} is sold one at a time.`, 'error');
    return;
  }
  if (room(p, cart.value.lines) < 1) {
    notify(inCart ? `No more ${p.name} in stock.` : `${p.name} is out of stock.`, 'error');
    return;
  }
  const parent = p.type === 'variation' ? products.value.get(p.parent_id) : undefined;
  cart.value = addProduct(cart.value, p, parent);
}

/** Adds a product a scale label priced or weighed, overriding what the shelf says. */
function sellWeighed(p: Product, qty?: number, price?: number) {
  const line: CartLine = { ...lineFromProduct(p), ...(price !== undefined ? { price, listPrice: null } : {}) };
  if (qty !== undefined) {
    if (qty <= 0) return notify(`The label on ${p.name} says it weighs nothing.`, 'error');
    if (room(p, cart.value.lines) < qty) return notify(`That much ${p.name} is not in stock.`, 'error');
    line.qty = qty;
  }
  cart.value = { ...cart.value, lines: [...cart.value.lines, line] };
}

export function sellCode(code: string) {
  const decoded = decodeScan(code);
  const p = findByCode(products.value.values(), code);
  if (!p) {
    notify(`No product with barcode or SKU ${code}.`, 'error');
    return false;
  }
  if (decoded.qty !== undefined || decoded.price !== undefined) {
    if (p.price === null) {
      notify(`${p.name} has no price in WooCommerce yet.`, 'error');
      return true;
    }
    sellWeighed(p, decoded.qty, decoded.price);
    return true;
  }
  sell(p);
  return true;
}
