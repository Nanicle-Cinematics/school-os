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
 * What is cached is ONLY /_next/static/ — the hashed build output. That is what
 * makes the installed app open fast; it is not what makes it work offline, and
 * it does not pretend to. An offline launch shows the browser's offline page,
 * which is honest — nothing in this app renders without the database anyway.
 *
 * ⚠️ Nothing at an UNHASHED url is cached, and the manifest is why.
 *
 * The first version of this file cached /manifest.webmanifest and the icons
 * too. They are static and tiny, so it looked free. It is not: a hashed asset
 * gets a new filename whenever its bytes change, so a cache-first hit can never
 * be stale, while the manifest keeps one url for ever. Adding the install
 * screenshots proved it — Chrome went on reporting a manifest with no
 * screenshots, reading the copy this worker had cached before they existed, and
 * it would have stayed wrong for every already-installed user until the cache
 * name changed. Content-addressed urls only.
 */
const CACHE = "school-os-v2";

self.addEventListener("install", (event) => {
  // Nothing to precache: everything cacheable is hashed, so it is fetched on
  // first use and never needs invalidating.
  event.waitUntil(self.skipWaiting());
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

  // Navigations, server actions, API routes, the manifest and the icons are all
  // left to the network — untouched, uncached. See the notes at the top: the
  // first for why pages are not cached, the second for why unhashed urls are
  // not either.
  if (!url.pathname.startsWith("/_next/static/")) return;

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
