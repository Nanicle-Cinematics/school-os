"use client";

import { useActionState, useState } from "react";
import { saveSubject, type SubjectState } from "@/lib/subject-actions";
import { SubmitButton } from "../submit-button";
import { Alert, Field, inputClass } from "../ui";

export function NewSubjectForm({ nextOrder }: { nextOrder: number }) {
  const [state, formAction] = useActionState<SubjectState, FormData>(saveSubject, {});
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg bg-brand-700 px-3 py-2 text-sm font-medium text-white transition hover:bg-brand-800"
      >
        Add subject
      </button>
    );
  }

  return (
    <form action={formAction} className="w-full rounded-xl border border-slate-200 bg-white p-4 lg:p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Add subject</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-sm text-slate-500 hover:text-slate-900"
        >
          Cancel
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Name">
          <input
            type="text"
            name="name"
            required
            placeholder="e.g. Integrated Science"
            className={inputClass}
          />
        </Field>

        <Field label="Code" hint="Heads the broadsheet column.">
          <input type="text" name="code" required placeholder="INT SCI" className={inputClass} />
        </Field>

        <Field label="Order" hint="Position on the report card.">
          <input
            type="number"
            name="order"
            defaultValue={nextOrder}
            min={0}
            className={inputClass}
          />
        </Field>

        <label className="flex items-center gap-2 self-end pb-2 text-sm text-slate-700">
          <input type="checkbox" name="isCore" defaultChecked className="h-4 w-4" />
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

      <div className="mt-5">
        <SubmitButton pendingLabel="Saving…">Save subject</SubmitButton>
      </div>
    </form>
  );
}
