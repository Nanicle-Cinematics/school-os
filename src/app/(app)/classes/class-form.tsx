"use client";

import { useActionState, useState } from "react";
import { saveClassGroup, type ClassState } from "@/lib/class-actions";
import { SubmitButton } from "../submit-button";
import { Alert, Field, inputClass } from "../ui";

export type LevelOption = { id: string; name: string };
export type TeacherOption = { id: string; firstName: string; lastName: string };

type ClassValues = {
  id: string;
  levelId: string;
  name: string;
  capacity: number | null;
  formTeacherId: string | null;
};

function Fields({
  levels,
  teachers,
  values,
}: {
  levels: LevelOption[];
  teachers: TeacherOption[];
  values?: ClassValues;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Level">
        <select name="levelId" required defaultValue={values?.levelId ?? ""} className={inputClass}>
          <option value="" disabled>
            Choose a level
          </option>
          {levels.map((level) => (
            <option key={level.id} value={level.id}>
              {level.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Stream name" hint="Gold, Blue, A — or the level name if there is one class.">
        <input
          type="text"
          name="name"
          required
          defaultValue={values?.name ?? ""}
          placeholder="Gold"
          className={inputClass}
        />
      </Field>

      <Field label="Capacity" hint="Optional. Seats in the room.">
        <input
          type="number"
          name="capacity"
          min={1}
          defaultValue={values?.capacity ?? ""}
          className={inputClass}
        />
      </Field>

      <Field label="Form teacher">
        <select
          name="formTeacherId"
          defaultValue={values?.formTeacherId ?? ""}
          className={inputClass}
        >
          <option value="">Not assigned</option>
          {teachers.map((teacher) => (
            <option key={teacher.id} value={teacher.id}>
              {teacher.firstName} {teacher.lastName}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

function Feedback({ state }: { state: ClassState }) {
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

export function NewClassForm({
  levels,
  teachers,
}: {
  levels: LevelOption[];
  teachers: TeacherOption[];
}) {
  const [state, formAction] = useActionState<ClassState, FormData>(saveClassGroup, {});
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={levels.length === 0}
        className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white shadow-[0_6px_16px_rgba(18,128,92,0.22)] transition hover:bg-brand-700 disabled:opacity-50"
      >
        Add class
      </button>
    );
  }

  return (
    <form action={formAction} className="w-full rounded-xl border border-slate-200 bg-surface p-4 lg:p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Add class</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-sm text-slate-500 hover:text-slate-900"
        >
          Cancel
        </button>
      </div>

      <Fields levels={levels} teachers={teachers} />
      <Feedback state={state} />

      <div className="mt-5">
        <SubmitButton pendingLabel="Saving…">Save class</SubmitButton>
      </div>
    </form>
  );
}

export function EditClassForm({
  levels,
  teachers,
  values,
}: {
  levels: LevelOption[];
  teachers: TeacherOption[];
  values: ClassValues;
}) {
  const [state, formAction] = useActionState<ClassState, FormData>(saveClassGroup, {});

  return (
    <form action={formAction} className="p-4">
      <input type="hidden" name="id" value={values.id} />
      <Fields levels={levels} teachers={teachers} values={values} />
      <Feedback state={state} />
      <div className="mt-4">
        <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
      </div>
    </form>
  );
}
