import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueuedOrder } from '../../src/db';

const mocks = vi.hoisted(() => ({ rows: new Map<string, QueuedOrder>(), createOrder: vi.fn() }));
vi.mock('../../src/api', async (original) => ({
  ...await original<typeof import('../../src/api')>(),
  api: { createOrder: mocks.createOrder },
}));
vi.mock('../../src/db', () => ({
  db: async () => ({
    getAll: async () => [...mocks.rows.values()],
    transaction: () => ({
      store: {
        get: async (id: string) => mocks.rows.get(id),
        put: async (q: QueuedOrder) => { mocks.rows.set(q.client_id, q); },
        delete: async (id: string) => { mocks.rows.delete(id); },
      },
      done: Promise.resolve(),
    }),
  }),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('window', {});
  mocks.rows.clear();
  for (const id of ['first', 'second']) {
    mocks.rows.set(id, { client_id: id, payload: { client_id: id }, status: 'pending', attempts: 0, created_at: 1, receipt: {} as QueuedOrder['receipt'] });
  }
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllTimers(); });

describe('queued sale failure diagnostics', () => {
  it.each(['network', 'unauthorized', 'rate limited'])('records %s failures without losing the sale or sending the next one', async (kind) => {
    const { ApiError, NetworkError } = await import('../../src/api');
    const error = kind === 'network' ? new NetworkError('Connection lost') : new ApiError(kind, kind === 'unauthorized' ? 401 : 429, 'shoptill_auth');
    mocks.createOrder.mockRejectedValue(error);
    const { flushQueue } = await import('../../src/sync');
    await flushQueue();
    expect(mocks.createOrder).toHaveBeenCalledTimes(1);
    expect(mocks.rows.get('first')).toMatchObject({ status: 'pending', attempts: 1, error: error.message });
    expect(mocks.rows.get('second')).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it.each([
    [400, 'shoptill_stock', 'failed'],
    [409, 'shoptill_in_progress', 'pending'],
    [403, 'http_error', 'pending'],
    [503, 'shoptill_unavailable', 'pending'],
  ])('classifies %s %s as %s and keeps the payload', async (status, code, expected) => {
    const { ApiError } = await import('../../src/api');
    mocks.createOrder.mockRejectedValue(new ApiError('Try again', status, code));
    const { flushQueue } = await import('../../src/sync');
    await flushQueue();
    expect(mocks.rows.get('first')).toMatchObject({ status: expected, attempts: 1, error: 'Try again', payload: { client_id: 'first' } });
  });
});
