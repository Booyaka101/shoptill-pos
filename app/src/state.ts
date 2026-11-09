import { computed, effect, signal } from '@preact/signals';
import type { Bootstrap, Product, Register } from './api';
import { emptyCart, totals, type Cart } from './cart';
import type { QueuedOrder } from './db';
import { setKv } from './db';

export type Screen = 'sell' | 'orders' | 'reports' | 'settings';

export const boot = signal<Bootstrap | null>(null);
export const register = signal<Register | null>(null);
export const products = signal<Map<number, Product>>(new Map());
export const cart = signal<Cart>(emptyCart());
/** Set while this tab takes payment, when the sale must not change under it. */
export const checkingOut = signal(false);
/** A sale another tab sent while this one was taking payment, applied once it stops. */
export const heldCart = signal<Cart | null>(null);
export const queue = signal<QueuedOrder[]>([]);
export const online = signal(navigator.onLine);
export const syncing = signal(false);
export const lastSync = signal<number | null>(null);
export const screen = signal<Screen>('sell');
export const theme = signal<'light' | 'dark' | 'system'>('system');
export const toast = signal<{ text: string; kind: 'info' | 'error'; undo?: () => void } | null>(null);
/** Orders waiting to be packed: web orders for staff who move them along, and till sales handed over later. */
export const toPack = signal({ web: 0, later: 0 });
/** Set by the Orders badge, so the list opens on the orders waiting to be packed. */
export const openToPack = signal<'web' | 'later' | null>(null);

export const cartTotals = computed(() => (boot.value ? totals(cart.value, boot.value.tax) : null));
export const pendingCount = computed(() => queue.value.filter((q) => q.status === 'pending').length);
export const failedCount = computed(() => queue.value.filter((q) => q.status === 'failed').length);

export type SaleLine = { product_id?: number; qty: number };

export const stockHolder = (id: number) => products.value.get(id)?.stock_id ?? id;

/** Quantities per stock holder, so variations sharing their parent's stock add up. */
export function stockUse(lines: SaleLine[]) {
  const out = new Map<number, number>();
  for (const l of lines) {
    if (!l.product_id) continue;
    const holder = stockHolder(l.product_id);
    out.set(holder, (out.get(holder) ?? 0) + l.qty);
  }
  return out;
}

/** Quantities sold in sales that haven't reached the shop yet, so offline stock counts stay honest. */
export const reserved = computed(() => stockUse(queue.value.flatMap((q) => (q.payload.lines ?? []) as SaleLine[])));

/** Products the grid shows: simple products and variable parents, never bare variations. */
export const catalogue = computed(() =>
  [...products.value.values()].filter((p) => p.type !== 'variation').sort((a, b) => a.name.localeCompare(b.name)),
);

let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** Says something briefly. An `undo` puts its action behind a link in the toast, and buys it a longer moment. */
export function notify(text: string, kind: 'info' | 'error' = 'info', undo?: () => void) {
  // An error stays up its full time, rather than being covered by news that matters less.
  if (kind === 'info' && toast.value?.kind === 'error') return;
  toast.value = { text, kind, undo };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = null), kind === 'error' || undo ? 6000 : 2500);
}

/** Call once saved state has been loaded, so the empty defaults never overwrite it. */
export function persist() {
  // Other tabs of the till show the same open sale, so a sale paid in one can't be charged again in another.
  const tabs = 'BroadcastChannel' in window ? new BroadcastChannel('shoptill-cart') : null;
  // The cart last taken from another tab, so it isn't sent back. Effects batch their writes, so a flag would be reset too soon.
  let fromTab: Cart | null = null;
  const fromOtherTab = (c: Cart) => {
    fromTab = c;
    cart.value = c;
  };
  tabs?.addEventListener('message', (e: MessageEvent<Cart>) => {
    // Once one change is held, later ones replace it even if they happen to match this tab's sale again.
    if (!checkingOut.value) fromOtherTab(e.data);
    else if (heldCart.value || JSON.stringify(e.data) !== JSON.stringify(cart.value)) heldCart.value = e.data;
  });
  effect(() => {
    const held = heldCart.value;
    if (checkingOut.value || !held) return;
    heldCart.value = null;
    fromOtherTab(held);
  });
  // The open sale survives a reload or a crashed tablet.
  let cartSave: ReturnType<typeof setTimeout> | undefined;
  let first = true;
  effect(() => {
    const value = cart.value;
    if (value !== fromTab && !first) tabs?.postMessage(value);
    first = false;
    clearTimeout(cartSave);
    // An emptied cart is saved at once: a crash just after a sale mustn't bring the sold cart back.
    if (!value.lines.length) void setKv('cart', value);
    else cartSave = setTimeout(() => void setKv('cart', value), 300);
  });
  // The debounce batches a run of taps; a page being closed or replaced mid-batch
  // sends the pending write out with it. Best-effort: a synchronous commit isn't
  // IndexedDB's to give, but the tab staying open a moment longer usually is.
  addEventListener('pagehide', () => {
    clearTimeout(cartSave);
    if (cart.value.lines.length) void setKv('cart', cart.value);
  });

  const media = matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    const t = theme.value;
    document.documentElement.dataset.theme = t === 'dark' || (t === 'system' && media.matches) ? 'dark' : 'light';
  };
  media.addEventListener('change', apply);
  effect(() => {
    apply();
    void setKv('theme', theme.value);
  });
}
