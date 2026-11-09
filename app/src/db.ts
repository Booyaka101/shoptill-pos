import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Customer, Product } from './api';

export interface QueuedOrder {
  client_id: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'failed';
  error?: string;
  attempts: number;
  created_at: number;
  /** Local receipt data so a queued sale can be reprinted before it syncs. */
  receipt: Receipt;
  /** Where to email the receipt once the sale reaches the shop. */
  email_to?: string;
}

export interface ParkedCart {
  id: string;
  label: string;
  parked_at: number;
  cart: unknown;
}

/** Everything a receipt needs, built locally at checkout and replaced by the server order once synced. */
export interface Receipt {
  client_id: string;
  number: string | null;
  date: number;
  lines: { name: string; qty: number; unit: number; total: number; discount: number; sku: string; meta: string }[];
  subtotal: number;
  discount: number;
  coupons: { code: string; discount: number }[];
  taxes: { label: string; amount: number }[];
  tax: number;
  total: number;
  prices_include_tax: boolean;
  payments: { method: string; label: string; amount: number; tendered?: number; change?: number }[];
  customer: string;
  email: string;
  note: string;
  register: string;
  cashier: string;
  refunded: number;
  owed?: number;
  fulfil?: { how: 'collect' | 'deliver'; to: string[] };
  /** A delivery charge on the sale, with what it came to in shop price terms. */
  delivery?: { label: string; amount: number };
  fees?: { label: string; amount: number }[];
  /** A reprint, not the receipt handed over with the sale. */
  copy?: boolean;
  /** Leaves out the prices and payments, for a present. */
  gift?: boolean;
}

interface TillDB extends DBSchema {
  kv: { key: string; value: unknown };
  products: { key: number; value: Product; indexes: { parent_id: number } };
  queue: { key: string; value: QueuedOrder };
  parked: { key: string; value: ParkedCart };
  customers: { key: number; value: Customer };
}

let dbPromise: Promise<IDBPDatabase<TillDB>> | null = null;

export function db() {
  // A failed open, or a connection the browser dropped (Safari does), is opened again next time
  // rather than failing every sale until a reload.
  dbPromise ??= openDB<TillDB>('shoptill', 1, {
    upgrade(d, oldVersion) {
      if (oldVersion >= 1) return;
      d.createObjectStore('kv');
      d.createObjectStore('products', { keyPath: 'id' }).createIndex('parent_id', 'parent_id');
      d.createObjectStore('queue', { keyPath: 'client_id' });
      d.createObjectStore('parked', { keyPath: 'id' });
      d.createObjectStore('customers', { keyPath: 'id' });
    },
    terminated() {
      dbPromise = null;
    },
    // A newer build of the till opened in another tab needs this old one out of its way.
    blocking() {
      location.reload();
    },
  }).catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

export async function getKv<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get('kv', key)) as T | undefined;
}

export async function setKv(key: string, value: unknown) {
  await (await db()).put('kv', value, key);
}

export async function delKv(key: string) {
  await (await db()).delete('kv', key);
}

/** An old session must not delete a token another tab or a newer login has saved. */
export async function delKvIf(key: string, value: unknown) {
  const tx = (await db()).transaction('kv', 'readwrite');
  if ((await tx.store.get(key)) === value) await tx.store.delete(key);
  await tx.done;
}

/** Wipes all shop data on this device. Refuses, returning false, while a sale is waiting to sync. */
export async function clearAll() {
  const d = await db();
  const stores = ['kv', 'products', 'parked', 'customers', 'queue'] as const;
  const tx = d.transaction(stores, 'readwrite');
  // Checked in the same transaction, so a sale another tab queues can't slip in before the wipe.
  const empty = !(await tx.objectStore('queue').count());
  if (empty) await Promise.all(stores.map((name) => tx.objectStore(name).clear()));
  await tx.done;
  return empty;
}

/** Drops what one cashier's session left behind. Unsynced and parked sales, the register and the theme belong to the till. */
export async function forgetUser() {
  const tx = (await db()).transaction(['kv', 'products', 'customers'], 'readwrite');
  const kv = tx.objectStore('kv');
  await Promise.all([tx.objectStore('products').clear(), tx.objectStore('customers').clear(), kv.delete('cart'), kv.delete('lastSync')]);
  await tx.done;
}
