import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bootstrap, Product } from '../../src/api';

const mocks = vi.hoisted(() => ({ saved: new Map<string, unknown>(), logout: vi.fn(), stock: vi.fn(), setToken: vi.fn() }));
vi.mock('../../src/api', () => ({
  api: { logout: mocks.logout, stock: mocks.stock },
  config: { version: 'dev' },
  setToken: mocks.setToken,
  setUnauthorizedHandler: vi.fn(),
  ApiError: class extends Error {},
  NetworkError: class extends Error {},
}));
vi.mock('../../src/db', () => ({
  getKv: async (key: string) => mocks.saved.get(key),
  delKvIf: async (key: string, value: unknown) => {
    if (mocks.saved.get(key) === value) mocks.saved.delete(key);
  },
  db: async () => ({ getAll: async () => [] }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal('navigator', { onLine: true });
  mocks.saved.clear();
  mocks.saved.set('token', 'old-token');
  mocks.saved.set('bootstrap', {
    categories: [], registers: [],
    currency: { code: 'USD', symbol: '$', position: 'left', decimals: 2, decimal_separator: '.', thousand_separator: ',' },
  } satisfies Partial<Bootstrap>);
});
afterEach(() => vi.unstubAllGlobals());

describe('session boundaries', () => {
  it('signs out immediately and cannot clear a newer login after logout finishes', async () => {
    const wait = deferred<void>();
    mocks.logout.mockReturnValue(wait.promise);
    const sync = await import('../../src/sync');
    await sync.restore();
    const leaving = sync.signOut();
    expect(sync.signedIn.value).toBe(false);
    expect(mocks.setToken).toHaveBeenLastCalledWith(null);

    mocks.saved.set('token', 'new-token');
    await sync.restore();
    wait.resolve();
    await leaving;
    expect(sync.signedIn.value).toBe(true);
    expect(mocks.saved.get('token')).toBe('new-token');
    expect(mocks.setToken).toHaveBeenLastCalledWith('new-token');
  });

  it('ignores stock returned for a session that has signed out', async () => {
    const wait = deferred<{ id: number; stock_quantity: number; stock_status: string }[]>();
    mocks.stock.mockReturnValue(wait.promise);
    const sync = await import('../../src/sync');
    const { products } = await import('../../src/state');
    await sync.restore();
    const polling = sync.pollStock();
    await sync.signOut(false);
    const current = { id: 7, manage_stock: true, stock_quantity: 20, stock_status: 'instock' } as Product;
    products.value = new Map([[7, current]]);
    wait.resolve([{ id: 7, stock_quantity: 1, stock_status: 'instock' }]);
    await polling;
    expect(products.value.get(7)).toBe(current);
  });
});
