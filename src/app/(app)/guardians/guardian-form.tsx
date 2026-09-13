"use client";

import { useActionState, useState } from "react";
import { buttonClass } from "../button-style";
import { saveGuardian, type GuardianState } from "@/lib/guardian-actions";
import { SubmitButton } from "../submit-button";
import { Alert, Field, inputClass } from "../ui";

export type GuardianValues = {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  altPhone: string | null;
  email: string | null;
  occupation: string | null;
  address: string | null;
  gpsAddress: string | null;
  idType: string | null;
  idNumber: string | null;
};

function Fields({ values }: { values?: GuardianValues }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Field label="First name">
        <input
          type="text"
          name="firstName"
          required
          defaultValue={values?.firstName ?? ""}
          className={inputClass}
        />
      </Field>

      <Field label="Surname">
        <input
          type="text"
          name="lastName"
          required
          defaultValue={values?.lastName ?? ""}
          className={inputClass}
        />
      </Field>

      <Field label="Phone" hint="Receives bills and results by SMS.">
        <input
          type="tel"
          name="phone"
          required
          placeholder="0244123456"
          defaultValue={values?.phone ?? ""}
          className={inputClass}
        />
      </Field>

      <Field label="Alternate phone">
        <input
          type="tel"
          name="altPhone"
          defaultValue={values?.altPhone ?? ""}
          className={inputClass}
        />
      </Field>

      <Field label="Email">
        <input type="email" name="email" defaultValue={values?.email ?? ""} className={inputClass} />
      </Field>

      <Field label="Occupation">
        <input
          type="text"
          name="occupation"
          defaultValue={values?.occupation ?? ""}
          className={inputClass}
        />
      </Field>

      <Field label="Address">
        <input
          type="text"
          name="address"
          defaultValue={values?.address ?? ""}
          className={inputClass}
        />
      </Field>

      <Field label="GhanaPost GPS">
        <input
          type="text"
          name="gpsAddress"
          placeholder="GA-123-4567"
          defaultValue={values?.gpsAddress ?? ""}
          className={inputClass}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="ID type">
          <select name="idType" defaultValue={values?.idType ?? ""} className={inputClass}>
            <option value="">—</option>
            <option value="Ghana Card">Ghana Card</option>
            <option value="Voter ID">Voter ID</option>
            <option value="Passport">Passport</option>
            <option value="Driver's Licence">Driver&rsquo;s Licence</option>
          </select>
        </Field>
        <Field label="ID number">
          <input
            type="text"
            name="idNumber"
            defaultValue={values?.idNumber ?? ""}
            className={inputClass}
          />
        </Field>
      </div>
    </div>
  );
}

function Feedback({ state }: { state: GuardianState }) {
  if (!state.error && !state.ok) {
    return null;
  }
  return (
    <div className="mt-4">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}
    </div>
  );
}

export function NewGuardianForm() {
  const [state, formAction] = useActionState<GuardianState, FormData>(saveGuardian, {});
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClass("primary")}
      >
        Add guardian
      </button>
    );
  }

  return (
    <form action={formAction} className="w-full rounded-card border border-hairline bg-surface p-4 lg:p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Add guardian</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-sm text-slate-500 hover:text-slate-900"
        >
          Cancel
        </button>
      </div>

      <Fields />
      <Feedback state={state} />

      <div className="mt-5">
        <SubmitButton pendingLabel="Saving…">Save guardian</SubmitButton>
      </div>
    </form>
  );
}

export function EditGuardianForm({ values }: { values: GuardianValues }) {
  const [state, formAction] = useActionState<GuardianState, FormData>(saveGuardian, {});

  return (
    <form action={formAction} className="p-4">
      <input type="hidden" name="id" value={values.id} />
      <Fields values={values} />
      <Feedback state={state} />
      <div className="mt-4">
        <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
      </div>
    </form>
  );
}
