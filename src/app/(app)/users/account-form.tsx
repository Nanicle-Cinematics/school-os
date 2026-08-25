"use client";

import { useActionState, useState } from "react";
import type { Role } from "@prisma/client";
import { roleLabel } from "@/lib/permissions";
import { createUserAccount, type UserState } from "@/lib/user-actions";
import { SubmitButton } from "../submit-button";
import { Alert, Field, inputClass } from "../ui";

export type StaffOption = {
  id: string;
  staffNo: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
};

export function RoleChecklist({
  roles,
  selected,
  privileged,
  canGrantPrivileged,
}: {
  roles: Role[];
  selected?: Role[];
  privileged: Role[];
  canGrantPrivileged: boolean;
}) {
  return (
    <fieldset>
      <legend className="mb-1.5 block text-sm font-medium text-slate-700">Roles</legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {roles.map((role) => {
          const locked = privileged.includes(role) && !canGrantPrivileged;
          return (
            <label
              key={role}
              className={`flex items-center gap-2 text-sm ${
                locked ? "text-slate-400" : "text-slate-700"
              }`}
              title={locked ? "Only a proprietor or head can grant this role." : undefined}
            >
              <input
                type="checkbox"
                name="roles"
                value={role}
                defaultChecked={selected?.includes(role)}
                disabled={locked}
                className="h-4 w-4"
              />
              {roleLabel(role)}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function NewAccountForm({
  staff,
  roles,
  privileged,
  canGrantPrivileged,
}: {
  staff: StaffOption[];
  roles: Role[];
  privileged: Role[];
  canGrantPrivileged: boolean;
}) {
  const [state, formAction] = useActionState<UserState, FormData>(createUserAccount, {});
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<StaffOption | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={staff.length === 0}
        title={staff.length === 0 ? "Every member of staff already has a login." : undefined}
        className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
      >
        Create login
      </button>
    );
  }

  return (
    <form action={formAction} className="w-full rounded-xl border border-slate-200 bg-white p-4 lg:p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Create login</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-sm text-slate-500 hover:text-slate-900"
        >
          Cancel
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Staff member">
          <select
            name="staffId"
            required
            defaultValue=""
            onChange={(event) =>
              setPicked(staff.find((person) => person.id === event.target.value) ?? null)
            }
            className={inputClass}
          >
            <option value="" disabled>
              Choose
            </option>
            {staff.map((person) => (
              <option key={person.id} value={person.id}>
                {person.lastName}, {person.firstName} · {person.staffNo}
              </option>
            ))}
          </select>
        </Field>

        {/* Prefilled from the staff record but editable — the number on file is
            often the school's, not one they can receive a reset on. */}
        <Field label="Email">
          <input
            key={`email-${picked?.id ?? "none"}`}
            type="email"
            name="email"
            defaultValue={picked?.email ?? ""}
            className={inputClass}
          />
        </Field>

        <Field label="Phone" hint="Either one can be used to sign in.">
          <input
            key={`phone-${picked?.id ?? "none"}`}
            type="tel"
            name="phone"
            placeholder="0244123456"
            defaultValue={picked?.phone ?? ""}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="mt-4">
        <RoleChecklist
          roles={roles}
          privileged={privileged}
          canGrantPrivileged={canGrantPrivileged}
        />
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
        <SubmitButton pendingLabel="Creating…">Create login</SubmitButton>
      </div>
      <p className="mt-2 text-xs text-slate-400">
        A temporary password is generated and shown once, here, after saving.
      </p>
    </form>
  );
}
