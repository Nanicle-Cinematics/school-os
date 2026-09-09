"use client";

import { useActionState } from "react";
import { changePassword, type PasswordState } from "@/lib/account-actions";
import { Alert, Field, inputClass } from "../../(app)/ui";
import { SubmitButton } from "../../(app)/submit-button";

/**
 * Reuses the (app) primitives rather than re-styling three inputs — a second
 * set would drift, which is how the portal ended up shouting FIRST Term.
 *
 * autoComplete hints matter here: without them a password manager offers to
 * save the TEMPORARY password rather than the new one.
 */
export function PasswordForm() {
  const [state, formAction] = useActionState<PasswordState, FormData>(changePassword, {});

  return (
    <form action={formAction} className="space-y-3">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      <Field label="Current password">
        <input
          name="current"
          type="password"
          required
          autoComplete="current-password"
          className={inputClass}
        />
      </Field>

      <Field label="New password">
        <input
          name="next"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          className={inputClass}
        />
      </Field>

      <Field label="New password again">
        <input
          name="confirm"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          className={inputClass}
        />
      </Field>

      <p className="text-xs text-slate-500">At least 8 characters.</p>

      <SubmitButton pendingLabel="Saving…">Save new password</SubmitButton>
    </form>
  );
}
