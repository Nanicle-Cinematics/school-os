/**
 * A limiter: at most `max` of the functions passed to the returned `run` are
 * executing at any moment, the rest wait their turn in the order they asked.
 *
 * It exists for work that is mostly slow I/O that CAN overlap, with one step
 * that cannot overlap freely. Sending a campaign is the case: the gateway calls
 * are HTTP and ten at once is fine, but each outcome is a database write, and
 * under RLS every write is a transaction that holds one of the app role's four
 * connections for several round trips. Ten at once fill the whole pool, so any
 * other request on that instance queues behind a campaign, and on a slow link
 * the tail outlasts the pool's 10s checkout timeout (P2024). Wrapping only the
 * write keeps the gateway at ten and the database at a number that leaves a
 * connection spare.
 *
 * Plain functions only — no `server-only`, no Prisma — so a verify script can
 * exercise it without a database.
 */
export function createLimiter(max: number) {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`a limiter needs a whole number of at least 1, got ${max}`);
  }

  let active = 0;
  const waiting: (() => void)[] = [];

  async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) {
      // Hand over the slot rather than release and re-take it: the waiter is
      // resumed already holding it, so `active` never dips below the real count
      // and a newcomer cannot jump the queue in the gap.
      await new Promise<void>((resume) => waiting.push(resume));
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) {
        next();
      } else {
        active -= 1;
      }
    }
  }

  return run;
}
