import { describe, expect, it } from 'vitest';
import type { OrderItem } from '../../src/api';
import { calculate, distributeDiscount, phpRound, refundTotal, type TaxConfig } from '../../src/totals';

const gst: TaxConfig = {
  enabled: true,
  prices_include_tax: true,
  round_at_subtotal: false,
  rounding_mode: 'half_down',
  rounding_precision: 6,
  price_decimals: 2,
  classes: { '': 'Standard' },
  rates: { '': [{ id: 1, rate: 10, label: 'GST', compound: false }] },
};

const line = (price: number, qty = 1, extra = {}) => ({
  price,
  qty,
  taxable: true,
  taxClass: '',
  discount: 0,
  couponDiscount: 0,
  ...extra,
});

describe('phpRound', () => {
  it('absorbs binary noise the way PHP does', () => {
    expect(phpRound(1.005, 2)).toBe(1.01);
    expect(phpRound(2.675, 2)).toBe(2.68);
    expect(phpRound(0.285, 2)).toBe(0.29);
  });

  it('honours half down', () => {
    expect(phpRound(1.125, 2, 'half_down')).toBe(1.12);
    expect(phpRound(1.1251, 2, 'half_down')).toBe(1.13);
  });

  it('is symmetric for negatives', () => {
    expect(phpRound(-1.005, 2)).toBe(-1.01);
  });
});

describe('calculate', () => {
  it('keeps tax-inclusive shelf prices whole', () => {
    const t = calculate([line(11), line(5.5, 2)], gst);
    expect(t.total).toBe(22);
    expect(t.tax).toBe(2);
    expect(t.lines.map((l) => l.display)).toEqual([11, 11]);
  });

  it("taxes a delivery charge at the standard rate, in the shop's price terms", () => {
    // With tax in the price, a $5.50 charge is $5.00 + $0.50 GST, like a shelf price.
    const withShip = calculate([line(11)], gst, 5.5);
    expect(withShip.shipping).toEqual({ display: 5.5, tax: 0.5 });
    expect(withShip.total).toBe(16.5);
    expect(withShip.tax).toBe(1.5);
    // Without tax in the price, the charge is what it is and the tax goes on top.
    const ex: TaxConfig = { ...gst, prices_include_tax: false, rounding_mode: 'half_up' };
    const added = calculate([line(10)], ex, 5);
    expect(added.shipping).toEqual({ display: 5, tax: 0.5 });
    expect(added.total).toBe(16.5);
    expect(added.taxLines).toHaveLength(1);
    // No charge, no shipping.
    expect(calculate([line(11)], gst).shipping).toBeNull();
  });

  it('charges the shelf price for every tax-inclusive line, whatever the rates', () => {
    const stacked: TaxConfig = {
      ...gst,
      rounding_mode: 'half_up',
      rates: {
        '': [
          { id: 1, rate: 7.25, label: 'State', compound: false },
          { id: 2, rate: 2.25, label: 'County', compound: false },
          { id: 3, rate: 1.5, label: 'Levy', compound: true },
        ],
      },
    };
    const off: string[] = [];
    for (const cfg of [gst, stacked]) {
      for (let cents = 1; cents <= 5000; cents += 7) {
        for (const qty of [1, 3]) {
          const price = cents / 100;
          const t = calculate([line(price, qty), line(4.2)], cfg);
          const shelf = phpRound(price * qty + 4.2, 2);
          if (t.total !== shelf || t.lines[0].display !== phpRound(price * qty, 2)) off.push(`${qty} x ${price}: ${t.total} vs ${shelf}`);
        }
      }
    }
    expect(off).toEqual([]);
  });

  it('adds tax on top for exclusive prices', () => {
    const t = calculate([line(10)], { ...gst, prices_include_tax: false, rounding_mode: 'half_up' });
    expect(t.total).toBe(11);
    expect(t.subtotal).toBe(10);
  });

  it('skips tax for non-taxable lines', () => {
    const t = calculate([line(25, 1, { taxable: false })], gst);
    expect(t.total).toBe(25);
    expect(t.tax).toBe(0);
  });

  it('takes discounts off the inclusive price', () => {
    const t = calculate([line(22, 1, { discount: 2.2 })], gst);
    expect(t.total).toBe(19.8);
    expect(t.displayDiscount).toBe(2.2);
  });
});

describe('distributeDiscount', () => {
  it('splits by weight and lands exactly on the target', () => {
    const shares = distributeDiscount([10, 20, 30.01], 5, 2);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(5, 10);
    expect(shares[2]).toBeGreaterThan(shares[1]);
  });

  it('never discounts more than the cart is worth', () => {
    expect(distributeDiscount([1, 2], 10, 2)).toEqual([1, 2]);
  });
});

describe('refundTotal', () => {
  const item = (total: number, qty: number, tax = 0): OrderItem =>
    ({ id: 1, qty, qty_refunded: 0, total, taxes: [tax], total_tax: tax, refunded: 0, tax_refunded: [0] }) as unknown as OrderItem;

  it('gives the last unit back whatever the others left of the line', () => {
    const line = item(10, 3);
    expect(refundTotal([line], { 1: 1 }, 2)).toBe(3.33);
    const later = { ...line, qty_refunded: 2, refunded: 6.66 };
    expect(refundTotal([later], { 1: 1 }, 2)).toBe(3.34);
  });

  it('rounds the line and each tax rate on their own, like the server', () => {
    expect(refundTotal([item(4.35, 2, 0.43)], { 1: 1 }, 2)).toBe(2.4);
    const later = { ...item(4.35, 2, 0.43), qty_refunded: 1, refunded: 2.18, tax_refunded: [0.22] };
    expect(refundTotal([later], { 1: 1 }, 2)).toBe(2.38);
  });
});
