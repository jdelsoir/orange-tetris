/* Orange Tetris — service worker.
 *
 * Strategy map
 *   navigations (HTML) ....... network-first  -> cached shell -> offline.html
 *   css / js / icons ......... cache-first    (safe: see cache busting below)
 *   everything else (GET) .... stale-while-revalidate
 *
 * Cache busting: the version placeholder below is replaced at deploy time (see
 * .github/workflows/deploy.yml) with a content hash of the site's html/css/js.
 * Every deploy therefore produces a NEW cache name, `activate` deletes the old
 * caches, and `install` re-fetches the whole shell with {cache:'reload'} so the
 * HTTP cache (GitHub Pages forces max-age=600) can't hand back stale files.
 * That is what makes cache-first safe on assets whose filenames are not hashed.
 *
 * If that substitution never runs (Pages set to "deploy from a branch", a manual
 * upload, a fork with Actions disabled) the stamp stays unresolved. Rather than
 * pin every visitor to the first css/js they ever fetched, an unstamped worker
 * downgrades assets from cache-first to stale-while-revalidate: worst case one
 * stale load, then fresh. STAMPED is what decides.
 */

const APP = 'orange-tetris';
const BUILD = '__CACHE_VERSION__';
/* The deploy sed rewrites the placeholder above only. Matching on the bare
   marker (no underscores) therefore still detects an unstamped copy. */
const STAMPED = BUILD.indexOf('CACHE_VERSION') === -1 && BUILD.length > 0;
const CACHE = APP + '-v1-' + (STAMPED ? BUILD : 'unstamped');

const OFFLINE_URL = './offline.html';
const SHELL_URL = './index.html';

/* App shell. Relative paths only — the site lives under /orange-tetris/. */
const PRECACHE = [
  './',
  './index.html',
  './offline.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/main.js',
  './js/engine.js',
  './js/render.js',
  './js/ui.js',
  './js/leaderboard.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
  './favicon-32.png',
];

const STATIC_RE = /\.(?:css|js|mjs|png|svg|ico|webp|woff2?)$/i;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // {cache:'reload'} bypasses the HTTP cache so a deploy is picked up at once.
    await cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })));
    // No skipWaiting() here on purpose: the new worker parks in `waiting` until
    // the player presses Reload on the update bar (index.html), which posts
    // SKIP_WAITING below. Taking over on our own would swap the caches and the
    // code out from under the page that is still running the previous build.
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith(APP + '-') && k !== CACHE).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch cross-origin

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req));
  } else if (STATIC_RE.test(url.pathname)) {
    // cache-first is only safe while a deploy rotates the cache name.
    event.respondWith(STAMPED ? cacheFirst(req) : staleWhileRevalidate(req));
  } else {
    event.respondWith(staleWhileRevalidate(req));
  }
});

/* Always try the network for HTML so a new deploy is seen immediately. */
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (keepable(res)) cache.put(SHELL_URL, res.clone()); // one key, no query-string bloat
    return res;
  } catch (err) {
    return (await cache.match(req, { ignoreSearch: true }))
        || (await cache.match(SHELL_URL))
        || (await cache.match(OFFLINE_URL))
        || offlineResponse();
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (keepable(res)) cache.put(req, res.clone());
    return res;
  } catch (err) {
    return offlineResponse();
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => { if (keepable(res)) cache.put(req, res.clone()); return res; })
    .catch(() => cached || offlineResponse());
  return cached || network;
}

function keepable(res) {
  return !!res && res.ok && res.type === 'basic';
}

function offlineResponse() {
  return new Response('Offline', {
    status: 503,
    statusText: 'Offline',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/* The page asks the waiting worker to take over (update-reload prompt). */
self.addEventListener('message', (event) => {
  const data = event.data;
  if (data === 'SKIP_WAITING' || (data && data.type === 'SKIP_WAITING')) self.skipWaiting();
});
