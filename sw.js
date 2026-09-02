const CACHE = "shv-pickup-v5";
const PRECACHE = [
  "/pickup.webmanifest",
  "/pickup-apple-touch-icon.png",
  "/pickup-icon-192.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(PRECACHE.map((u) => cache.add(u).catch(() => {})))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.pathname === "/api/pickup") {
    return;
  }
  const isPickupPage = url.pathname === "/pickup" || url.pathname === "/pickup.html";
  if (isPickupPage) {
    event.respondWith(
      fetch(event.request).then((res) => {
        return res;
      }).catch(() => caches.match(event.request))
    );
    return;
  }
  const cacheable =
    url.pathname === "/pickup.webmanifest" ||
    url.pathname === "/pickup-apple-touch-icon.png" ||
    url.pathname === "/pickup-icon-192.png";
  if (!cacheable) return;
  event.respondWith(
    fetch(event.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((cache) => cache.put(event.request, copy));
      return res;
    }).catch(() => caches.match(event.request))
  );
});
