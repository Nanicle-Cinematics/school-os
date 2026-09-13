"use client";

import { useActionState, useState } from "react";
import { buttonClass } from "../button-style";
import { saveStaff, type StaffState } from "@/lib/staff-actions";
import { SubmitButton } from "../submit-button";
import { Alert, Field, inputClass } from "../ui";

export type StaffValues = {
  id: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  gender: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  designation: string | null;
  qualification: string | null;
  employmentType: string;
  isTeaching: boolean;
  status: string;
  dateOfBirth: Date | null;
  dateHired: Date | null;
  ssnitNumber: string | null;
  tin: string | null;
};

const EMPLOYMENT = [
  ["FULL_TIME", "Full time"],
  ["PART_TIME", "Part time"],
  ["NATIONAL_SERVICE", "National service"],
  ["CONTRACT", "Contract"],
  ["VOLUNTEER", "Volunteer"],
] as const;

const STATUSES = [
  ["ACTIVE", "Active"],
  ["ON_LEAVE", "On leave"],
  ["SUSPENDED", "Suspended"],
  ["RESIGNED", "Resigned"],
  ["RETIRED", "Retired"],
] as const;

function isoDate(value: Date | null | undefined) {
  return value ? new Date(value).toISOString().slice(0, 10) : "";
}

function Fields({ values }: { values?: StaffValues }) {
  return (
    <>
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

        <Field label="Middle name">
          <input
            type="text"
            name="middleName"
            defaultValue={values?.middleName ?? ""}
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

        <Field label="Gender">
          <select name="gender" required defaultValue={values?.gender ?? ""} className={inputClass}>
            <option value="" disabled>
              Choose
            </option>
            <option value="FEMALE">Female</option>
            <option value="MALE">Male</option>
          </select>
        </Field>

        <Field label="Phone">
          <input
            type="tel"
            name="phone"
            placeholder="0244123456"
            defaultValue={values?.phone ?? ""}
            className={inputClass}
          />
        </Field>

        <Field label="Email">
          <input type="email" name="email" defaultValue={values?.email ?? ""} className={inputClass} />
        </Field>

        <Field label="Designation">
          <input
            type="text"
            name="designation"
            placeholder="Mathematics Teacher"
            defaultValue={values?.designation ?? ""}
            className={inputClass}
          />
        </Field>

        <Field label="Qualification">
          <input
            type="text"
            name="qualification"
            placeholder="B.Ed Mathematics"
            defaultValue={values?.qualification ?? ""}
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

        <Field label="Employment">
          <select
            name="employmentType"
            defaultValue={values?.employmentType ?? "FULL_TIME"}
            className={inputClass}
          >
            {EMPLOYMENT.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Status">
          <select name="status" defaultValue={values?.status ?? "ACTIVE"} className={inputClass}>
            {STATUSES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>

        <label className="flex items-center gap-2 self-end pb-2 text-sm text-slate-700">
          <input
            type="checkbox"
            name="isTeaching"
            defaultChecked={values?.isTeaching ?? true}
            className="h-4 w-4"
          />
          Teaching staff
        </label>

        <Field label="Date of birth">
          <input
            type="date"
            name="dateOfBirth"
            defaultValue={isoDate(values?.dateOfBirth)}
            className={inputClass}
          />
        </Field>

        <Field label="Date hired">
          <input
            type="date"
            name="dateHired"
            defaultValue={isoDate(values?.dateHired)}
            className={inputClass}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="SSNIT no.">
            <input
              type="text"
              name="ssnitNumber"
              defaultValue={values?.ssnitNumber ?? ""}
              className={inputClass}
            />
          </Field>
          <Field label="TIN">
            <input type="text" name="tin" defaultValue={values?.tin ?? ""} className={inputClass} />
          </Field>
        </div>
      </div>
    </>
  );
}

function Feedback({ state }: { state: StaffState }) {
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

export function NewStaffForm() {
  const [state, formAction] = useActionState<StaffState, FormData>(saveStaff, {});
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClass("primary")}
      >
        Add staff
      </button>
    );
  }

  return (
    <form action={formAction} className="w-full rounded-card border border-hairline bg-surface p-4 lg:p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Add staff</h2>
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
        <SubmitButton pendingLabel="Saving…">Save staff</SubmitButton>
      </div>
    </form>
  );
}

export function EditStaffForm({ values }: { values: StaffValues }) {
  const [state, formAction] = useActionState<StaffState, FormData>(saveStaff, {});

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
