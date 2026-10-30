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
 * What is cached is /_next/static/ — the hashed build output — and ONE page,
 * the offline register (/attendance-offline). That page is the single exception
 * and it is safe for the reason the rule exists: it renders no data at all. It
 * is the same bytes for every school and every person, has no session, no
 * layout and no school name, and reads the class list from the phone's own
 * IndexedDB (src/lib/offline-store.ts). Caching it writes nobody's data anywhere.
 * ⚠️ Do not widen this to another page, and do not let that page render anything
 * tenant-scoped: it would then be a cached report card by another name.
 *
 * It is served in place of /attendance when the network fails or takes more than
 * 10 seconds (not when the address says ?online=1, which means "I will wait"),
 * and in place of /login (the installed app's start page) when the
 * network fails outright. Everything else offline is still the browser's own
 * offline page, which is honest: nothing else here renders without the database.
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
const CACHE = "school-os-v3";

const SHELL = "/attendance-offline";
/** How long /attendance gets before the phone is assumed to have no usable signal. */
const PAGE_PATIENCE_MS = 10000;
/** The shell itself is small; past this, use the copy already on the phone. */
const SHELL_PATIENCE_MS = 5000;

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

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("slow")), ms));
}

/**
 * Online: always the network's copy, and it refreshes the one on the phone.
 * Offline or slow: the copy on the phone. NETWORK-first, never cache-first —
 * the lesson of the manifest above: a url that keeps its name must not be
 * served stale when the network is there to ask.
 */
async function shell(request) {
  try {
    const response = await Promise.race([fetch(request), timeout(SHELL_PATIENCE_MS)]);
    // Only a clean 200 of the page itself: a redirect (to /login, say) or an
    // error under this key would be served to every offline launch after.
    if (response.ok && !response.redirected) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(SHELL, copy));
    }
    return response;
  } catch (error) {
    const kept = await caches.match(SHELL, { ignoreVary: true });
    if (kept) return kept;
    return fetch(request);
  }
}

/**
 * A page that works with a signal, and hands over to the offline register when
 * it has none. `patience` 0 means only a network FAILURE hands over, never slowness.
 */
async function pageOrShell(request, patience) {
  const network = fetch(request);
  try {
    return patience ? await Promise.race([network, timeout(patience)]) : await network;
  } catch (error) {
    const kept = await caches.match(SHELL, { ignoreVary: true });
    // No copy yet (the phone has never been online on /attendance): keep
    // waiting on the network, or let its own error show.
    return kept || network;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The offline register, and the two doors that lead to it. A full-page load
  // only: the app's own client-side navigations ask for a data payload (they
  // carry an RSC header) and must keep failing visibly rather than be answered
  // with a different page's HTML.
  if (url.pathname === SHELL) {
    event.respondWith(shell(request));
    return;
  }
  if (request.mode === "navigate") {
    if (url.pathname === "/attendance") {
      // ?online=1 is the offline page's "open the full page" link: the person
      // has chosen to wait for the network, so only a failure hands over. Without
      // it a slow connection would send them round in a circle, from the full
      // page to the offline one and back.
      event.respondWith(pageOrShell(request, url.searchParams.has("online") ? 0 : PAGE_PATIENCE_MS));
      return;
    }
    if (url.pathname === "/login") {
      event.respondWith(pageOrShell(request, 0));
      return;
    }
  }

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
