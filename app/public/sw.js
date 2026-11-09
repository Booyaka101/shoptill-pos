// Keeps the till usable offline. The app shell is network-first so a plugin update shows up on the
// next load; hashed build assets and product images are cache-first. The REST API is never cached:
// the app keeps its own data in IndexedDB.
const SHELL = 'shoptill-shell';
const IMAGES = 'shoptill-images';
const MAX_IMAGES = 400;
// Past this a flaky connection is worse than the cached till.
const NAVIGATION_TIMEOUT = 4000;
const scope = self.registration.scope;

const assetUrls = (html, base) =>
  [...html.matchAll(/(?:src|href)="([^"]+\/assets\/[^"]+)"/g)].map((m) => new URL(m[1], base).href);

async function cacheShell(res) {
  if (!res.ok) throw new Error(`shell ${res.status}`);
  const html = await res.clone().text();
  const wanted = new Set(assetUrls(html, scope));
  // A login page, a maintenance page or a hotel wifi portal must never replace a working till.
  if (!wanted.size || !html.includes('window.SHOPTILL=')) throw new Error('not the till');
  const cache = await caches.open(SHELL);
  await Promise.all(
    [...wanted].map(async (url) => {
      if (!(await cache.match(url))) await cache.add(url);
    }),
  );
  await cache.put(scope, res);
  // Drop assets from older builds.
  for (const req of await cache.keys()) {
    if (req.url !== scope && !wanted.has(req.url)) await cache.delete(req);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    fetch(scope, { cache: 'no-store' })
      .then(cacheShell)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.includes('/wp-json/') || url.searchParams.has('rest_route')) return;

  if (req.mode === 'navigate' && req.url.startsWith(scope)) {
    const network = fetch(req);
    // Extended now: once the cached shell has answered a slow load, it's too late to ask.
    event.waitUntil(network.then((res) => res.ok && cacheShell(res.clone())).catch(() => {}));
    event.respondWith(
      (async () => {
        const cached = await caches.match(scope);
        if (!cached) return network;
        const slow = new Promise((resolve) => setTimeout(() => resolve(cached), NAVIGATION_TIMEOUT));
        // A 5xx or a security plugin's block page is no reason to lose a working till.
        // Navigations don't follow redirects in here, so a redirect arrives opaque and the page must still get it.
        const usable = network.then((res) => (res.ok || res.type === 'opaqueredirect' ? res : cached));
        return Promise.race([usable, slow]).catch(() => cached);
      })(),
    );
    return;
  }

  // Only the till's own hashed build assets: the site may have /assets/ paths of its own, and with
  // plain permalinks the worker's scope is the whole home path.
  if (url.pathname.includes('/shoptill/app/assets/')) {
    event.respondWith(caches.match(req).then((hit) => hit ?? fetch(req)));
    return;
  }

  if (req.destination === 'image') {
    event.respondWith(
      caches.open(IMAGES).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        // Opaque cross-origin responses are padded to megabytes of quota each, so they are not kept.
        if (res.ok) {
          event.waitUntil(
            cache
              .put(req, res.clone())
              .then(() => cache.keys())
              .then((keys) => Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_IMAGES)).map((k) => cache.delete(k))))
              .catch(() => {}),
          );
        }
        return res;
      }),
    );
  }
});
