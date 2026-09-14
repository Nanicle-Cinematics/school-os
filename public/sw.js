/**
 * School OS service worker — static assets only, on purpose.
 *
 * ⚠️ It deliberately does NOT cache page navigations, which is the one place
 * this differs from the usual offline-first recipe.
 *
 * Every screen here is a tenant-scoped, signed-in read: a report card, a fee
 * invoice, a family's balance. Putting those HTML responses in the Cache API
 * writes one person's data to the device in a store that outlives their
 * session — and on the shared phone a Ghanaian family actually uses, the next
 * person to open the app could be served it after the cookie is gone. RLS and
 * requireMyChild guard the database; they cannot guard a cache we filled
 * ourselves. So navigations always go to the network.
 *
 * What is cached is what carries no one's data and never changes under a URL:
 * the hashed build output and the app icons. That is what makes the installed
 * app open fast; it is not what makes it work offline, and it does not pretend
 * to. An offline launch shows the browser's offline page, which is honest —
 * nothing in this app renders without the database anyway.
 */
const CACHE = "school-os-v1";
const PRECACHE = ["/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      // A precache miss must not block activation, or one renamed asset leaves
      // every visitor on the previous worker for ever.
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations, server actions and API routes are left to the network —
  // untouched, uncached. See the note at the top.
  const cacheable =
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/manifest.webmanifest";
  if (!cacheable) return;

  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          // Only a clean response is worth keeping; a 404 cached under a build
          // hash would survive the deploy that fixed it.
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
