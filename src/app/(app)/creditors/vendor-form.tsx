"use client";

import { useActionState, useState } from "react";
import { buttonClass } from "../button-style";
import { saveVendor, type ActionState } from "@/lib/vendor-actions";
import { SubmitButton } from "../submit-button";
import { Alert, Field, inputClass } from "../ui";

export function VendorForm() {
  const [state, formAction] = useActionState<ActionState, FormData>(saveVendor, {});
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={buttonClass("secondary")}>
        Add vendor
      </button>
    );
  }

  return (
    <form action={formAction} className="w-full rounded-card border border-hairline bg-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Add vendor</h2>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-slate-500 hover:text-slate-900">
          Cancel
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input type="text" name="name" required placeholder="e.g. Adom Electricals" className={inputClass} />
        </Field>
        <Field label="Contact person">
          <input type="text" name="contactPerson" className={inputClass} />
        </Field>
        <Field label="Phone">
          <input type="text" name="phone" className={inputClass} />
        </Field>
        <Field label="Note">
          <input type="text" name="note" className={inputClass} />
        </Field>
      </div>

      {state.error ? (
        <div className="mt-3">
          <Alert tone="error">{state.error}</Alert>
        </div>
      ) : null}
      {state.ok ? (
        <div className="mt-3">
          <Alert tone="success">{state.ok}</Alert>
        </div>
      ) : null}

      <div className="mt-3">
        <SubmitButton pendingLabel="Saving…">Save vendor</SubmitButton>
      </div>
    </form>
  );
}
