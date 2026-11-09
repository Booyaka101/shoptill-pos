/**
 * The sale chime: two soft notes when a sale is finished, the sound a shop
 * knows as "money's in the drawer". Browsers keep audio silent until a
 * gesture on the page, and every sale follows a tap, so the context is
 * unlocked by the time it matters. A device that can't play it, or a shop
 * that switched sounds off, just gets the visual.
 */
import { sounds, haptics } from './prefs';

let ctx: AudioContext | null = null;

function note(freq: number, at: number, dur: number) {
  const c = ctx!;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  const t = c.currentTime + at;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.16, t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(gain).connect(c.destination);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

export function saleChime() {
  if (!sounds.value) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    note(880, 0, 0.16);
    note(1174.66, 0.1, 0.3);
  } catch {
    // No audio on this device: the sale is done either way.
  }
  navigator.vibrate?.(30);
}

/** A short tick of a buzz, when an item lands on the sale. Phones only, and only where supported. */
export function addedBuzz() {
  if (!haptics.value) return;
  navigator.vibrate?.(8);
}
