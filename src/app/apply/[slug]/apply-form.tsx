"use client";

import { useState } from "react";
import { buttonClass } from "@/app/(app)/button-style";
import { ApplicationFields, formValues, type Option } from "../application-fields";

/**
 * The parent's form. It posts JSON to `/api/apply/<school>` itself rather than through a form action: a form
 * action resets its fields when it returns, and a refusal over one bad phone number must not wipe the rest
 * of what a parent typed on a phone. Nothing is cleared until the school has said yes.
 */
type Phase =
  | { kind: "filling"; error?: string }
  | { kind: "sending" }
  | { kind: "done"; reference: string; child: string };

export function ApplyForm({
  slug,
  levels,
  years,
}: {
  slug: string;
  levels: Option[];
  years: (Option & { isCurrent?: boolean })[];
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "filling" });

  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = formValues(form);
    setPhase({ kind: "sending" });
    try {
      const response = await fetch(`/api/apply/${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; reference?: string; error?: string };
      if (response.ok && body.reference) {
        setPhase({ kind: "done", reference: body.reference, child: `${values.firstName} ${values.lastName}`.trim() });
        return;
      }
      setPhase({
        kind: "filling",
        error:
          body.error ??
          (response.status === 503
            ? "The school's page is busy. Please wait a moment and press Send again."
            : "That could not be sent. Please try again."),
      });
    } catch {
      setPhase({ kind: "filling", error: "No connection. Check your signal and press Send again; what you typed is still here." });
    }
  }

  if (phase.kind === "done") {
    return (
      <div role="status" className="space-y-3 text-center">
        <p className="font-heading text-xl text-slate-900">Thank you. The school has your application.</p>
        <p className="text-sm text-slate-600">
          {phase.child ? `${phase.child}'s` : "Your"} reference is
        </p>
        <p className="font-heading text-3xl tracking-wide text-brand-ink">{phase.reference}</p>
        <p className="text-sm text-slate-600">
          Keep it, and quote it if you call the school. The office will contact you on the phone number you gave.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={send} className="relative space-y-6">
      <ApplicationFields defaults={{}} levels={levels} years={years} trap />
      {phase.kind === "filling" && phase.error ? (
        <p role="alert" className="rounded-control bg-danger-tint px-3.5 py-2.5 text-sm text-danger-ink">
          {phase.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={phase.kind === "sending"}
        className={buttonClass("primary", "md", "w-full")}
      >
        {phase.kind === "sending" ? "Sending…" : "Send application"}
      </button>
    </form>
  );
}
