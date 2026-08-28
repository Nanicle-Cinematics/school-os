"use client";

import { useActionState } from "react";
import { openSheet, type SheetState } from "@/lib/sheet-actions";
import { SubmitButton } from "../../submit-button";
import { Alert } from "../../ui";

export function OpenSheetForm({
  termId,
  classGroupId,
  subjectId,
  label = "Open the sheet",
}: {
  termId: string;
  classGroupId: string;
  subjectId: string;
  label?: string;
}) {
  const [state, formAction] = useActionState<SheetState, FormData>(openSheet, {});

  return (
    <div>
      <form action={formAction}>
        <input type="hidden" name="termId" value={termId} />
        <input type="hidden" name="classGroupId" value={classGroupId} />
        <input type="hidden" name="subjectId" value={subjectId} />
        <SubmitButton variant="secondary" pendingLabel="Opening…">
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
