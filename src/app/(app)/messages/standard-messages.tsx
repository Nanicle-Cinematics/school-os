"use client";

import { useActionState } from "react";
import { applyStandardMessages, type TemplatesState } from "@/lib/message-actions";
import { Alert, Card } from "../ui";
import { SubmitButton } from "../submit-button";

/**
 * The way back from an empty template table.
 *
 * It lives on this screen rather than in Settings for the reason the fee items
 * do: this is where a school notices — the template picker below says "None",
 * and the receipts it thinks it is sending are the packaged fallback rather than
 * anything it can edit.
 */
export function StandardMessages({ missing, total }: { missing: number; total: number }) {
  const [state, action] = useActionState<TemplatesState, FormData>(applyStandardMessages, {});

  if (missing === 0 && !state.ok) {
    return null;
  }

  return (
    <Card title="Standard messages">
      <div className="space-y-3 p-4">
        {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}
        {state.error ? <Alert tone="error">{state.error}</Alert> : null}

        {missing > 0 ? (
          <p className="text-sm text-slate-700">
            {total === 0
              ? "This school has no saved messages, so there is nothing to start a campaign from, and the receipt a parent gets after paying is the standard wording rather than yours."
              : `${missing} of the standard messages ${missing === 1 ? "is" : "are"} missing — including, possibly, one this school deleted.`}{" "}
            Add them and edit the wording to suit.
          </p>
        ) : null}

        {missing > 0 ? (
          <form action={action}>
            <SubmitButton pendingLabel="Adding…">Add the standard messages</SubmitButton>
          </form>
        ) : null}
      </div>
    </Card>
  );
}
