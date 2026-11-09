import type { Currency } from './api';

let currency: Currency = {
  code: 'USD',
  symbol: '$',
  position: 'left',
  decimals: 2,
  decimal_separator: '.',
  thousand_separator: ',',
};

export function setCurrency(c: Currency) {
  currency = c;
}

export function decimals() {
  return currency.decimals;
}

/** Formats like wc_price(): the shop's symbol position and separators. */
export function money(amount: number): string {
  const negative = amount < 0;
  const [whole, frac] = Math.abs(amount).toFixed(currency.decimals).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, currency.thousand_separator);
  const number = frac ? grouped + currency.decimal_separator + frac : grouped;
  const s = currency.symbol;
  const formatted = {
    left: s + number,
    right: number + s,
    left_space: `${s} ${number}`,
    right_space: `${number} ${s}`,
  }[currency.position] ?? s + number;
  return negative ? `-${formatted}` : formatted;
}

/**
 * Parses typed input in the shop's number format: 0 when blank, NaN when it isn't a number. A lone "." is
 * the decimal point even where the shop groups thousands with it, as on a number pad. Another lone
 * separator before exactly three digits groups thousands, unless it is the shop's decimal separator.
 */
export function parseAmount(input: string): number {
  const { decimal_separator: dec, thousand_separator: sep, symbol } = currency;
  let s = input.replace(/\s/g, '');
  if (symbol) s = s.split(symbol).join('');
  if (sep && sep !== '.' && sep !== ',') s = s.split(sep).join('');
  if (!s) return 0;
  if (!/^-?[\d.,]*\d[\d.,]*$/.test(s)) return NaN;
  const sign = s.startsWith('-') ? '-' : '';
  const body = s.slice(sign.length);
  const last = Math.max(body.lastIndexOf('.'), body.lastIndexOf(','));
  const mark = body[last];
  const after = body.slice(last + 1);
  const grouping = last < 0 || body.indexOf(mark) !== last || (after.length === 3 && (!currency.decimals || (mark !== dec && mark !== '.')));
  // Whatever separators are left group the digits in threes, as wc_price() writes them.
  const groups = (grouping ? body : body.slice(0, last)).split(/[.,]/);
  if (groups.length > 1 && (!/^\d{1,3}$/.test(groups[0]) || groups.slice(1).some((g) => !/^\d{3}$/.test(g)))) return NaN;
  // A currency without decimals has no cents to type: "12.50" is a mistyping, not 13.
  if (!grouping && !currency.decimals) return NaN;
  const amount = Number(`${sign}${groups.join('') || '0'}${grouping ? '' : `.${after}`}`);
  return Number.isFinite(amount) ? amount : NaN;
}

/** Round amounts a customer is likely to hand over for a given amount due, scaled to the size of the sum. */
export function quickCash(due: number): number[] {
  const unit = 10 ** Math.max(0, Math.floor(Math.log10(due)) - 2);
  const out = new Set<number>([due]);
  for (const n of [5, 10, 20, 50, 100]) {
    const up = Math.ceil(due / (n * unit)) * n * unit;
    if (up > due) out.add(up);
  }
  return [...out].sort((a, b) => a - b).slice(0, 5);
}

export function round(amount: number): number {
  const f = 10 ** currency.decimals;
  return Math.round((amount + Number.EPSILON) * f) / f;
}
