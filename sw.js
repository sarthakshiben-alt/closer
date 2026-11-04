/* Closer service worker.
   Strategy: precache the whole app shell, serve cache-first. The app has no
   server and no network calls of its own, so once it's installed it works
   permanently offline. Bump CACHE when you redeploy or phones keep the old one. */

const CACHE = "closer-v3";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./app.css",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // Never cache auth or database traffic — stale auth tokens are a nightmare.
  if (req.url.includes("supabase.co")) return;

  // Navigations: serve the shell so deep links and cold starts work offline.
  if (req.mode === "navigate") {
    event.respondWith(
      caches.match("./index.html").then((hit) => hit || fetch(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          // Cache same-origin successes so a later offline run has them.
          if (res && res.status === 200 && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
    })
  );
});
