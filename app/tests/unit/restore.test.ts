import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Bootstrap } from '../../src/api';

const saved = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../src/db', () => ({
  getKv: async (key: string) => saved.get(key),
  db: async () => ({ getAll: async () => [] }),
}));
vi.stubGlobal('window', {});

afterAll(() => vi.unstubAllGlobals());

describe('restoring cached bootstrap', () => {
  it('publishes recovered categories to app state before showing Sell', async () => {
    const category = { id: 7, name: 'Dairy', parent: 0 };
    const raw = {
      categories: { 7: category },
      registers: [{ id: 'main', name: 'Main', outlet: '' }],
      currency: { code: 'ZAR', symbol: 'R', position: 'left', decimals: 2, decimal_separator: '.', thousand_separator: ',' },
    } as unknown as Bootstrap;
    saved.set('token', 'cached-token');
    saved.set('bootstrap', raw);
    saved.set('register', raw.registers[0]);
    const { restore, signedIn } = await import('../../src/sync');
    const { boot, register } = await import('../../src/state');
    await restore();
    expect(signedIn.value).toBe(true);
    expect(boot.value?.categories.filter((c) => c.id === 7)).toEqual([category]);
    expect(register.value).toEqual(raw.registers[0]);
  });
});
