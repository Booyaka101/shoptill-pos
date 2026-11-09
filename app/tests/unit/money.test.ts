import { afterEach, describe, expect, it } from 'vitest';
import type { Currency } from '../../src/api';
import { money, parseAmount, quickCash, round, setCurrency } from '../../src/money';

const usd: Currency = { code: 'USD', symbol: '$', position: 'left', decimals: 2, decimal_separator: '.', thousand_separator: ',' };
const eur: Currency = { code: 'EUR', symbol: '€', position: 'right_space', decimals: 2, decimal_separator: ',', thousand_separator: '.' };
const sek: Currency = { code: 'SEK', symbol: 'kr', position: 'right_space', decimals: 2, decimal_separator: ',', thousand_separator: ' ' };
const jpy: Currency = { code: 'JPY', symbol: '¥', position: 'left', decimals: 0, decimal_separator: '.', thousand_separator: ',' };

afterEach(() => setCurrency(usd));

describe('money', () => {
  it('formats like wc_price', () => {
    setCurrency(usd);
    expect(money(1234.5)).toBe('$1,234.50');
    expect(money(-3.1)).toBe('-$3.10');
    setCurrency(eur);
    expect(money(1234.5)).toBe('1.234,50 €');
    setCurrency(jpy);
    expect(money(1234.4)).toBe('¥1,234');
  });
});

describe('parseAmount', () => {
  it('reads the shop format', () => {
    setCurrency(usd);
    expect(parseAmount('1,234.56')).toBe(1234.56);
    setCurrency(eur);
    expect(parseAmount('1.234,56')).toBe(1234.56);
    expect(parseAmount('2,50')).toBe(2.5);
    setCurrency(sek);
    expect(parseAmount('1 234,56')).toBe(1234.56);
  });

  it('takes a plain dot as the decimal point', () => {
    setCurrency(eur);
    expect(parseAmount('2.50')).toBe(2.5);
    setCurrency(sek);
    expect(parseAmount('19.95')).toBe(19.95);
  });

  it('ignores symbols, reads blank as 0 and anything else as not a number', () => {
    expect(parseAmount(' $4.20 ')).toBe(4.2);
    expect(parseAmount('')).toBe(0);
    for (const junk of ['abc', '3.5.0', '2-3', '1,23,4', '4e2']) expect(parseAmount(junk)).toBeNaN();
  });

  it('rejects amounts that overflow instead of sending Infinity as null in JSON', () => {
    expect(parseAmount('9'.repeat(400))).toBeNaN();
    expect(parseAmount('-' + '9'.repeat(400))).toBeNaN();
  });

  it('groups thousands only in threes, and never with the decimal separator', () => {
    setCurrency(usd);
    expect(parseAmount('3,50')).toBe(3.5);
    expect(parseAmount('3,500')).toBe(3500);
    expect(parseAmount('1,234,567')).toBe(1234567);
    expect(parseAmount('.5')).toBe(0.5);
    setCurrency(eur);
    expect(parseAmount('1,500')).toBe(1.5);
    expect(parseAmount('1.234.567')).toBe(1234567);
    setCurrency(jpy);
    expect(parseAmount('45.000')).toBe(45000);
    expect(parseAmount('45,000')).toBe(45000);
    expect(parseAmount('12.50')).toBeNaN();
    expect(parseAmount('12,5')).toBeNaN();
    expect(parseAmount('.5')).toBeNaN();
  });
});

describe('quickCash', () => {
  it('offers notes to the size of the sum', () => {
    expect(quickCash(4.66)).toEqual([4.66, 5, 10, 20, 50]);
    expect(quickCash(1234)).toEqual([1234, 1250, 1300, 1400, 1500]);
    expect(quickCash(47500)).toEqual([47500, 48000, 50000]);
    expect(quickCash(45000)).toEqual([45000, 46000, 50000]);
  });
});

describe('round', () => {
  it('rounds to the shop decimals', () => {
    expect(round(1.005)).toBe(1.01);
    setCurrency(jpy);
    expect(round(12.5)).toBe(13);
  });
});
