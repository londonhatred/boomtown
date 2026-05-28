/* Festival Planner service worker — offline app shell + runtime cache.
   Bump CACHE version to force clients to pick up a new build. */
const CACHE = "festival-v55";

// App shell — relative paths so it works under /username.github.io/<repo>/
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", (e) => {
  // NB: no skipWaiting() here — let the new worker WAIT so the page can show an
  // "update ready" banner and activate it on the user's tap (see message handler below).
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL))
  );
});

// The page sends this when the user taps "Update" on the banner.
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "skipWaiting") self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Hosts whose assets we want available offline (fonts + Firebase SDK modules).
const RUNTIME_HOSTS = [
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "www.gstatic.com" // firebasejs ESM modules
];

// Data endpoints we must NOT intercept — Firestore keeps its own offline store.
function isData(url) {
  return (
    url.hostname.includes("firestore.googleapis.com") ||
    url.hostname.includes("firebaseio.com") ||
    url.hostname.includes("firebaseinstallations.googleapis.com") ||
    url.hostname.includes("identitytoolkit.googleapis.com") ||
    url.hostname.includes("googleapis.com") && url.pathname.includes("Listen")
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never cache writes
  const url = new URL(req.url);

  if (isData(url)) return; // let Firebase handle its own requests/offline

  // App navigations: network-first, fall back to cached shell when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put("./index.html", copy)).catch(() => {});
        return res;
      }).catch(() => caches.match("./index.html").then((r) => r || caches.match("./")))
    );
    return;
  }

  // Same-origin static assets: cache-first.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => hit))
    );
    return;
  }

  // Fonts + Firebase SDK: stale-while-revalidate so they work offline after first load.
  if (RUNTIME_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req).then((res) => {
          if (res && (res.ok || res.type === "opaque")) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
  }
});

// Show notifications requested by the page (works while a client is alive).
self.addEventListener("message", (event) => {
  const d = event.data || {};
  if (d.type === "notify" && self.registration && self.registration.showNotification) {
    self.registration.showNotification(d.title || "Festival", {
      body: d.body || "",
      icon: "./icon-192.png",
      badge: "./icon-192.png",
      tag: d.tag || undefined
    });
  }
});

// Bring the app to front when a notification is tapped. Honors data.url if the push provided one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      // Prefer focusing an already-open instance, navigating it if needed.
      for (const c of list) {
        if ("focus" in c) {
          if (targetUrl && targetUrl !== "./" && "navigate" in c) { try { c.navigate(targetUrl); } catch(e){} }
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});

// Server-sent push (Web Push from our Cloud Function). Payload shape:
//   { title, body, tag?, url?, kind?, renotify? }
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {
    try { data = { title: "Festival", body: event.data ? event.data.text() : "" }; } catch(_) {}
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Festival", {
      body: data.body || "",
      icon: "./icon-192.png",
      badge: "./icon-192.png",
      tag: data.tag || undefined,        // tag dedupes: same tag silently replaces previous
      renotify: !!data.renotify,
      data: { url: data.url || "./", kind: data.kind || "" }
    })
  );
});
