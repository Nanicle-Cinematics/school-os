import { createLimiter, LimiterFull } from "@/lib/concurrency";

/**
 * What an UNAUTHENTICATED route may spend, in one place.
 *
 * `/api/school-icon` and `/api/manifest` are public on purpose (a browser fetches a manifest, and the
 * OS an icon, without cookies; see `schoolIconUrls`), and each answers a request with a database
 * lookup. The app role has FOUR connections and, under RLS, every query holds one for several round
 * trips, so a stranger sending requests faster than they finish does not merely slow these routes:
 * it can queue the whole site behind them until Prisma's pool times out (P2024 on a page a head
 * teacher is using). A real school's icon also costs a decode and a PNG-9 encode, and the CDN caches
 * by the FULL url, so appending a random `?v=` makes every request a cold one.
 *
 * A rate limit per address does not hold on serverless, where there is no shared memory to count
 * in. What does hold is bounding the WORK: at most `PUBLIC_LOOKUPS` of these run at once on an
 * instance, which leaves two of the four connections for everything else; a short queue absorbs the
 * burst a real install makes (the manifest and three icons arrive together); and anything past that
 * is turned away at once with a 503 rather than parked holding a socket.
 *
 * Plain functions, no Prisma and no `server-only`, so a verify script can exercise it.
 */
export const PUBLIC_LOOKUPS = 2;
export const PUBLIC_QUEUE = 8;

const gate = createLimiter(PUBLIC_LOOKUPS, { maxWaiting: PUBLIC_QUEUE });

/** Run one public lookup inside the budget. Throws `LimiterFull` when the queue is full. */
export function publicLookup<T>(task: () => Promise<T>): Promise<T> {
  return gate(task);
}

export const isBusy = (error: unknown) => error instanceof LimiterFull;

/** Turned away, not failed: a caller that retries in a few seconds is served. Never cached. */
export const busyResponse = () =>
  new Response("Busy, try again shortly", {
    status: 503,
    headers: { "Retry-After": "5", "Cache-Control": "no-store" },
  });

/**
 * Whether a string could be a school's id. A cuid is 25 characters; this is looser on purpose (an id
 * format can change) and still turns away empty strings, paths, spaces, and megabytes of junk before
 * any of it reaches a query or a log line. It is NOT a defence against a guessed id (an attacker can
 * write one that fits); the budget above is.
 */
export const looksLikeSchoolId = (value: string) => /^[A-Za-z0-9_-]{8,40}$/.test(value);

/**
 * A miss is worth remembering: a school with no crest, or an id that is not a school, answers the
 * same next time. Five minutes, public, so the CDN absorbs repeats of the same url. Safe because the
 * url that points here is minted only once a crest exists, and carries a new `?v=` when it changes.
 */
export const MISS_CACHE_CONTROL = "public, max-age=300, s-maxage=300";
