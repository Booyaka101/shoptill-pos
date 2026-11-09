import { describe, expect, it } from 'vitest';
import { toCsv } from '../../src/csv';

describe('toCsv', () => {
  it('quotes what needs quoting', () => {
    expect(toCsv([['a,b', 'say "hi"', 3], ['two\nlines']])).toBe('"a,b","say ""hi""",3\r\n"two\nlines"');
  });

  it('keeps a product name from running as a spreadsheet formula', () => {
    expect(toCsv([['=HYPERLINK("x")', '-5', -5, '@me']])).toBe(`"'=HYPERLINK(""x"")",'-5,-5,'@me`);
  });
});
