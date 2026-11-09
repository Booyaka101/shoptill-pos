/**
 * Per-device appearance preferences: the accent colour, the tile density and
 * the sale chime. Like kiosk mode these belong to the till, not the cashier,
 * so they persist on the device and survive sign-ins.
 */
import { signal, effect } from '@preact/signals';
import { getKv, setKv } from './db';

export type Accent = 'cyan' | 'violet' | 'magenta' | 'amber' | 'blue';
export const ACCENTS: Accent[] = ['cyan', 'violet', 'magenta', 'amber', 'blue'];

export const accent = signal<Accent>('cyan');
/** The shop's own hex colour, which wins over the preset when set. */
export const accentCustom = signal<string | null>(null);
export const density = signal<'comfortable' | 'compact'>('comfortable');
/** Larger text for staff who read the till at arm's length or through glasses. */
export const textSize = signal<'standard' | 'large'>('standard');
/** A true-black dark theme, for OLED counters: deeper blacks, less glow in a dim shop. */
export const trueBlack = signal(false);
/** Solid panels instead of glass, for older screens and wall-mounted tablets. */
export const solid = signal(false);
export const sounds = signal(true);
/** A short buzz on the phone when an item lands on the sale. */
export const haptics = signal(true);
/** The sale panel's width in px, dragged by the cashier. Null is the 400px default. */
export const cartWidth = signal<number | null>(null);

export function startPrefs() {
  // Restore first: the effects below must not write the defaults over a
  // device's saved choices before IndexedDB has answered.
  void Promise.all([
    getKv<Accent>('accent'),
    getKv<string | null>('accentCustom'),
    getKv<typeof density.value>('density'),
    getKv<boolean>('sounds'),
    getKv<typeof textSize.value>('textSize'),
    getKv<boolean>('trueBlack'),
    getKv<boolean>('solid'),
    getKv<boolean>('haptics'),
    getKv<number | null>('cartWidth'),
  ]).then(([a, custom, d, s, t, b, o, h, w]) => {
    if (a) accent.value = a;
    if (typeof custom === 'string' && /^#[0-9a-f]{6}$/i.test(custom)) accentCustom.value = custom;
    if (d) density.value = d;
    if (s !== undefined) sounds.value = s;
    if (t) textSize.value = t;
    if (b !== undefined) trueBlack.value = b;
    if (o !== undefined) solid.value = o;
    if (h !== undefined) haptics.value = h;
    // A window smaller than when the width was chosen gives the products their room back.
    if (typeof w === 'number') cartWidth.value = Math.round(Math.min(Math.max(w, 320), window.innerWidth - 340));
    restored = true;
  });

  effect(() => {
    // A custom colour rides as its own variable and wins over whichever preset is selected.
    document.documentElement.dataset.accent = accentCustom.value ? 'custom' : accent.value;
    document.documentElement.style.setProperty('--accent-custom', accentCustom.value ?? '');
    if (restored) void setKv('accent', accent.value);
    if (restored) void setKv('accentCustom', accentCustom.value);
  });
  effect(() => {
    document.documentElement.dataset.density = density.value;
    if (restored) void setKv('density', density.value);
  });
  effect(() => {
    document.documentElement.dataset.text = textSize.value;
    if (restored) void setKv('textSize', textSize.value);
  });
  effect(() => {
    document.documentElement.dataset.black = String(trueBlack.value);
    if (restored) void setKv('trueBlack', trueBlack.value);
  });
  effect(() => {
    document.documentElement.dataset.solid = String(solid.value);
    if (restored) void setKv('solid', solid.value);
  });
  effect(() => {
    if (restored) void setKv('sounds', sounds.value);
  });
  effect(() => {
    if (restored) void setKv('haptics', haptics.value);
  });
  effect(() => {
    const w = cartWidth.value;
    // The empty string clears the inline property, so the stylesheet default answers.
    document.documentElement.style.setProperty('--cart-w', w ? `${w}px` : '');
    if (restored) void setKv('cartWidth', w);
  });
}

let restored = false;
