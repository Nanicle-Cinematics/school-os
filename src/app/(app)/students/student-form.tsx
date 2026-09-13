"use client";

import { useActionState, useState } from "react";
import { buttonClass } from "../button-style";
import { admitStudent, saveStudent, type StudentState } from "@/lib/student-actions";
import { SubmitButton } from "../submit-button";
import { Alert, Field, inputClass } from "../ui";

export type ClassOption = { id: string; name: string; level: { name: string } };
export type Option = { id: string; name: string };

export type StudentValues = {
  id: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  gender: string;
  dateOfBirth: Date | null;
  nationality: string | null;
  hometown: string | null;
  religion: string | null;
  language: string | null;
  bloodGroup: string | null;
  allergies: string | null;
  medicalNotes: string | null;
  specialNeeds: string | null;
  previousSchool: string | null;
  residency: string;
  status: string;
  admissionDate: Date | null;
  houseId: string | null;
  programmeId: string | null;
};

const STATUSES = [
  ["ACTIVE", "Active"],
  ["APPLICANT", "Applicant"],
  ["ADMITTED", "Admitted"],
  ["SUSPENDED", "Suspended"],
  ["WITHDRAWN", "Withdrawn"],
  ["TRANSFERRED", "Transferred"],
  ["GRADUATED", "Graduated"],
] as const;

function isoDate(value: Date | null | undefined) {
  return value ? new Date(value).toISOString().slice(0, 10) : "";
}

function Fields({
  houses,
  programmes,
  values,
}: {
  houses: Option[];
  programmes: Option[];
  values?: StudentValues;
}) {
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

      <Field label="Date of birth">
        <input
          type="date"
          name="dateOfBirth"
          defaultValue={isoDate(values?.dateOfBirth)}
          className={inputClass}
        />
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

      <Field label="Residency">
        <select name="residency" defaultValue={values?.residency ?? "DAY"} className={inputClass}>
          <option value="DAY">Day</option>
          <option value="BOARDING">Boarding</option>
        </select>
      </Field>

      <Field label="House">
        <select name="houseId" defaultValue={values?.houseId ?? ""} className={inputClass}>
          <option value="">None</option>
          {houses.map((house) => (
            <option key={house.id} value={house.id}>
              {house.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Programme" hint="SHS course of study.">
        <select name="programmeId" defaultValue={values?.programmeId ?? ""} className={inputClass}>
          <option value="">None</option>
          {programmes.map((programme) => (
            <option key={programme.id} value={programme.id}>
              {programme.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Admission date">
        <input
          type="date"
          name="admissionDate"
          defaultValue={isoDate(values?.admissionDate)}
          className={inputClass}
        />
      </Field>

      <Field label="Previous school">
        <input
          type="text"
          name="previousSchool"
          defaultValue={values?.previousSchool ?? ""}
          className={inputClass}
        />
      </Field>

      <Field label="Nationality">
        <input
          type="text"
          name="nationality"
          defaultValue={values?.nationality ?? "Ghanaian"}
          className={inputClass}
        />
      </Field>

      <Field label="Hometown">
        <input
          type="text"
          name="hometown"
          defaultValue={values?.hometown ?? ""}
          className={inputClass}
        />
      </Field>

      <Field label="Religion">
        <input
          type="text"
          name="religion"
          defaultValue={values?.religion ?? ""}
          className={inputClass}
        />
      </Field>

      <Field label="First language">
        <input
          type="text"
          name="language"
          defaultValue={values?.language ?? ""}
          className={inputClass}
        />
      </Field>

      <Field label="Blood group">
        <input
          type="text"
          name="bloodGroup"
          placeholder="O+"
          defaultValue={values?.bloodGroup ?? ""}
          className={inputClass}
        />
      </Field>

      <Field label="Allergies" hint="A nurse needs this on day one.">
        <input
          type="text"
          name="allergies"
          defaultValue={values?.allergies ?? ""}
          className={inputClass}
        />
      </Field>

      <Field label="Special needs">
        <input
          type="text"
          name="specialNeeds"
          defaultValue={values?.specialNeeds ?? ""}
          className={inputClass}
        />
      </Field>

      <div className="sm:col-span-2 lg:col-span-3">
        <Field label="Medical notes">
          <input
            type="text"
            name="medicalNotes"
            defaultValue={values?.medicalNotes ?? ""}
            className={inputClass}
          />
        </Field>
      </div>
    </div>
  );
}

function Feedback({ state }: { state: StudentState }) {
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

export function AdmitStudentForm({
  classGroups,
  houses,
  programmes,
}: {
  classGroups: ClassOption[];
  houses: Option[];
  programmes: Option[];
}) {
  const [state, formAction] = useActionState<StudentState, FormData>(admitStudent, {});
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClass("primary")}
      >
        Admit student
      </button>
    );
  }

  return (
    <form action={formAction} className="w-full rounded-card border border-hairline bg-surface p-4 lg:p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Admit student</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-sm text-slate-500 hover:text-slate-900"
        >
          Cancel
        </button>
      </div>

      <div className="mb-3">
        <Field label="Class" hint="The admission number is allocated automatically.">
          <select name="classGroupId" defaultValue="" className={inputClass}>
            <option value="">Not placed yet</option>
            {classGroups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.level.name} {group.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Fields houses={houses} programmes={programmes} />

      {/* Captured here rather than left to a second screen: a student with no
          guardian receives no bill, no result and no closing-date notice, and
          nothing later forces anyone to notice. Optional, because the office
          often has the parent's details on a separate form. */}
      <fieldset className="mt-5 border-t border-slate-200 pt-4">
        <legend className="sr-only">Parent or guardian</legend>
        <div className="mb-3 flex items-baseline gap-2">
          <h3 className="text-sm font-semibold text-slate-900">Parent or guardian</h3>
          <span className="text-xs text-slate-400">
            optional — but they receive the bills and the results
          </span>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Full name">
            <input type="text" name="guardianName" placeholder="Kofi Mensah" className={inputClass} />
          </Field>

          <Field label="Phone" hint="A family already on file is matched by this number.">
            <input type="tel" name="guardianPhone" placeholder="0244123456" className={inputClass} />
          </Field>

          <Field label="Relationship">
            <select name="guardianRelationship" defaultValue="GUARDIAN" className={inputClass}>
              <option value="MOTHER">Mother</option>
              <option value="FATHER">Father</option>
              <option value="GRANDPARENT">Grandparent</option>
              <option value="UNCLE">Uncle</option>
              <option value="AUNT">Aunt</option>
              <option value="SIBLING">Sibling</option>
              <option value="GUARDIAN">Guardian</option>
              <option value="OTHER">Other</option>
            </select>
          </Field>
        </div>

        <div className="mt-3 flex flex-wrap gap-4 text-sm text-slate-700">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="guardianReceivesBills" defaultChecked className="h-4 w-4" />
            Receives bills
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="guardianReceivesReports" defaultChecked className="h-4 w-4" />
            Receives results
          </label>
        </div>
      </fieldset>

      <Feedback state={state} />

      <div className="mt-5">
        <SubmitButton pendingLabel="Admitting…">Admit student</SubmitButton>
      </div>
    </form>
  );
}

export function EditStudentForm({
  values,
  houses,
  programmes,
}: {
  values: StudentValues;
  houses: Option[];
  programmes: Option[];
}) {
  const [state, formAction] = useActionState<StudentState, FormData>(saveStudent, {});

  return (
    <form action={formAction} className="p-4">
      <input type="hidden" name="id" value={values.id} />
      <Fields houses={houses} programmes={programmes} values={values} />
      <Feedback state={state} />
      <div className="mt-4">
        <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
      </div>
    </form>
  );
}
