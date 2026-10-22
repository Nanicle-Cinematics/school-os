"use client";

import { useActionState, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cancelCampaign, releaseCampaignNow, type HoldState } from "@/lib/message-actions";
import { countdownLabel, msUntil } from "@/lib/message-hold";
import { SubmitButton } from "../../submit-button";
import { Alert } from "../../ui";

/**
 * A campaign that is being held: the time left, a Cancel button, and the trigger that sends it when the time is up.
 *
 * The countdown is a convenience and the server is the authority. At zero this asks `releaseCampaignNow`, which
 * checks its OWN clock and the claim: a browser clock a few seconds fast gets "early" and how long to wait, and a
 * second tab or the scheduled job that got there first gets "gone". If this tab is closed nothing is lost: the
 * scheduled job sends it within about ten minutes, and the campaign page shows the truth whenever it is opened.
 */
export function HeldBanner({
  campaignId,
  scheduledAt,
  recipients,
}: {
  campaignId: string;
  /** ISO string: a Date does not survive the trip from the server. */
  scheduledAt: string;
  recipients: number;
}) {
  const router = useRouter();
  const [left, setLeft] = useState(() => msUntil(scheduledAt));
  // The moment it is due, as a clock time rather than a count of seconds removed: a backgrounded tab throttles its
  // timers, and subtracting a second per tick would then show the wrong time left for as long as it stayed hidden.
  const endAt = useRef(new Date(scheduledAt).getTime());
  const [message, setMessage] = useState<string | null>(null);
  const releasing = useRef(false);
  const [cancel, cancelAction] = useActionState<HoldState, FormData>(cancelCampaign, {});

  const release = useCallback(async () => {
    if (releasing.current) return;
    releasing.current = true;
    try {
      const result = await releaseCampaignNow(campaignId);
      if (result.state === "early") {
        // Our clock was ahead of the server's. Wait out the difference, then ask again.
        releasing.current = false;
        endAt.current = Date.now() + result.waitMs;
        setLeft(result.waitMs);
        return;
      }
      if (result.state === "cancelled") setMessage(result.reason);
      router.refresh();
    } catch {
      releasing.current = false;
      setMessage("Could not send just now. It will be retried automatically; reload to see where it stands.");
    }
  }, [campaignId, router]);

  useEffect(() => {
    if (cancel.ok) router.refresh();
  }, [cancel.ok, router]);

  useEffect(() => {
    const tick = () => {
      const remaining = Math.max(0, endAt.current - Date.now());
      setLeft(remaining);
      if (remaining === 0) void release();
    };
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [release]);

  return (
    <div className="rounded-card border border-hairline bg-info-tint p-4 text-info-ink">
      <p className="text-sm font-semibold">
        {left > 0
          ? `Held: sending to ${recipients} ${recipients === 1 ? "person" : "people"} in ${countdownLabel(left)}`
          : "Sending now…"}
      </p>
      <p className="mt-1 text-sm">
        Nothing has gone out yet. Cancel now and nobody is texted. Keep this page open to see it send, or close it: it
        sends on its own.
      </p>
      <form action={cancelAction} className="mt-3 flex flex-wrap items-center gap-3">
        <input type="hidden" name="campaignId" value={campaignId} />
        <SubmitButton variant="danger" pendingLabel="Cancelling…" disabled={left === 0}>
          Cancel sending
        </SubmitButton>
      </form>
      {cancel.error ? (
        <div className="mt-3">
          <Alert tone="error">{cancel.error}</Alert>
        </div>
      ) : null}
      {message ? (
        <div className="mt-3">
          <Alert tone="error">{message}</Alert>
        </div>
      ) : null}
    </div>
  );
}
