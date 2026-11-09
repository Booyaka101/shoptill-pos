import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), remove: vi.fn(), transaction: vi.fn() }));
vi.mock('idb', () => ({ openDB: async () => ({ transaction: mocks.transaction }) }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockReturnValue({ store: { get: mocks.get, delete: mocks.remove }, done: Promise.resolve() });
});

describe('conditional token removal', () => {
  it('compares and deletes in the same read/write transaction', async () => {
    const { delKvIf } = await import('../../src/db');
    mocks.get.mockResolvedValue('old-token');
    await delKvIf('token', 'old-token');
    expect(mocks.transaction).toHaveBeenCalledWith('kv', 'readwrite');
    expect(mocks.remove).toHaveBeenCalledWith('token');
  });

  it('keeps the token when another login replaced it', async () => {
    const { delKvIf } = await import('../../src/db');
    mocks.get.mockResolvedValue('new-token');
    await delKvIf('token', 'old-token');
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
