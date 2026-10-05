const RELEASE_VERSION = '__RELEASE_VERSION__';
const CACHE_NAME = `5e-companion-${RELEASE_VERSION}`;
const CORE_ASSETS = [
  'index.html', 'player.html', '404.html', 'manifest.webmanifest',
  'css/style.css', 'js/pwa.js', 'js/constants.js', 'js/db.js', 'js/peer.js', 'js/dm.js', 'js/player.js',
  'data/srd-5.2-class-features.json', 'data/srd-5.2-equipment.json', 'data/srd-5.2-feats.json',
  'data/srd-5.2-monsters.json', 'data/srd-5.2-species-traits.json', 'data/srd-5.2-spells.json',
  'favicon.ico', 'favicon-180x180.png', 'favicon-192x192.png', 'favicon-512x512.png', 'favicon-32x32.png',
  'img/background_texture.png'
];
const EXTERNAL_ASSETS = [
  'https://cdn.jsdelivr.net/npm/daisyui@4/dist/full.min.css',
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/peerjs@1/dist/peerjs.min.js',
  'https://cdn.jsdelivr.net/npm/qrcode@1/build/qrcode.min.js'
];

const scopeUrl = (path) => new URL(path, self.registration.scope).toString();

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(CORE_ASSETS.map(scopeUrl));
    await Promise.allSettled(EXTERNAL_ASSETS.map(async (url) => {
      const response = await fetch(url, { mode: 'no-cors' });
      if (response.ok || response.type === 'opaque') await cache.put(url, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('5e-companion-') && key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (new URL(event.request.url).origin === self.location.origin || EXTERNAL_ASSETS.includes(event.request.url)) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(event.request, response.clone());
      }
      return response;
    } catch {
      const cached = await caches.match(event.request, { ignoreSearch: true });
      if (cached) return cached;
      if (event.request.mode === 'navigate') return caches.match(scopeUrl('index.html'));
      return Response.error();
    }
  })());
});
