"use client";

import { useActionState } from "react";
import { createGuardianLogin, type GuardianState } from "@/lib/guardian-actions";
import { SubmitButton } from "../../submit-button";
import { Alert, Field, inputClass } from "../../ui";

/**
 * Gives a guardian access to the parent portal.
 *
 * Defaults to the phone number already on the guardian record, because that is
 * what most parents will sign in with — the fields are here so the office can
 * use a different one without editing the guardian first.
 *
 * The temporary password comes back in the success banner and is shown once;
 * there is nowhere to look it up afterwards, same as a staff login.
 */
export function GuardianLoginForm({
  guardianId,
  phone,
  email,
  hasLogin,
  childCount,
}: {
  guardianId: string;
  phone: string | null;
  email: string | null;
  hasLogin: boolean;
  childCount: number;
}) {
  const [state, formAction] = useActionState<GuardianState, FormData>(createGuardianLogin, {});

  if (hasLogin) {
    return (
      <p className="p-4 text-sm text-slate-600">
        This guardian already has a portal login. Use{" "}
        <span className="font-semibold">Users</span> to reset their password or remove access.
      </p>
    );
  }

  if (childCount === 0) {
    return (
      <p className="p-4 text-sm text-slate-500">
        Link a pupil to this guardian first — a portal login with no children
        attached would sign in to an empty page.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-3 p-4">
      <input type="hidden" name="guardianId" value={guardianId} />

      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}

      <p className="text-sm text-slate-600">
        Creates a sign-in for the parent portal, where this guardian can see their
        {childCount === 1 ? " child's" : " children's"} bills, receipts and
        published report cards.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Phone">
          <input name="phone" defaultValue={phone ?? ""} className={inputClass} placeholder="0244123456" />
        </Field>
        <Field label="Email (optional)">
          <input name="email" type="email" defaultValue={email ?? ""} className={inputClass} />
        </Field>
      </div>

      <SubmitButton>Create portal login</SubmitButton>
    </form>
  );
}
