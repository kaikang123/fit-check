// Offline support.
//
// Deliberately network-first for everything, with the cache only as a
// fallback. A cache-first worker is faster but will happily serve yesterday's
// JavaScript, which is miserable to develop against and worse to debug in the
// wild. Being offline in a shop is the case that matters, and network-first
// handles it just as well — it only costs a round trip when there IS a network.

const VERSION = 'fit-check-v1';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './icon.svg',
  './js/app.js',
  './js/data.js',
  './js/store.js',
  './js/engine.js',
  './js/catalog.js',
  './js/units.js',
  './js/icons.js',
  './js/env.js',
  './js/measure.js',
  './js/body.js',
  './js/bodymath.js',
  './js/scan.js',
  './js/tag.js',
  './js/tagparse.js',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION)
      // A single missing file must not abort the whole install, so add them
      // individually and tolerate failures.
      .then(cache => Promise.allSettled(SHELL.map(url => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then(response => {
        // Only cache real successes; an error page cached as the app shell
        // would be a nasty thing to be stuck with offline.
        if (response.ok) {
          const copy = response.clone();
          caches.open(VERSION).then(cache => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then(hit => hit || caches.match('./index.html'))),
  );
});
