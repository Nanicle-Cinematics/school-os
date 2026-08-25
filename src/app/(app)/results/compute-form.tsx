"use client";

import { useActionState } from "react";
import { computeResults, type ComputeState } from "@/lib/results-actions";
import { SubmitButton } from "../submit-button";
import { Alert } from "../ui";

export function ComputeForm({
  termId,
  classGroupId,
  label = "Compute",
}: {
  termId: string;
  classGroupId: string;
  label?: string;
}) {
  const [state, formAction] = useActionState<ComputeState, FormData>(computeResults, {});

  return (
    <div>
      <form action={formAction}>
        <input type="hidden" name="termId" value={termId} />
        <input type="hidden" name="classGroupId" value={classGroupId} />
        <SubmitButton variant="secondary" pendingLabel="Computing…">
          {label}
        </SubmitButton>
      </form>
      {state.error ? (
        <div className="mt-2">
          <Alert tone="error">{state.error}</Alert>
        </div>
      ) : null}
      {state.ok ? (
        <div className="mt-2">
          <Alert tone="success">{state.ok}</Alert>
        </div>
      ) : null}
    </div>
  );
}
