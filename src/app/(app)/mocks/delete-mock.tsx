"use client";

import { useActionState } from "react";
import { deleteMock, type MockState } from "@/lib/mock-actions";
import { SubmitButton } from "../submit-button";

/** Only offered while the mock has no marks; the action refuses otherwise. */
export function DeleteMockForm({ mockExamId }: { mockExamId: string }) {
  const [state, formAction] = useActionState<MockState, FormData>(deleteMock, {});
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="mockExamId" value={mockExamId} />
      <SubmitButton variant="danger" pendingLabel="…">
        Delete
      </SubmitButton>
      {state.error ? <span role="alert" className="text-xs text-danger-ink">{state.error}</span> : null}
    </form>
  );
}
