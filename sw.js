// Offline support: always try the network first (so updates show up straight away),
// and fall back to the last cached copy when there's no connection.
// Change this on every release: it's how installed copies notice there's an update.
const CACHE = 'tally-v10';
const SHELL = [
  './',
  'index.html',
  'app.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/db.js',
  'js/nutrition.js',
  'js/off.js',
  'js/ai.js',
  'js/images.js',
  'js/scanner.js',
  'js/cloud.js',
  'vendor/anthropic-sdk.js',
  'vendor/barcode-detector.js',
  'vendor/zxing_reader.wasm',
  'icons/icon-192.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the browser's own cache, so the new version stores the new files.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle this app's own files; Claude and Open Food Facts requests go straight out.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    // 'no-cache' asks the server whether the file changed, so an update never mixes old and new files.
    fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
