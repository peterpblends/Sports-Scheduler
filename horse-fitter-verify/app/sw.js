// Offline app shell. Same-origin app files: network first (so updates arrive
// whenever there's a connection), falling back to the cache when offline.
// Never cached: the sync API (/api/) and the mat proxy (/mat/); cross-origin
// requests (the mat at 10.0.0.1, a remote sync server) pass straight through.
const CACHE = "hfv-shell-v1";
const SHELL = [
  "./", "./index.html", "./manifest.webmanifest", "./css/app.css",
  "./js/app.js", "./js/analysis.js", "./js/demo.js", "./js/heatmap.js", "./js/mat.js", "./js/store.js", "./js/sync.js",
  "./icons/icon.svg", "./icons/icon-180.png", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/maskable-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith("hfv-shell-") && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== "GET" || u.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope);
  const rel = u.pathname.slice(scope.pathname.length);
  if (rel.startsWith("api/") || rel.startsWith("mat/")) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 4000);
      const res = await fetch(req, { signal: ctl.signal });
      clearTimeout(to);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === "navigate") return (await cache.match("./index.html")) || Response.error();
      return Response.error();
    }
  })());
});

// Background Sync (Chromium): when connectivity returns, wake any open page to sync.
self.addEventListener("sync", e => {
  if (e.tag !== "hfv-sync") return;
  e.waitUntil(self.clients.matchAll({ type: "window" }).then(cs => cs.forEach(c => c.postMessage("sync"))));
});
