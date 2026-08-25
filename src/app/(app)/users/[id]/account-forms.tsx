"use client";

import { useActionState } from "react";
import type { Role } from "@prisma/client";
import { resetUserPassword, updateUserRoles, type UserState } from "@/lib/user-actions";
import { SubmitButton } from "../../submit-button";
import { Alert } from "../../ui";
import { RoleChecklist } from "../account-form";

export function RolesForm({
  userId,
  roles,
  selected,
  privileged,
  canGrantPrivileged,
}: {
  userId: string;
  roles: Role[];
  selected: Role[];
  privileged: Role[];
  canGrantPrivileged: boolean;
}) {
  const [state, formAction] = useActionState<UserState, FormData>(updateUserRoles, {});

  return (
    <form action={formAction} className="space-y-4 p-4">
      <input type="hidden" name="userId" value={userId} />

      <RoleChecklist
        roles={roles}
        selected={selected}
        privileged={privileged}
        canGrantPrivileged={canGrantPrivileged}
      />

      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}

      <SubmitButton pendingLabel="Saving…">Save roles</SubmitButton>
    </form>
  );
}

export function ResetPasswordForm({ userId }: { userId: string }) {
  const [state, formAction] = useActionState<UserState, FormData>(resetUserPassword, {});

  return (
    <form action={formAction} className="space-y-3 p-4">
      <input type="hidden" name="userId" value={userId} />

      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton variant="secondary" pendingLabel="Resetting…">
          Reset password
        </SubmitButton>
        <p className="text-xs text-slate-500">
          Generates a new temporary password and signs them out everywhere.
        </p>
      </div>
    </form>
  );
}
