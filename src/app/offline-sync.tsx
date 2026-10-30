"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { adoptOwner, listEntries, offlineAvailable } from "@/lib/offline-store";
import { flushQueue, type SyncOutcome } from "@/lib/offline-sync";
import { useOnline } from "@/lib/use-online";

const CHANGED = "school-os:offline-changed";

/** Tell every OfflineSync on the page that the phone's queue has changed. */
export function notifyOfflineChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGED));
}

type Counts = { waiting: number; refused: number };

/**
 * Sends the registers waiting on this phone, and says so.
 *
 * Mounted in the signed-in layout (so a teacher who regains signal anywhere in
 * the app sends what they took) and on the offline page. With nothing queued it
 * does no network and renders nothing, so it costs a signed-in page one read of
 * a small local store.
 *
 * `who` is passed by the signed-in layout and claims the phone for that person
 * first (see `adoptOwner`); the offline page cannot know who is signed in, so it
 * passes nothing and leaves the stored owner as it is.
 */
export function OfflineSync({ who, enabled = true }: { who?: { userId: string; schoolId: string }; enabled?: boolean }) {
  const [counts, setCounts] = useState<Counts>({ waiting: 0, refused: 0 });
  const online = useOnline();
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<SyncOutcome | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const entries = await listEntries();
    setCounts({
      waiting: entries.filter((entry) => entry.status === "queued").length,
      refused: entries.filter((entry) => entry.status === "failed").length,
    });
  }, []);

  const send = useCallback(async () => {
    setSending(true);
    const result = await flushQueue();
    setSending(false);
    if (result.state === "done" && result.saved > 0) {
      setOutcome(result);
      if (clearTimer.current) clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(() => setOutcome(null), 8000);
    } else if (result.state === "signed-out") {
      setOutcome(result);
    }
    await refresh();
  }, [refresh]);

  useEffect(() => {
    if (!enabled || !offlineAvailable()) return;
    let cancelled = false;
    (async () => {
      if (who) await adoptOwner(who);
      if (cancelled) return;
      await refresh();
      if (navigator.onLine) await send();
    })();

    const goOnline = () => void send();
    const changed = () => void refresh();
    window.addEventListener("online", goOnline);
    window.addEventListener(CHANGED, changed);
    // "Online" is what the phone believes; a weak signal can fail a post and
    // come back later without any event, so a waiting queue is retried.
    const retry = setInterval(() => {
      if (navigator.onLine) void send();
    }, 45_000);
    return () => {
      cancelled = true;
      window.removeEventListener("online", goOnline);
      window.removeEventListener(CHANGED, changed);
      clearInterval(retry);
      if (clearTimer.current) clearTimeout(clearTimer.current);
    };
  }, [enabled, who, refresh, send]);

  if (!enabled) return null;

  const plural = (n: number) => `${n} register${n === 1 ? "" : "s"}`;
  let message: React.ReactNode = null;
  let tone = "bg-warning-tint text-warning-ink";

  if (outcome?.state === "done" && outcome.saved > 0) {
    message = `Sent ${plural(outcome.saved)} to the school.`;
    tone = "bg-success-tint text-success-ink";
  } else if (outcome?.state === "signed-out" && counts.waiting > 0) {
    message = (
      <>
        Sign in again to send {plural(counts.waiting)}. {counts.waiting === 1 ? "It is" : "They are"} safe on this
        phone.{" "}
        <a href="/login" className="font-semibold underline underline-offset-2">
          Sign in
        </a>
      </>
    );
  } else if (counts.refused > 0) {
    message = (
      <>
        {plural(counts.refused)} could not be saved.{" "}
        <a href="/attendance" className="font-semibold underline underline-offset-2">
          Open Attendance
        </a>{" "}
        to see why.
      </>
    );
    tone = "bg-danger-tint text-danger-ink";
  } else if (counts.waiting > 0) {
    message = sending
      ? `Sending ${plural(counts.waiting)}…`
      : online
        ? `${plural(counts.waiting)} waiting to send. We will keep trying.`
        : `No signal. ${plural(counts.waiting)} kept on this phone; sent when you are back online.`;
  }

  if (!message) return null;
  return (
    <p
      role="status"
      className={`fixed inset-x-4 bottom-4 z-40 mx-auto max-w-md rounded-control px-3.5 py-2.5 text-sm shadow-card print:hidden ${tone}`}
    >
      {message}
    </p>
  );
}
