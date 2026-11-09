/**
 * The products this device sells, most recent first — the "Recent" chip's
 * backing. Watching the cart catches every path that rings something up
 * (taps, scans, weighed labels, restored sales), so nothing has to remember
 * to report in. Per device, like everything else the till keeps about itself.
 */
import { effect, signal } from '@preact/signals';
import { getKv, setKv } from './db';
import { cart, products } from './state';

export const recent = signal<number[]>([]);

let restored = false;

export function startRecent() {
  // Restore first, so the effect below never writes an empty list over a
  // device's history before IndexedDB has answered.
  void getKv<number[]>('recent').then((list) => {
    if (Array.isArray(list)) recent.value = list.filter((n) => typeof n === 'number');
    restored = true;
  });

  effect(() => {
    // Read the signals before the guard, so the effect depends on them and re-runs
    // when the sale changes; a plain flag alone would leave it asleep.
    const lines = cart.value.lines;
    const catalogue = products.value;
    if (!restored) return;
    // A variation goes on the sale; the chip shows its parent. The lines are walked
    // back to front, so whatever was rung up last sits at the front of the chip.
    const ids: number[] = [];
    for (const l of [...lines].reverse()) {
      if (!l.productId) continue;
      const p = catalogue.get(l.productId);
      const id = p?.type === 'variation' ? p.parent_id ?? l.productId : l.productId;
      if (!ids.includes(id)) ids.push(id);
    }
    if (!ids.length) return;
    const next = [...ids, ...recent.value.filter((id) => !ids.includes(id))].slice(0, 24);
    if (next.length === recent.value.length && next.every((id, i) => id === recent.value[i])) return;
    recent.value = next;
    void setKv('recent', next);
  });
}
