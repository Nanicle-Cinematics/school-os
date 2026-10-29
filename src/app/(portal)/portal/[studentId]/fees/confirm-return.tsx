"use client";

import { useEffect, useState } from "react";
import { confirmOnlinePayment } from "@/lib/online-payment-actions";
import { Alert } from "@/app/(app)/ui";

function Info({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="rounded-card border border-hairline bg-surface p-4 text-sm text-slate-700 shadow-card">
      {children}
    </p>
  );
}

type View = "checking" | "paid" | "waiting" | "failed" | "problem";

const TRIES = 8;
const GAP_MS = 4000;

/**
 * Where a parent lands after Paystack. It asks the server whether the payment has gone through, which
 * verifies with Paystack and books it if so, and keeps asking for about half a minute because mobile
 * money confirms only after the parent approves the prompt on their phone.
 */
export function ConfirmReturn({ studentId, reference }: { studentId: string; reference: string }) {
  const [view, setView] = useState<View>("checking");
  const [receipt, setReceipt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let attempt = 0; attempt < TRIES && !cancelled; attempt += 1) {
        try {
          const result = await confirmOnlinePayment(studentId, reference);
          if (cancelled) return;
          if (result.state === "booked" || result.state === "already") {
            setReceipt(result.receiptNo ?? null);
            setView("paid");
            return;
          }
          if (result.state === "failed") {
            setView("failed");
            return;
          }
          if (result.state === "mismatch" || result.state === "unknown" || result.state === "none") {
            setView("problem");
            return;
          }
        } catch {
          /* a dropped connection: try again */
        }
        await new Promise((resolve) => setTimeout(resolve, GAP_MS));
      }
      if (!cancelled) setView("waiting");
    })();
    return () => {
      cancelled = true;
    };
  }, [studentId, reference]);

  if (view === "paid") {
    return (
      <Alert tone="success">
        Payment received{receipt ? ` — receipt ${receipt}` : ""}. Thank you. The balance below is updated.
      </Alert>
    );
  }
  if (view === "failed") {
    return <Alert tone="error">The payment did not go through and you have not been charged. You can try again.</Alert>;
  }
  if (view === "problem") {
    return (
      <Alert tone="error">
        We could not match this payment. If money left your account, contact the school office and quote
        reference {reference}.
      </Alert>
    );
  }
  if (view === "waiting") {
    return (
      <Info>
        We are still waiting for confirmation. If you approved the payment, it will appear below shortly;
        you do not need to pay again. Reference {reference}.
      </Info>
    );
  }
  return <Info>Confirming your payment…</Info>;
}
