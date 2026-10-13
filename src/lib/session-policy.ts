/**
 * How long a session lasts, and when it ends.
 *
 * Pure functions and constants, no database and no `server-only`, so a verify script can exercise
 * every rule without a server. `session.ts` and `session-school.ts` both read a session, and both
 * must reach the same verdict, so the verdict lives here once.
 *
 * Two clocks:
 *
 *   absolute  from the day it was issued, never extended. A stolen cookie stops working on this
 *             date however busy the session has been.
 *   idle      from the last time it was used. `Session.expiresAt` IS this deadline: it is pushed
 *             forward as the session is used (at most once every EXTEND_AFTER_MS, so a busy page
 *             does not write on every request) and can never pass the absolute end.
 *
 * Who gets what is a judgement about who is hurt by a forced sign-in:
 *
 *   platform admin  2 h idle, 12 h absolute. The console reads and writes every school, and a
 *                   cookie stolen after the second factor is the most valuable thing in the
 *                   system. There is one such person, and signing in is their job.
 *   staff           7 days idle, 30 absolute. Shared office computers are common, and a session
 *                   left open on one should not last a month. A week covers a weekend and a
 *                   holiday-long break between marking sessions, no longer.
 *   parent only     30 days, unchanged. A parent returns now and then, and a forced sign-in for
 *                   them means a text message to recover the password, which the school pays for.
 *
 * Moving a number here moves it everywhere, and `verify:session-policy` pins each one so it
 * cannot drift by accident.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export type SessionPolicy = { idleMs: number; absoluteMs: number };

export const PLATFORM_POLICY: SessionPolicy = { idleMs: 2 * HOUR, absoluteMs: 12 * HOUR };
export const STAFF_POLICY: SessionPolicy = { idleMs: 7 * DAY, absoluteMs: 30 * DAY };
export const PARENT_POLICY: SessionPolicy = { idleMs: 30 * DAY, absoluteMs: 30 * DAY };

/** Do not push the idle deadline forward for a session used within this long of the last push. */
export const EXTEND_AFTER_MS = 10 * 60 * 1000;

/**
 * Which rules apply to this person. A platform admin first (they belong to no school). Otherwise
 * parent only means EVERY active membership is a parent one; anyone who is also staff anywhere is
 * treated as staff, because the session can reach what staff can.
 */
export function policyFor(who: { isPlatformAdmin: boolean; roles: readonly string[] }): SessionPolicy {
  if (who.isPlatformAdmin) {
    return PLATFORM_POLICY;
  }
  if (who.roles.length > 0 && who.roles.every((role) => role === "PARENT")) {
    return PARENT_POLICY;
  }
  return STAFF_POLICY;
}

/** The idle deadline of a session issued at `createdAt`: the idle span, never past the absolute end. */
export function initialExpiry(createdAt: Date, policy: SessionPolicy): Date {
  return new Date(createdAt.getTime() + Math.min(policy.idleMs, policy.absoluteMs));
}

/**
 * Is this session still good, and should its idle deadline move?
 *
 * Decided from the row alone, so a session issued BEFORE a rule existed is held to it the first time
 * it is read: a 30-day staff row becomes a 7-day-idle one, and a platform admin row older than
 * twelve hours is refused outright. `extendTo` can therefore be EARLIER than the stored deadline
 * (that is how an old, far-off deadline is brought under a new rule), and is null when the stored
 * one is already within EXTEND_AFTER_MS of where it should be.
 */
export function evaluateSession(
  session: { createdAt: Date; expiresAt: Date },
  policy: SessionPolicy,
  now: Date = new Date(),
): { live: boolean; extendTo: Date | null } {
  const absoluteEnd = session.createdAt.getTime() + policy.absoluteMs;
  if (now.getTime() >= absoluteEnd || session.expiresAt.getTime() <= now.getTime()) {
    return { live: false, extendTo: null };
  }
  const target = Math.min(absoluteEnd, now.getTime() + policy.idleMs);
  const moves = Math.abs(target - session.expiresAt.getTime()) > EXTEND_AFTER_MS;
  return { live: true, extendTo: moves ? new Date(target) : null };
}
