/* service-worker.js */
const VERSION = "ptb-sw-v1.0.0";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-192.png",
  "./icons/maskable-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      await cache.addAll(APP_SHELL);
      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => (k !== VERSION ? caches.delete(k) : Promise.resolve())));
      self.clients.claim();
    })()
  );
});

function isApiRequest(request) {
  try {
    const url = new URL(request.url);
    return url.hostname.includes("api.aladhan.com");
  } catch (_) {
    return false;
  }
}

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const resp = await fetch(request);
    // кэшируем только успешные ответы
    if (resp && resp.ok) {
      cache.put(request, resp.clone());
    }
    return resp;
  } catch (e) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw e;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(request);
  if (cached) return cached;

  const resp = await fetch(request);
  if (resp && resp.ok) cache.put(request, resp.clone());
  return resp;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Только GET
  if (req.method !== "GET") return;

  // API: network-first
  if (isApiRequest(req)) {
    event.respondWith(networkFirst(req));
    return;
  }

  // App shell: cache-first
  event.respondWith(cacheFirst(req));
});
