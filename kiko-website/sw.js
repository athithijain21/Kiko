/* KIKO offline helper (service worker).
   Keeps the Playroom's own files on the device, so KIKO opens even without internet
   after the first visit. KIKO's brain (the model) is stored separately by the AI runtime. */
const CACHE = "kiko-20261109093937";
const CORE = [
  "./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png",
  "static/kiko-brain.js", "static/brain-data.json",
  "kiko/content.json", "kiko/content_hi.json", "kiko/content_kn.json",
  "static/fonts/fredoka-latin-500-normal.woff2", "static/fonts/fredoka-latin-600-normal.woff2",
  "static/fonts/andika-latin-400-normal.woff2", "static/fonts/andika-latin-700-normal.woff2",
  "static/fonts/baloo-2-devanagari-500-normal.woff2", "static/fonts/baloo-2-devanagari-700-normal.woff2",
  "static/fonts/baloo-tamma-2-kannada-500-normal.woff2", "static/fonts/baloo-tamma-2-kannada-700-normal.woff2",
  "static/wllama/index.js", "static/wllama/wasm/wllama.wasm",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(CORE.map(u => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("kiko-") && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Speed: browsers only let KIKO's brain use several processor cores when the page is
// "cross-origin isolated". GitHub Pages can't send those settings, so this helper adds them.
// "credentialless" still allows the brain download from Hugging Face.
function isolate(r){
  if (!r || r.type === "opaque" || r.status === 0) return r;
  const h = new Headers(r.headers);
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Embedder-Policy", "credentialless");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(r.body, {status: r.status, statusText: r.statusText, headers: h});
}

// Our own files: show the saved copy straight away, and quietly refresh it when online.
// Other sites (like the model download from Hugging Face) pass straight through.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (e.request.cache === "only-if-cached" && e.request.mode !== "same-origin") return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const saved = await c.match(e.request, {ignoreSearch: true});
    const fresh = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => saved);
    return isolate(saved || await fresh);
  }));
});
