const CACHE_NAME = "poker-table-v1";
const APP_SHELL = [
  "/",
  "/index.html",
  "/style.css?v=20260323-6",
  "/client.js?v=20260323-6",
  "/manifest.webmanifest",
  "/offline.html",
  "/icons/app-icon.svg",
  "/icons/app-icon-maskable.svg"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const { request } = event;

  if (request.method !== "GET") {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put("/index.html", cloned));
          return response;
        })
        .catch(() => caches.match(request).then(match => match || caches.match("/offline.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) {
        return cached;
      }
      return fetch(request)
        .then(response => {
          if (request.url.startsWith(self.location.origin)) {
            const cloned = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, cloned));
          }
          return response;
        })
        .catch(() => caches.match("/offline.html"));
    })
  );
});
