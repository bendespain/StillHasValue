const CACHE = "shv-pickup-v1";
const PRECACHE = [
  "/pickup",
  "/pickup.html",
  "/manifest.webmanifest",
  "/apple-touch-icon.png",
  "/stillhasvalue_logo1024x1024_black.jpg",
  "/stillhasvalue_black_trans.png",
  "/favicon.ico"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(PRECACHE.map((u) => cache.add(u).catch(() => {})))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.pathname === "/api/pickup") {
    return;
  }
  const cacheable =
    url.pathname === "/pickup" ||
    url.pathname === "/pickup.html" ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname === "/apple-touch-icon.png" ||
    url.pathname === "/stillhasvalue_logo1024x1024_black.jpg" ||
    url.pathname === "/stillhasvalue_black_trans.png" ||
    url.pathname === "/favicon.ico";
  if (!cacheable) return;
  event.respondWith(
    caches.match(event.request).then((hit) => {
      if (hit) return hit;
      return fetch(event.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return res;
      });
    })
  );
});
