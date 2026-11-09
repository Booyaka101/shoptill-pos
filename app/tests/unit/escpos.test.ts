/** ESC/POS byte stream: the receipt a thermal printer actually receives. */
import { describe, expect, it } from 'vitest';
import { encodeText, escposReceipt } from '../../src/escpos';
import type { Receipt } from '../../src/db';

const base: Receipt = {
  client_id: 'c1',
  number: '1042',
  date: new Date('2026-10-07T14:32:00').getTime(),
  lines: [
    { name: 'Flat white', qty: 2, unit: 4.95, total: 9.9, discount: 0, sku: 'A-101', meta: '' },
    { name: 'Croissant', qty: 1, unit: 3.5, total: 3.5, discount: 0.5, sku: 'B-9', meta: 'butter' },
  ],
  subtotal: 13.9,
  discount: 0.5,
  coupons: [],
  taxes: [{ label: 'VAT', amount: 1.9 }],
  tax: 1.9,
  total: 13.4,
  prices_include_tax: false,
  payments: [{ method: 'cash', label: 'Cash', amount: 13.4, tendered: 20, change: 6.6 }],
  customer: '',
  email: '',
  note: 'Handle with care',
  register: 'Front',
  cashier: 'Casey',
  refunded: 0,
};

const asText = (bytes: number[]) => String.fromCharCode(...bytes.filter((b) => b >= 32 || b === 10));

describe('encodeText', () => {
  it('passes ASCII through and transliterates the accents a receipt meets', () => {
    expect(encodeText('cafe')).toEqual([99, 97, 102, 101]);
    expect(asText(encodeText('café − 12,50'))).toBe('cafe - 12,50');
    expect(asText(encodeText('Rêsumé → done'))).toBe('Resume -> done');
  });

  it('turns the unmappable into a printing question mark, not mojibake', () => {
    expect(encodeText('中')[0]).toBe(0x3f);
  });
});

describe('escposReceipt', () => {
  const bytes = escposReceipt(base, { name: "Sam's Coffee", address: ['12 Long Street', 'Cape Town'], footer: 'Thanks!' });
  const text = asText(bytes);

  it('starts by resetting the printer and ends by feeding and cutting', () => {
    expect(bytes.slice(0, 2)).toEqual([0x1b, 0x40]); // ESC @
    const tail = bytes.slice(-8);
    expect(tail).toContain(0x56); // GS V cut
    expect(tail).toContain(3); // three-line feed
  });

  it('carries the shop, the order, the lines and the money', () => {
    expect(text).toContain("SAM'S COFFEE");
    expect(text).toContain('12 Long Street');
    expect(text).toContain('Order 1042');
    expect(text).toContain('Front - Casey');
    expect(text).toContain('2 x Flat white');
    expect(text).toContain('9.90');
    expect(text).toContain('TOTAL');
    expect(text).toContain('13.40');
    expect(text).toContain('tendered');
    expect(text).toContain('change');
    expect(text).toContain('6.60');
    expect(text).toContain('VAT');
  });

  it('wraps the meta under its line and keeps the note', () => {
    expect(text).toContain('butter');
    expect(text).toContain('Handle with care');
  });

  it('marks a copy and a gift receipt', () => {
    expect(asText(escposReceipt({ ...base, copy: true }, { name: 'X' }))).toContain('COPY');
    const gift = escposReceipt({ ...base, gift: true }, { name: 'X' });
    const giftText = asText(gift);
    expect(giftText).toContain('GIFT RECEIPT');
    expect(giftText).not.toContain('TOTAL');
  });

  it('prints fee breakdowns but leaves them off gift receipts', () => {
    const receipt = { ...base, fees: [{ label: 'Tip', amount: 2.5 }] };
    expect(asText(escposReceipt(receipt, { name: 'X' }))).toMatch(/Tip\s+\$2\.50/);
    expect(asText(escposReceipt({ ...receipt, gift: true }, { name: 'X' }))).not.toContain('Tip');
  });
});
