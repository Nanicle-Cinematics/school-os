"use client";

import { useActionState, useState } from "react";
import { createSchool, type PlatformState } from "@/lib/platform-actions";

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-slate-400">{hint}</span> : null}
    </label>
  );
}

export function NewSchoolForm() {
  const [state, formAction] = useActionState<PlatformState, FormData>(createSchool, {});
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
      >
        Add a school
      </button>
    );
  }

  return (
    <form action={formAction} className="w-full rounded-xl border border-slate-200 bg-white p-4 lg:p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Provision a school</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-sm text-slate-500 hover:text-slate-900"
        >
          Cancel
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="School name">
          <input
            type="text"
            name="name"
            required
            placeholder="St. Mary's Preparatory & JHS"
            className={inputClass}
          />
        </Field>

        <Field label="URL key" hint="Left blank, it is derived from the name.">
          <input type="text" name="slug" placeholder="st-marys-prep" className={inputClass} />
        </Field>

        <Field label="Short name" hint="Report cards and the SMS sender ID.">
          <input type="text" name="shortName" maxLength={11} placeholder="STMARY" className={inputClass} />
        </Field>

        <Field label="Plan">
          <select name="plan" defaultValue="TRIAL" className={inputClass}>
            <option value="TRIAL">Trial (30 days)</option>
            <option value="STARTER">Starter</option>
            <option value="GROWTH">Growth</option>
            <option value="SCHOOL_PLUS">School Plus</option>
          </select>
        </Field>

        <Field label="Assessment weighting" hint="Rescales every mark — get it right now.">
          <select name="weighting" defaultValue="50" className={inputClass}>
            <option value="50">Basic school — 50% class, 50% exam</option>
            <option value="30">SHS — 30% class, 70% exam</option>
          </select>
        </Field>

        <div />

        <Field label="Proprietor's name">
          <input type="text" name="ownerName" required placeholder="Nana Kwabena Osei" className={inputClass} />
        </Field>

        <Field label="Proprietor's email" hint="This is the login. A temporary password is generated.">
          <input type="email" name="ownerEmail" required placeholder="head@school.edu.gh" className={inputClass} />
        </Field>
      </div>

      {state.error ? (
        <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p role="alert" className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
          {state.ok}
        </p>
      ) : null}

      <div className="mt-5">
        <SubmitButton />
      </div>
      <p className="mt-2 text-xs text-slate-400">
        Creates the school, a default grading scale, its settings and the proprietor&rsquo;s login in
        one transaction.
      </p>
    </form>
  );
}

function SubmitButton() {
  return (
    <button
      type="submit"
      className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
    >
      Provision school
    </button>
  );
}
