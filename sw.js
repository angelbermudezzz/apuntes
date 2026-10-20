// Guarda la app en el móvil para que abra rápido y también sin internet.
// Al cambiar la app, sube el número para que se renueve todo junto.
const CACHE = "apuntes-v4";
const CORE = ["./", "index.html", "styles.css", "app.js", "manifest.webmanifest", "icon.svg", "icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE.map(u => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
const withTimeout = (p, ms) => new Promise((res, rej) => { setTimeout(() => rej(new Error("timeout")), ms); p.then(res, rej); });
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname === "generativelanguage.googleapis.com") return; // Gemini nunca se guarda
  if (url.origin === location.origin) {
    // Primero internet (para tener la última versión), pero si tarda más de 3 s, la copia guardada.
    const net = fetch(req).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return r;
    });
    e.waitUntil(net.catch(() => {}));
    e.respondWith(withTimeout(net, 3000).catch(async () => {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === "navigate") return (await caches.match("index.html")) || net;
      return net;
    }));
    return;
  }
  if (/cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.(googleapis|gstatic)\.com/.test(url.hostname)) {
    // Librerías y tipografías: no cambian, así que la copia guardada sirve.
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
      if (r.ok || r.type === "opaque") { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return r;
    })));
  }
});
