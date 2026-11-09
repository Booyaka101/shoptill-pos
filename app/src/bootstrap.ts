import type { Bootstrap } from './api';

/** PHP arrays with gaps in their keys arrive as objects, including in older cached bootstraps. */
export function normalizeBootstrap(raw: Bootstrap): Bootstrap {
  const value: unknown = raw.categories;
  const categories = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
  return {
    ...raw,
    categories: categories.filter((c): c is Bootstrap['categories'][number] =>
      !!c && typeof c === 'object' && Number.isInteger(c.id) && typeof c.name === 'string' && Number.isInteger(c.parent),
    ),
  };
}
