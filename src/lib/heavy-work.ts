/**
 * A cap on the long transactions: class roll-ups and invoice runs.
 *
 * The app role has FOUR connections per instance, and under RLS a transaction holds one for its whole life. A
 * roll-up or an invoice run holds one for seconds, so a few of them at once (end of term, when every teacher
 * saves their sheet) take the whole pool, and every other request on that instance, a parent's report card
 * included, waits behind them until Prisma's ten-second checkout gives up with P2024. The load test showed
 * exactly that: with the heavy jobs out of the mix the same crowd completed without a failure, and with them in
 * 10% failed while the database sat nearly idle.
 *
 * Two at once leaves two connections for reading. The waiting happens BEFORE the transaction opens, so a queued
 * request holds nothing. The queue is bounded: past a lane's queue the caller is turned away at once with
 * `LimiterFull`, and every caller already knows what to say (a roll-up is derived and can be recomputed, an
 * invoice run can be pressed again).
 *
 * Per INSTANCE, not per school and not global: the pool it protects is per instance too. Kept on `globalThis`
 * because Next can bundle a server action into more than one chunk, and a module-level limiter in each would be
 * two limiters that each allow two.
 *
 * Plain functions only, no Prisma, so a verify script can exercise it without a database.
 */
import { createLimiter } from "@/lib/concurrency";

/**
 * Two lanes of ONE, not one lane of two. With a single shared pair of slots, two invoice runs (about a minute
 * between them on a busy instance) held both, and every teacher saving a sheet behind them waited the whole time:
 * the load test's mark-sheet saves had a median of 3 s and a p95 of 34 s for exactly that reason. A roll-up now
 * has a slot of its own that an invoice run can never take, and the total is still two heavy transactions, which
 * leaves two of the four connections for reading.
 */
export type HeavyLane = "results" | "invoices";
const LANES: Record<HeavyLane, { slots: number; queue: number }> = {
  /** Roll-ups are short now (a fraction of a second) and arrive in crowds at the end of a term. */
  results: { slots: 1, queue: 30 },
  /** An invoice run is long and rare: five schools pressing Generate at once is already a bad day. */
  invoices: { slots: 1, queue: 5 },
};

export const HEAVY_WORK_SLOTS = Object.values(LANES).reduce((n, lane) => n + lane.slots, 0);
export const HEAVY_WORK_QUEUE = LANES;

const shared = globalThis as { __schoolOsHeavyLanes?: Record<HeavyLane, ReturnType<typeof createLimiter>> };
const limits = (shared.__schoolOsHeavyLanes ??= {
  results: createLimiter(LANES.results.slots, { maxWaiting: LANES.results.queue }),
  invoices: createLimiter(LANES.invoices.slots, { maxWaiting: LANES.invoices.queue }),
});

/** Run a long transaction when its lane has a slot. Rejects with `LimiterFull` when too many are already waiting. */
export function heavyWork<T>(lane: HeavyLane, task: () => Promise<T>): Promise<T> {
  return limits[lane](task);
}
