"use client";

import { useActionState } from "react";
import { createMock, type MockState } from "@/lib/mock-actions";
import { SubmitButton } from "../submit-button";
import { Alert, Field, inputClass } from "../ui";

export function CreateMockForm({ suggestion }: { suggestion: string }) {
  const [state, formAction] = useActionState<MockState, FormData>(createMock, {});
  return (
    <form action={formAction} className="space-y-3 p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name" hint="As the candidates know it.">
          <input name="title" required maxLength={60} defaultValue={suggestion} className={inputClass} />
        </Field>
        <Field label="First paper sat on" hint="Optional.">
          <input type="date" name="sittingDate" className={inputClass} />
        </Field>
        <div className="flex items-end">
          <SubmitButton pendingLabel="Setting up…">Set up mock</SubmitButton>
        </div>
      </div>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}
    </form>
  );
}
