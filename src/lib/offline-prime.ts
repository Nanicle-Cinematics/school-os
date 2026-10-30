/**
 * Make the offline register openable with no signal. Browser only.
 *
 * The service worker keeps a copy of /attendance-offline when it is fetched,
 * but a page is its scripts too, and those are only cached when something asks
 * for them. Opening the page while online would do it; this does it without
 * opening the page, by fetching the page's own HTML and then every build file
 * that HTML names. All of it goes through the service worker, which caches
 * /_next/static/ on the way past (public/sw.js).
 *
 * Once per browser session (a new deploy is picked up the next morning): it is a dozen small files, and the
 * attendance page is opened every morning.
 */
const SHELL = "/attendance-offline";

const wait = (ms: number) => new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));

/**
 * Wait until the service worker is running AND in charge of this page. The
 * first time anyone opens the app the worker registers after the page has
 * loaded, so a fetch made at once goes past it and nothing is cached; priming
 * then would silently do nothing, and the first offline morning would find an
 * empty cache. In dev there is no worker, so this gives up rather than hang.
 */
async function workerInCharge() {
  const registration = await Promise.race([navigator.serviceWorker.ready, wait(20_000)]);
  if (!registration) return false;
  if (navigator.serviceWorker.controller) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 10_000);
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      { once: true },
    );
  });
}

export async function primeOfflinePage() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    if (sessionStorage.getItem("offline-primed")) return;
  } catch {
    // sessionStorage can throw in a private window; priming again is harmless.
  }
  try {
    if (!(await workerInCharge())) return;
    const response = await fetch(SHELL, { credentials: "omit" });
    if (!response.ok) return;
    const html = await response.text();
    const files = new Set<string>();
    for (const match of html.matchAll(/\/?(?:_next\/)?(static\/(?:chunks|css|media)\/[^"'\\\s<>)]+)/g)) {
      files.add(`/_next/${match[1]}`);
      if (files.size >= 60) break;
    }
    await Promise.all([...files].map((file) => fetch(file, { credentials: "omit" }).catch(() => {})));
    try {
      sessionStorage.setItem("offline-primed", "1");
    } catch {
      // as above
    }
  } catch {
    // Offline or blocked: nothing to prime, and nothing to tell anyone.
  }
}
