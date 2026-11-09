import { describe, expect, it } from 'vitest';
import type { Product } from '../../src/api';
import { addProduct, couponKey, effectiveDiscounts, emptyCart, wireLines, type Cart } from '../../src/cart';

const product = (id: number, price: number, extra: Partial<Product> = {}): Product => ({
  id,
  parent_id: 0,
  type: 'simple',
  name: `P${id}`,
  sku: `SKU${id}`,
  gtin: '',
  price,
  regular_price: price,
  on_sale: false,
  tax_status: 'taxable',
  tax_class: '',
  manage_stock: false,
  stock_quantity: null,
  stock_status: 'instock',
  sold_individually: false,
  image: null,
  category_ids: [],
  ...extra,
});

const withLines = (...products: Product[]): Cart => products.reduce((cart, p) => addProduct(cart, p), emptyCart());

describe('addProduct', () => {
  it('bumps an untouched line and starts a new one once the line was edited', () => {
    let cart = withLines(product(1, 5), product(1, 5));
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0].qty).toBe(2);
    cart = { ...cart, lines: [{ ...cart.lines[0], discount: 1 }] };
    cart = addProduct(cart, product(1, 5));
    expect(cart.lines.map((l) => l.qty)).toEqual([2, 1]);
  });

  it('never adds a sold-individually product twice', () => {
    let cart = withLines(product(2, 9, { sold_individually: true }));
    expect(addProduct(cart, product(2, 9, { sold_individually: true })).lines).toHaveLength(1);
    cart = { ...cart, lines: [{ ...cart.lines[0], price: 7 }] };
    expect(addProduct(cart, product(2, 9, { sold_individually: true })).lines).toHaveLength(1);
  });

  it('names a variation after its parent and lists its attributes', () => {
    const cart = addProduct(emptyCart(), product(3, 29, { type: 'variation', attributes: { Size: 'M' } }), product(9, 0, { name: 'Logo tee' }));
    expect(cart.lines[0]).toMatchObject({ name: 'Logo tee', meta: 'Size: M', productId: 3 });
  });
});

describe('effectiveDiscounts', () => {
  it('spreads a percentage sale discount after line discounts and coupons', () => {
    const cart = withLines(product(1, 10), product(2, 30));
    cart.lines[0].discount = 2;
    cart.couponDiscounts = { [cart.lines[1].key]: 10 };
    cart.cartDiscount = { type: 'percent', value: 10 };
    // Base after own discounts and coupons: 8 + 20 = 28, so the sale takes 2.80 split 0.80 / 2.00.
    expect(effectiveDiscounts(cart, 2)).toEqual([2.8, 2]);
  });

  it('caps a fixed sale discount at what is left to discount', () => {
    const cart = withLines(product(1, 3), product(2, 1));
    cart.cartDiscount = { type: 'fixed', value: 50 };
    expect(effectiveDiscounts(cart, 2)).toEqual([3, 1]);
  });

  it('shares an odd cent without losing it', () => {
    const cart = withLines(product(1, 1), product(2, 1), product(3, 1));
    cart.cartDiscount = { type: 'fixed', value: 1 };
    const d = effectiveDiscounts(cart, 2);
    expect(d.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });
});

describe('wireLines', () => {
  it('pins the rung-up price, name and tax, and sends a discount and a price-change flag only when made', () => {
    const cart = withLines(product(1, 5), product(2, 8, { tax_class: 'zero-rate' }), product(3, 25, { tax_status: 'none' }));
    cart.lines[1].price = 6;
    cart.lines[1].discount = 1;
    expect(wireLines(cart, 2)).toEqual([
      { product_id: 1, qty: 1, price: 5, name: 'P1', tax_class: '', taxable: true },
      { product_id: 2, qty: 1, price: 6, name: 'P2', tax_class: 'zero-rate', taxable: true, discount: 1, price_changed: true },
      { product_id: 3, qty: 1, price: 25, name: 'P3', tax_class: '', taxable: false },
    ]);
  });

  it('sends custom items with their own name, price and tax class', () => {
    const cart = emptyCart();
    cart.lines.push({ key: 'k', productId: null, name: 'Gift wrap', sku: '', price: 2.5, listPrice: null, qty: 2, taxable: true, taxClass: 'reduced-rate', discount: 1, meta: '' });
    expect(wireLines(cart, 2)).toEqual([{ name: 'Gift wrap', qty: 2, price: 2.5, tax_class: 'reduced-rate', discount: 1 }]);
  });
});

describe('couponKey', () => {
  it('ignores manual discounts but not quantities', () => {
    const cart = withLines(product(1, 5));
    const key = couponKey(cart);
    expect(couponKey({ ...cart, lines: [{ ...cart.lines[0], discount: 3 }], cartDiscount: { type: 'fixed', value: 1 } })).toBe(key);
    expect(couponKey({ ...cart, lines: [{ ...cart.lines[0], qty: 2 }] })).not.toBe(key);
  });
});
