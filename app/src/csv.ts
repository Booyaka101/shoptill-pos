// A spreadsheet opens a cell starting with one of these as a formula.
const FORMULA = /^[=+\-@\t\r]/;

function cell(v: string | number) {
  if (typeof v === 'number') return String(v);
  const s = FORMULA.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const toCsv = (rows: (string | number)[][]) => rows.map((r) => r.map(cell).join(',')).join('\r\n');
