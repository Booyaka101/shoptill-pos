import { describe, expect, it } from 'vitest';
import type { Bootstrap } from '../../src/api';
import { normalizeBootstrap } from '../../src/bootstrap';

const dairy = { id: 7, name: 'Dairy', parent: 0 };
const fruit = { id: 12, name: 'Fruit', parent: 0 };
const bootstrap = (categories: unknown) => ({ categories, version: 'test' }) as Bootstrap;

describe('bootstrap category lists', () => {
  it('preserves valid categories and other bootstrap fields', () => {
    const raw = bootstrap([dairy, fruit]);
    expect(normalizeBootstrap(raw)).toEqual(raw);
  });

  it('recovers PHP object-shaped category lists without losing the categories', () => {
    const raw = bootstrap({ 7: dairy, 12: fruit });
    const normalized = normalizeBootstrap(raw);
    expect(normalized.categories.filter((c) => c.id === 7)).toEqual([dairy]);
    expect(normalized.categories).toEqual([dairy, fruit]);
    expect(raw.categories).toEqual({ 7: dairy, 12: fruit });
  });

  it('treats missing and invalid category lists as empty', () => {
    for (const value of [undefined, null, {}, 'bad', 42, false]) {
      expect(normalizeBootstrap(bootstrap(value)).categories).toEqual([]);
    }
  });

  it('drops malformed entries before the Sell screen reads them', () => {
    const invalid = [null, 7, 'bad', {}, { ...dairy, id: '7' }, { ...dairy, name: null }, { ...dairy, parent: null }];
    expect(normalizeBootstrap(bootstrap([...invalid, dairy])).categories).toEqual([dairy]);
    expect(normalizeBootstrap(bootstrap({ ...invalid, dairy })).categories).toEqual([dairy]);
  });
});
