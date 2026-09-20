/**
 * sw.js — offline cache.
 *
 * The whole app is a handful of small text files and four PNGs, so it is
 * cached outright on install. Once installed the simulator never needs the
 * network again, which is the point: a siren app is no use if it only works
 * where there is signal.
 */

const VERSION = 'siren-remote-v3';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/platform.js',
  './js/audio/engine.js',
  './js/audio/voices.js',
  './js/audio/waves.js',
  './js/audio/tones.js',
  './js/ui/strobe.js',
  './js/ui/guide.js',
  './js/ui/diagrams.js',
  './js/ui/sheets.js',
  './js/ui/waveicons.js',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // addAll is all-or-nothing, so one missing file would leave the app
      // uncached entirely. Each file is added on its own instead.
      //
      // cache: 'reload' bypasses the HTTP cache. Without it an updated build
      // can be "installed" straight from a stale browser cache entry, and the
      // fix the user is waiting for never actually arrives.
      .then((c) => Promise.all(
        SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {}))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  // Cache first: this app has no live data, so the cached copy is always
  // correct and always instant. A background fetch refreshes it for next time.
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
