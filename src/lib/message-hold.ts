/**
 * The hold on a campaign: a few minutes between pressing Send and the texts going to the gateway, during which
 * it can be cancelled.
 *
 * Pure, with no `server-only`, so the send action, the page's countdown and the verify script read the SAME
 * numbers. A text cannot be recalled once the gateway has it, so the only way to "unsend" is to not have sent
 * yet: the campaign is saved as SCHEDULED, nothing leaves, and it is released when the hold runs out.
 */

/** How long a held campaign waits. The school asked for five minutes. */
export const HOLD_MINUTES = 5;
export const HOLD_MS = HOLD_MINUTES * 60_000;

/** When a campaign pressed at `now` is released. */
export function releaseAt(now: Date): Date {
  return new Date(now.getTime() + HOLD_MS);
}

/**
 * Milliseconds until `scheduledAt`, never negative. The page counts down with this and the server re-checks with
 * it, because the two clocks can disagree by a few seconds and a countdown that reaches zero early must be
 * told to wait rather than send early.
 */
export function msUntil(scheduledAt: Date | string, now: Date = new Date()): number {
  return Math.max(0, new Date(scheduledAt).getTime() - now.getTime());
}

export function isDue(scheduledAt: Date | string | null | undefined, now: Date = new Date()): boolean {
  return Boolean(scheduledAt) && msUntil(scheduledAt as Date | string, now) === 0;
}

/** "4:32", for the countdown. */
export function countdownLabel(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
