import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bootstrap } from '../../src/api';

vi.mock('../../src/state', () => ({ boot: { value: null } }));
import { boot } from '../../src/state';
import { shopDateTime, shopDay, shopTime } from '../../src/time';

const timestamp = (iso: string) => Date.parse(iso) / 1000;
const configure = (timezone: string | undefined, utc_offset: number) => {
  boot.value = { timezone, utc_offset } as Bootstrap;
};
afterEach(() => { boot.value = null; });

describe('shop clock', () => {
  it('uses the timestamp’s daylight-saving offset, not the cached sign-in offset', () => {
    configure('America/New_York', -5 * 3600);
    const ts = timestamp('2026-07-01T04:30:00Z');
    expect(shopDay(ts)).toBe('2026-07-01');
    expect(shopTime(ts)).toBe(new Date(ts * 1000).toLocaleTimeString(undefined, { timeZone: 'America/New_York' }));
    expect(shopDateTime(ts)).toBe(new Date(ts * 1000).toLocaleString(undefined, {
      timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    }));
    expect(shopDay(timestamp('2026-01-01T04:30:00Z'))).toBe('2025-12-31');
  });

  it('handles both sides of a clock change while the till stays signed in', () => {
    configure('Europe/London', 3600);
    for (const iso of ['2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z']) {
      const ts = timestamp(iso);
      expect(shopTime(ts)).toBe(new Date(ts * 1000).toLocaleTimeString(undefined, { timeZone: 'Europe/London' }));
      expect(shopDay(ts)).toBe('2026-10-25');
    }
    expect(shopDay(timestamp('2026-10-25T23:30:00Z'))).toBe('2026-10-25');
  });

  it.each([undefined, 'Not/A_Timezone', '+05:30'])('keeps fixed-offset and older cached shops usable (%s)', (timezone) => {
    configure(timezone, 19800);
    expect(shopDay(timestamp('2026-01-01T20:00:00Z'))).toBe('2026-01-02');
  });

  it('uses the device’s clock before bootstrap is available', () => {
    const ts = timestamp('2026-01-01T20:00:00Z');
    const d = new Date(ts * 1000);
    expect(shopDay(ts)).toBe(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  });
});
