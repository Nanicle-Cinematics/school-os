/**
 * Send the registers waiting on this phone. Browser only.
 *
 * One flight at a time (a tab that opens while another is sending must not post
 * the same register twice; the server would shrug, but the result handling
 * would race). Safe to call as often as is convenient: with nothing queued it
 * does no network at all.
 */
import {
  applyResults,
  toSyncItems,
  type SyncResult,
} from "@/lib/offline-register";
import { listEntries, replaceEntries } from "@/lib/offline-store";

export type SyncOutcome =
  | { state: "nothing" }
  | { state: "offline" }
  /** The session has ended: the queue is kept and the teacher must sign in. */
  | { state: "signed-out" }
  /** The server could not be reached or answered with a fault: the queue is kept. */
  | { state: "error" }
  | { state: "done"; saved: number; failed: number; messages: string[] };

let inFlight: Promise<SyncOutcome> | null = null;

export function flushQueue(): Promise<SyncOutcome> {
  if (!inFlight) {
    inFlight = send().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function send(): Promise<SyncOutcome> {
  const entries = await listEntries();
  const items = toSyncItems(entries);
  if (items.length === 0) return { state: "nothing" };
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { state: "offline" };

  let response: Response;
  try {
    response = await fetch("/api/attendance/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items }),
      credentials: "same-origin",
      // A signed-out caller is redirected to /login; following it would hand
      // back a login page as if it were an answer.
      redirect: "manual",
    });
  } catch {
    return { state: "error" };
  }

  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    return { state: "signed-out" };
  }
  if (response.status === 401 || response.status === 403) return { state: "signed-out" };

  let results: SyncResult[];
  try {
    if (!response.ok) {
      // 400s are this phone's fault (a malformed queue); keep it, say so.
      return { state: "error" };
    }
    const body = (await response.json()) as { results?: SyncResult[] };
    if (!Array.isArray(body.results)) return { state: "error" };
    results = body.results;
  } catch {
    return { state: "error" };
  }

  // Apply to what is on the phone NOW, not what was read before the post: the
  // teacher may have kept typing, and applyResults leaves a newer edit alone.
  const fresh = await listEntries();
  await replaceEntries(applyResults(fresh, items, results));

  return {
    state: "done",
    saved: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok && !r.retry).length,
    messages: results.flatMap((r) => (r.ok ? [] : [r.error])),
  };
}
