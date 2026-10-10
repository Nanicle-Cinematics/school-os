"use client";

import { useActionState } from "react";
import { changePlatformPassword, type PlatformPasswordState } from "@/lib/platform-account-actions";
import { Alert, Field, inputClass } from "../../(app)/ui";
import { SubmitButton } from "../../(app)/submit-button";

/** The same three fields as the school-side page, which cannot serve a platform admin. */
export function PlatformPasswordForm() {
  const [state, formAction] = useActionState<PlatformPasswordState, FormData>(changePlatformPassword, {});

  return (
    <form action={formAction} className="space-y-3">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      <Field label="Current password">
        <input name="current" type="password" required autoComplete="current-password" className={inputClass} />
      </Field>

      <Field label="New password">
        <input name="next" type="password" required minLength={8} autoComplete="new-password" className={inputClass} />
      </Field>

      <Field label="New password again">
        <input name="confirm" type="password" required minLength={8} autoComplete="new-password" className={inputClass} />
      </Field>

      <p className="text-xs text-slate-500">At least 8 characters.</p>

      <SubmitButton pendingLabel="Saving…">Save new password</SubmitButton>
    </form>
  );
}
