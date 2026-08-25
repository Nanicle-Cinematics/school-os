"use client";

import { useActionState } from "react";
import { saveSubject, type SubjectState } from "@/lib/subject-actions";
import { SubmitButton } from "../../submit-button";
import { Alert, Field, inputClass } from "../../ui";

export function EditSubjectForm({
  subject,
}: {
  subject: { id: string; name: string; code: string; isCore: boolean; order: number };
}) {
  const [state, formAction] = useActionState<SubjectState, FormData>(saveSubject, {});

  return (
    <form action={formAction} className="p-4">
      <input type="hidden" name="id" value={subject.id} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Name">
          <input
            type="text"
            name="name"
            required
            defaultValue={subject.name}
            className={inputClass}
          />
        </Field>

        <Field label="Code">
          <input
            type="text"
            name="code"
            required
            defaultValue={subject.code}
            className={inputClass}
          />
        </Field>

        <Field label="Order">
          <input
            type="number"
            name="order"
            min={0}
            defaultValue={subject.order}
            className={inputClass}
          />
        </Field>

        <label className="flex items-center gap-2 self-end pb-2 text-sm text-slate-700">
          <input type="checkbox" name="isCore" defaultChecked={subject.isCore} className="h-4 w-4" />
          Core subject
        </label>
      </div>

      {state.error ? (
        <div className="mt-4">
          <Alert tone="error">{state.error}</Alert>
        </div>
      ) : null}
      {state.ok ? (
        <div className="mt-4">
          <Alert tone="success">{state.ok}</Alert>
        </div>
      ) : null}

      <div className="mt-4">
        <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
      </div>
    </form>
  );
}
