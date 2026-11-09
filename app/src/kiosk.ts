/**
 * Kiosk mode: the till as an appliance rather than a web page.
 *
 * Full screen, a screen that never sleeps, no right-click or text dragging, a
 * cursor that disappears while idle, and (optionally) signing out after five
 * minutes untouched so the counter is never left signed in. Everything here is
 * per-device and persisted, because a kiosk is a device, not a browser tab.
 */
import { signal, effect } from '@preact/signals';
import { getKv, setKv } from './db';
import { signOut } from './sync';

export const kiosk = signal(false);
export const idleSignout = signal(false);

const IDLE_CURSOR_MS = 6000;
const IDLE_SIGNOUT_MS = 5 * 60 * 1000;

// -- wake lock: the screen stays on while the till is showing --

let wakeLock: WakeLockSentinel | null = null;

async function keepAwake(on: boolean) {
  try {
    if (on && document.visibilityState === 'visible' && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    // Refused (battery saver, unsupported): the till works, the screen just sleeps.
  }
}

document.addEventListener('visibilitychange', () => keepAwake(kiosk.value));

// -- idle timers --

let cursorTimer = 0;
let signoutTimer = 0;
let idleAt = 0;

const armIdle = () => {
  document.documentElement.classList.remove('cursor-idle');
  clearTimeout(cursorTimer);
  clearTimeout(signoutTimer);
  cursorTimer = window.setTimeout(() => document.documentElement.classList.add('cursor-idle'), IDLE_CURSOR_MS);
  if (idleSignout.value && bootReady()) {
    idleAt = Date.now();
    signoutTimer = window.setTimeout(async () => {
      if (!idleSignout.value || !bootReady()) return;
      await signOut();
    }, IDLE_SIGNOUT_MS);
  }
};

// Any touch, key or mouse movement is the cashier at work.
for (const ev of ['pointerdown', 'pointermove', 'keydown'] as const) {
  document.addEventListener(ev, armIdle, { passive: true });
}

const bootReady = () => !!document.querySelector('.app');

// -- fullscreen --

const inFullscreen = () => !!document.fullscreenElement;

async function goFullscreen() {
  if (inFullscreen() || !kiosk.value) return;
  try {
    await document.documentElement.requestFullscreen();
  } catch {
    // Needs a user gesture; the pointerdown listener below re-arms it.
  }
}

document.addEventListener('fullscreenchange', () => {
  // Leaving fullscreen (Esc, a stray F11) is the one gesture we can't catch as
  // it happens, so the next tap anywhere brings the kiosk back.
  if (kiosk.value && !inFullscreen()) document.addEventListener('pointerdown', goFullscreen, { once: true });
});

// -- gesture blocking --

const isTyping = (e: Event) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
};

document.addEventListener('contextmenu', (e) => kiosk.value && !isTyping(e) && e.preventDefault());
document.addEventListener('selectstart', (e) => kiosk.value && !isTyping(e) && e.preventDefault());
document.addEventListener('dragstart', (e) => kiosk.value && e.preventDefault());

// -- wiring --

export function startKiosk() {
  // Restore first: the persist effects below must not write the default over a
  // kiosk device's saved settings before IndexedDB has answered.
  void Promise.all([getKv<boolean>('kiosk'), getKv<boolean>('idleSignout')]).then(([k, i]) => {
    idleSignout.value = !!i;
    if (k) {
      kiosk.value = true;
      keepAwake(true);
      document.addEventListener('pointerdown', goFullscreen, { once: true });
    }
    restored = true;
  });

  effect(() => {
    const on = kiosk.value;
    document.documentElement.classList.toggle('kiosk', on);
    keepAwake(on);
    if (on) void goFullscreen();
    if (!on && inFullscreen()) void document.exitFullscreen().catch(() => {});
    if (restored) void setKv('kiosk', on);
  });
  effect(() => {
    if (restored) void setKv('idleSignout', idleSignout.value);
  });
  armIdle();
}

let restored = false;
