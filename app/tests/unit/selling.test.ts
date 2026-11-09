import { beforeEach, describe, expect, it } from 'vitest';
import type { Bootstrap, Product } from '../../src/api';
import { emptyCart } from '../../src/cart';
import type { QueuedOrder } from '../../src/db';
import { available, canSell, room, sell, sellCode } from '../../src/selling';
import { boot, cart, products, queue, toast } from '../../src/state';

const milk: Product = {
  id: 7,
  parent_id: 0,
  type: 'simple',
  name: 'Milk',
  sku: 'MILK',
  gtin: '9300000000007',
  price: 3,
  regular_price: 3,
  on_sale: false,
  tax_status: 'none',
  tax_class: '',
  manage_stock: true,
  stock_quantity: 3,
  stock_status: 'instock',
  sold_individually: false,
  image: null,
  category_ids: [],
};

const queued = (qty: number) => ({ client_id: `q${qty}`, status: 'pending', payload: { lines: [{ product_id: milk.id, qty }] } }) as unknown as QueuedOrder;
const inCart = () => cart.value.lines.reduce((n, l) => n + l.qty, 0);

beforeEach(() => {
  boot.value = { allow_oversell: false } as Bootstrap;
  products.value = new Map([[milk.id, milk]]);
  queue.value = [];
  cart.value = emptyCart();
  toast.value = null;
});

describe('selling against stock', () => {
  it('counts sales still waiting to sync against the stock left', () => {
    queue.value = [queued(1), queued(1)];
    expect(available(milk)).toBe(1);
    sell(milk);
    sell(milk);
    expect(inCart()).toBe(1);
    expect(toast.value?.text).toBe('No more Milk in stock.');
  });

  it('lets the shop oversell when it allows it', () => {
    boot.value = { allow_oversell: true } as Bootstrap;
    queue.value = [queued(3)];
    sell(milk);
    expect(inCart()).toBe(1);
  });

  it('counts variations that sell from one shared stock together', () => {
    const small = { ...milk, id: 8, type: 'variation' as const, parent_id: 6, stock_id: 6, gtin: '' };
    const large = { ...small, id: 9 };
    products.value = new Map([
      [small.id, small],
      [large.id, large],
    ]);
    queue.value = [{ client_id: 'q', status: 'pending', payload: { lines: [{ product_id: small.id, qty: 1 }] } } as unknown as QueuedOrder];
    sell(small);
    sell(large);
    sell(large);
    expect(inCart()).toBe(2);
    expect(toast.value?.text).toBe('No more Milk in stock.');
  });

  it('caps one line at the stock the rest of the cart leaves', () => {
    sell(milk);
    cart.value = { ...cart.value, lines: [...cart.value.lines, { ...cart.value.lines[0], key: 'other', discount: 1 }] };
    expect(room(milk, cart.value.lines, 'other')).toBe(2);
    queue.value = [queued(2)];
    expect(room(milk, cart.value.lines, 'other')).toBe(0);
  });

  it('keeps selling a product the shop takes backorders for', () => {
    queue.value = [queued(3)];
    sell({ ...milk, backorders: true });
    expect(inCart()).toBe(1);
    expect(canSell({ ...milk, stock_quantity: 0, stock_status: 'onbackorder' })).toBe(true);
    expect(canSell({ ...milk, stock_quantity: 0, stock_status: 'outofstock' })).toBe(false);
  });

  it('sells a sold-individually product once per sale', () => {
    const one = { ...milk, sold_individually: true };
    sell(one);
    sell(one);
    expect(inCart()).toBe(1);
    expect(toast.value?.text).toBe('Milk is sold one at a time.');
    expect(room(one, cart.value.lines, cart.value.lines[0].key)).toBe(1);
  });

  it('refuses a product with no price', () => {
    sell({ ...milk, price: null });
    expect(inCart()).toBe(0);
  });

  it('sells by barcode and says when nothing matches', () => {
    expect(sellCode('9300000000007')).toBe(true);
    expect(sellCode('0000')).toBe(false);
    expect(inCart()).toBe(1);
    expect(toast.value?.kind).toBe('error');
  });

  it('matches a UPC-A scan to the same code stored as EAN-13, and back', () => {
    products.value = new Map([[milk.id, { ...milk, gtin: '0036000291452' }]]);
    expect(sellCode('036000291452')).toBe(true);
    products.value = new Map([[milk.id, { ...milk, gtin: '036000291452' }]]);
    expect(sellCode('0036000291452')).toBe(true);
    expect(inCart()).toBe(2);
  });
});
