import { signal } from '@preact/signals';
import { api, ApiError, config, setToken, setUnauthorizedHandler, NetworkError, type Bootstrap, type Order, type Product, type User } from './api';
import { emptyCart, type Cart } from './cart';
import { normalizeBootstrap } from './bootstrap';
import { db, delKv, delKvIf, forgetUser, getKv, setKv, type QueuedOrder } from './db';
import { setCurrency } from './money';
import { boot, cart, lastSync, notify, online, products, queue, register, stockHolder, stockUse, syncing, theme, toPack, type SaleLine } from './state';

export const signedIn = signal<boolean | null>(null);
/** Server order numbers for sales that synced this session, so an open receipt can show its number. */
export const synced = signal<Record<string, { id: number; number: string }>>({});
/** The server runs a newer build of the till than this page. */
export const updateReady = signal(false);

let clockSkew = 0;
/** The shop's clock, so a tablet set a few minutes out doesn't make its sales look late, or early. */
export const shopNow = () => Math.floor(Date.now() / 1000) + clockSkew;

const FLUSH_EVERY = 15_000;
const STOCK_EVERY = 60_000;
const CATALOGUE_EVERY = 5 * 60_000;

function markOnline(ok: boolean) {
  if (online.value !== ok) online.value = ok;
}

/** Runs an API call, tracking connectivity from the outcome rather than trusting navigator.onLine. */
async function track<T>(p: Promise<T>): Promise<T> {
  try {
    const result = await p;
    markOnline(true);
    return result;
  } catch (e) {
    markOnline(!(e instanceof NetworkError));
    throw e;
  }
}

function applyBootstrap(raw: Bootstrap) {
  const b = normalizeBootstrap(raw);
  boot.value = b;
  updateReady.value = !!b.version && config.version !== 'dev' && b.version !== config.version;
  setCurrency(b.currency);
  const current = register.value && b.registers.find((r) => r.id === register.value!.id);
  if (register.value && !current) register.value = null;
  else if (current) register.value = current;
}

export async function restore() {
  setUnauthorizedHandler(() => void signOut(false));
  const [token, b, reg, savedCart, savedTheme, since, skew] = await Promise.all([
    getKv<string>('token'),
    getKv<Bootstrap>('bootstrap'),
    getKv<Bootstrap['registers'][number]>('register'),
    getKv<Cart>('cart'),
    getKv<typeof theme.value>('theme'),
    getKv<number>('lastSync'),
    getKv<number>('clockSkew'),
  ]);
  if (savedTheme) theme.value = savedTheme;
  clockSkew = skew ?? 0;
  await loadQueue();
  // Kept when signed out too, or the first save would wipe the open sale.
  if (savedCart) cart.value = savedCart;
  if (!token || !b) {
    signedIn.value = false;
    return;
  }
  setToken((ours = token));
  register.value = reg ?? null;
  applyBootstrap(b);
  lastSync.value = since ?? null;
  await loadProducts();
  signedIn.value = true;
}

async function loadProducts() {
  const all = await (await db()).getAll('products');
  products.value = new Map(all.map((p) => [p.id, p]));
}

// Bumped when the user changes, so a sync started for the last one stops before it writes anything.
let session = 0;
let running: Promise<void> | null = null;
let runningFull = false;
// The token this tab signed in with. Another tab may have signed someone else in since.
let ours: string | null = null;

export async function signIn(username: string, password: string) {
  session++;
  newestWebOrder = null;
  const device = `${navigator.platform || 'Device'} till`.trim();
  const { token } = await track(api.login(username, password, device));
  setToken((ours = token));
  const b = await track(api.bootstrap());
  while (running) await running.catch(() => {});
  // A different user on this device starts from a clean cache; unsynced and parked sales stay.
  const previous = await getKv<Bootstrap>('bootstrap');
  if (previous && previous.user.id !== b.user.id) {
    await forgetUser();
    products.value = new Map();
    lastSync.value = null;
    cart.value = emptyCart();
  }
  await setKv('token', token);
  await setKv('bootstrap', b);
  // Asks the browser not to evict the queue of unsynced sales when the device runs short of space.
  void navigator.storage?.persist?.().catch(() => false);
  applyBootstrap(b);
  if (!register.value && b.registers.length === 1) chooseRegister(b.registers[0]);
  signedIn.value = true;
  // Signed in either way, so a catalogue that fails to download doesn't leave the cashier at the sign-in screen.
  void syncCatalogue(true).catch((e) => notify(`The products could not be downloaded: ${e instanceof Error ? e.message : e}. The till will try again.`, 'error'));
  void flushQueue();
  void pollToPack().catch(() => {});
}

export function chooseRegister(r: Bootstrap['registers'][number]) {
  register.value = r;
  void setKv('register', r);
}

export async function signOut(callServer = true) {
  session++;
  const previous = ours;
  // Capture the old credentials before clearing them, but don't keep the till signed in while logout waits.
  const logout = callServer ? api.logout().catch(() => {}) : Promise.resolve();
  setToken(null);
  ours = null;
  signedIn.value = false;
  toPack.value = { web: 0, later: 0 };
  await Promise.all([logout, previous ? delKvIf('token', previous) : Promise.resolve()]);
}

export function currentUser(): User | null {
  return boot.value?.user ?? null;
}

/**
 * Full sync on first run or when asked, otherwise only products changed since the last sync plus a
 * prune of anything deleted or unpublished.
 */
export function syncCatalogue(full = false): Promise<void> {
  // A full sync asked for during a quick one runs after it, rather than being answered by it.
  if (running && full && !runningFull) return running.catch(() => {}).then(() => syncCatalogue(true));
  if (!running) {
    runningFull = full;
    running = download(full).finally(() => (running = null));
  }
  return running;
}

async function download(full: boolean) {
  const mine = session;
  const stock = stockTaken;
  const current = () => {
    if (session !== mine) throw new Error('The user changed during the product sync.');
  };
  syncing.value = true;
  try {
    editedDuringSync.clear();
    const b = await track(api.bootstrap());
    current();
    // A new plugin version can add product fields the cached catalogue doesn't have. Forgetting the
    // last sync, rather than passing full, keeps it a full download until one gets through.
    if (boot.value && boot.value.version !== b.version) {
      lastSync.value = null;
      await delKv('lastSync');
      current();
    }
    clockSkew = b.server_time - Math.floor(Date.now() / 1000);
    await setKv('clockSkew', clockSkew);
    current();
    await setKv('bootstrap', b);
    current();
    applyBootstrap(b);

    const since = full || !lastSync.value ? undefined : lastSync.value - 120;
    const downloaded: Product[] = [];
    for (let after: number | null = 0; after !== null; ) {
      current();
      const res: { products: Product[]; next_after: number | null } = await track(api.products(after, since));
      downloaded.push(...res.products);
      if (res.next_after !== null && res.next_after <= after) throw new Error('The shop sent the same page of products twice.');
      after = res.next_after;
    }
    const live = full ? null : new Set(await track(api.productIds()));
    const d = await db();
    current();
    // After the last request, so an edit saved at this till while any of them ran wins over what they fetched.
    const fetched = downloaded.map((p) => editedDuringSync.get(p.id) ?? p);
    const next = full ? new Map<number, Product>() : new Map(products.value);
    for (const p of fetched) next.set(p.id, p);
    if (live) for (const id of next.keys()) if (!live.has(id)) next.delete(id);

    // Only what changed is written, so a delta sync on a big catalogue stays cheap.
    const tx = d.transaction('products', 'readwrite');
    if (full) await tx.store.clear();
    else await Promise.all([...products.value.keys()].filter((id) => !next.has(id)).map((id) => tx.store.delete(id)));
    await Promise.all((full ? [...next.values()] : fetched.filter((p) => next.has(p.id))).map((p) => tx.store.put(p)));
    await tx.done;
    current();

    // And any saved while those writes ran.
    for (const [id, p] of editedDuringSync) if (next.has(id)) next.set(id, p);
    products.value = next;
    lastSync.value = b.server_time;
    await setKv('lastSync', b.server_time);
    // A sale that synced meanwhile may be missing from the stock downloaded, and was taken off what this replaced.
    if (stockTaken !== stock) await pollStock().catch(() => {});
  } finally {
    syncing.value = false;
  }
}

// Null until the first look, so the orders already waiting at sign-in aren't announced.
let newestWebOrder: number | null = null;
let packPolls = 0;

/** Keeps the count of web orders to pack, and says when a new one comes in. */
export async function pollToPack() {
  const mine = session;
  // Only the newest poll's count is shown, however the replies come back.
  const poll = ++packPolls;
  const [web, later] = await Promise.all([
    boot.value?.user.can_manage_orders ? track(api.orders('', 1, 'web', 'processing')) : null,
    track(api.orders('', 1, 'later', 'processing')),
  ]);
  if (session !== mine || poll !== packPolls) return;
  toPack.value = { web: web?.total ?? 0, later: later.total };
  if (!web) return;
  const { orders } = web;
  const newest = orders.reduce((a, o) => (o.id > a.id ? o : a), orders[0]);
  if (newest && newestWebOrder !== null && newest.id > newestWebOrder) notify(`New web order #${newest.number} to pack.`);
  newestWebOrder = Math.max(newestWebOrder ?? 0, newest?.id ?? 0);
}

// Edits saved while a sync was downloading, which may have fetched the product before the edit.
const editedDuringSync = new Map<number, Product>();

// Counts synced sales taken off the local stock, so stock read from the shop before one of them is known to be stale.
let stockTaken = 0;

/** Stock changes don't touch a product's modified date, so stock is polled on its own. */
export async function pollStock(): Promise<void> {
  const mine = session;
  const taken = stockTaken;
  const rows = await track(api.stock());
  if (session !== mine) return;
  if (stockTaken !== taken) return pollStock();
  await applyStock(rows);
}

async function applyStock(rows: { id: number; stock_quantity: number | null; stock_status: string }[]) {
  const next = new Map(products.value);
  const changed: Product[] = [];
  for (const row of rows) {
    const p = next.get(row.id);
    if (p && (p.stock_quantity !== row.stock_quantity || p.stock_status !== row.stock_status)) {
      const updated = { ...p, stock_quantity: p.manage_stock ? row.stock_quantity : null, stock_status: row.stock_status };
      next.set(p.id, updated);
      changed.push(updated);
    }
  }
  if (!changed.length) return;
  products.value = next;
  const tx = (await db()).transaction('products', 'readwrite');
  await Promise.all(changed.map((p) => tx.store.put(p)));
  await tx.done;
}

/** A product edited at the till: straight into the catalogue, and into cart lines still at its old price. */
export async function saveEdited(p: Product) {
  if (syncing.value) editedDuringSync.set(p.id, p);
  const old = products.value.get(p.id);
  products.value = new Map(products.value).set(p.id, p);
  await (await db()).put('products', p);
  if (old && p.price !== null && old.price !== p.price) {
    cart.value = {
      ...cart.value,
      lines: cart.value.lines.map((l) => (l.productId === p.id && l.price === l.listPrice ? { ...l, price: p.price!, listPrice: p.price, cost: p.cost ?? undefined } : l)),
    };
  }
  channel?.postMessage('products');
  // Variations sharing the stock changed with it.
  if (p.stock_id && p.stock_id !== p.id) await pollStock().catch(() => {});
}

/** Other tabs of the till share the queue in IndexedDB; this tells them when it changes. */
let channel: BroadcastChannel | null = null;

export async function loadQueue() {
  const all = await (await db()).getAll('queue');
  queue.value = all.sort((a, b) => a.created_at - b.created_at);
  return queue.value;
}

async function queueChanged() {
  await loadQueue();
  channel?.postMessage('queue');
}

/** A sale another tab sent took stock this tab can't see, and its receipt may be open here. */
async function otherTabChanged(data: unknown) {
  const sent = (data as { synced?: typeof synced.value } | null)?.synced;
  if (sent) {
    synced.value = { ...synced.value, ...sent };
    stockTaken++;
  }
  if (sent || data === 'products') await loadProducts();
  await loadQueue();
}

/**
 * Changes one queued sale, or removes it when `change` returns null, and returns it as it was. The
 * transaction starts before the first await, so callers can check other state just before calling.
 */
async function updateQueued(d: Awaited<ReturnType<typeof db>>, clientId: string, change: (q: QueuedOrder) => QueuedOrder | null) {
  const tx = d.transaction('queue', 'readwrite');
  const item = await tx.store.get(clientId);
  const next = item && change(item);
  if (next) await tx.store.put(next);
  else if (item) await tx.store.delete(clientId);
  await tx.done;
  return item;
}

export async function enqueue(order: QueuedOrder) {
  await (await db()).put('queue', order);
  // The sale is saved now; a failure past here must not tell the cashier it wasn't.
  await queueChanged().catch(() => {});
  void flushQueue();
}

let flushing: Promise<void> | null = null;
let again = false;

export function flushQueue() {
  // A sale queued or retried mid-flush missed that pass, so it gets another rather than waiting for the timer.
  if (flushing) again = true;
  flushing ??= (async () => {
    try {
      do {
        again = false;
        // One flush at a time across tabs too, so two tabs never send the same sale at once. A failed pass
        // leaves the queue for the next one.
        await (navigator.locks ? navigator.locks.request('shoptill-flush', doFlush) : doFlush()).catch(() => {});
      } while (again);
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

/** Takes a synced sale off the local stock, which would otherwise look free again until the next poll. */
async function takeStock(lines: SaleLine[]) {
  stockTaken++;
  const used = stockUse(lines);
  const rows = [...products.value.values()]
    .filter((p) => p.manage_stock && p.stock_quantity !== null && used.has(stockHolder(p.id)))
    .map((p) => ({ id: p.id, stock_quantity: p.stock_quantity! - used.get(stockHolder(p.id))!, stock_status: p.stock_status }));
  await applyStock(rows);
}

async function doFlush() {
  const d = await db();
  // Another tab may have sent some of these already.
  await loadQueue();
  const taken = stockTaken;
  let waits = false;
  for (const item of queue.value.filter((q) => q.status === 'pending')) {
    try {
      const order: Order | null = await track(api.createOrder(item.payload));
      if (!order?.id) throw new ApiError('The shop sent back an empty reply.', 502, 'empty_reply');
      synced.value = { ...synced.value, [item.client_id]: { id: order.id, number: order.number } };
      const sent = await updateQueued(d, item.client_id, () => null);
      // Off the queue and onto the stock in the same tick, so the sale is never counted twice or not at all.
      queue.value = queue.value.filter((q) => q.client_id !== item.client_id);
      await takeStock((item.payload.lines ?? []) as SaleLine[]);
      waits ||= !!item.payload.fulfil;
      channel?.postMessage({ synced: { [item.client_id]: synced.value[item.client_id] } });
      const to = sent?.email_to;
      if (to) {
        api.email(order.id, to).then(
          () => notify(`Receipt for order #${order.number} emailed to ${to}.`),
          (e) => notify(`The receipt for order #${order.number} could not be emailed: ${e instanceof Error ? e.message : e}. Send it again from Orders.`, 'error'),
        );
      }
    } catch (e) {
      // Only ShopTill's own refusals are final; a 5xx, proxy page or security plugin block may clear up.
      const refused = e instanceof ApiError && e.status >= 400 && e.status < 500 && ![401, 429].includes(e.status) && e.code.startsWith('shoptill_') && e.code !== 'shoptill_in_progress';
      const error = e instanceof Error ? e.message : String(e);
      await updateQueued(d, item.client_id, (q) => ({ ...q, status: refused ? 'failed' : 'pending', error, attempts: q.attempts + 1 }));
      if (refused) notify(`A sale could not be saved: ${error}`, 'error');
      // Keep the reason on the queued sale even when nothing else will get through this pass.
      if (!(e instanceof ApiError) || [401, 429].includes(e.status)) break;
    }
  }
  await queueChanged();
  // A sale saved on an earlier try whose reply was lost may already be in the stock this took it off.
  if (stockTaken !== taken) await pollStock().catch(() => {});
  if (waits) await pollToPack().catch(() => {});
}

export async function retryQueued(clientId: string) {
  if (!(await updateQueued(await db(), clientId, (q) => ({ ...q, status: 'pending', error: undefined })))) return;
  await queueChanged();
  await flushQueue();
}

export async function discardQueued(clientId: string) {
  await (await db()).delete('queue', clientId);
  await queueChanged();
}

/** Emails a sale's receipt now if the sale has reached the shop, otherwise once it does. True when sent now. */
export async function emailReceipt(clientId: string, email: string) {
  const d = await db();
  // No await between this check and the update: a flush either sees the address or has already marked the sale synced.
  const saved = synced.value[clientId];
  if (saved) {
    await api.email(saved.id, email);
    return true;
  }
  if (!(await updateQueued(d, clientId, (q) => ({ ...q, email_to: email })))) throw new Error('This sale is already saved to the shop. Email it from Orders.');
  await queueChanged();
  return false;
}

let started = false;

export function startBackgroundSync() {
  if (started) return;
  started = true;
  const quietly = (fn: () => Promise<unknown>) => () => void fn().catch(() => {});
  // With nothing to send a flush makes no request, and the till would read offline until the next poll.
  window.addEventListener('online', quietly(() => flushQueue().then(pollStock)));
  window.addEventListener('offline', () => markOnline(false));
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel('shoptill');
    channel.onmessage = (e) => quietly(() => otherTabChanged(e.data))();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') quietly(flushQueue)();
  });
  setInterval(() => {
    if (signedIn.value && queue.value.some((q) => q.status === 'pending')) quietly(flushQueue)();
  }, FLUSH_EVERY);
  setInterval(() => signedIn.value && (quietly(pollStock)(), quietly(pollToPack)()), STOCK_EVERY);
  // Stock taken while the catalogue downloads would otherwise be overwritten until the next poll.
  setInterval(() => signedIn.value && quietly(() => syncCatalogue().then(pollStock))(), CATALOGUE_EVERY);
  if (signedIn.value) {
    quietly(flushQueue)();
    quietly(() => syncCatalogue().then(pollStock))();
    quietly(pollToPack)();
  }
}
