import { boot } from './state';

/**
 * Formats a timestamp the way the shop's clock reads it, not the device's, since a till is often a
 * phone in another timezone. Named zones follow clock changes even while offline. Older caches
 * and WordPress fixed-offset zones keep using the offset, or the device's until the shop's is known.
 */
function onShopClock(ts: number) {
  const timeZone = boot.value?.timezone;
  if (timeZone) {
    try {
      // Older browsers may not understand WordPress's fixed-offset names such as +05:30.
      new Intl.DateTimeFormat(undefined, { timeZone });
      return { date: new Date(ts * 1000), timeZone };
    } catch {}
  }
  const offset = boot.value?.utc_offset ?? -new Date(ts * 1000).getTimezoneOffset() * 60;
  // Shifted by the offset and formatted as UTC, so the formatter doesn't shift it back off again.
  return { date: new Date((ts + offset) * 1000), timeZone: 'UTC' };
}

export function shopTime(ts: number) {
  const { date, timeZone } = onShopClock(ts);
  return date.toLocaleTimeString(undefined, { timeZone });
}

export function shopDate(ts: number) {
  const { date, timeZone } = onShopClock(ts);
  return date.toLocaleDateString(undefined, { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' });
}

export function shopDateTime(ts: number) {
  const { date, timeZone } = onShopClock(ts);
  return date.toLocaleString(undefined, { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
}

/** A report date, independent of the device's timezone and date format. */
export function shopDay(ts: number) {
  const { date, timeZone } = onShopClock(ts);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
