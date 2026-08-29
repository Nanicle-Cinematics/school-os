"use client";

import { useActionState } from "react";
import { createAcademicYear, saveTerm, type TermState } from "@/lib/term-actions";
import { SubmitButton } from "../../submit-button";
import { Alert, Field, inputClass } from "../../ui";

export type TermRow = {
  id: string;
  name: string;
  sequence: number;
  startDate: string;
  endDate: string;
  vacationDate: string;
  nextTermBegins: string;
  isCurrent: boolean;
};

const TERM_LABEL: Record<string, string> = {
  FIRST: "First term",
  SECOND: "Second term",
  THIRD: "Third term",
};

function Feedback({ state }: { state: TermState }) {
  if (!state.error && !state.ok) {
    return null;
  }
  return (
    <div className="mt-2">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}
    </div>
  );
}

export function TermRowForm({ term }: { term: TermRow }) {
  const [state, formAction] = useActionState<TermState, FormData>(saveTerm, {});

  return (
    <li className="border-t border-slate-100 p-4">
      <form action={formAction}>
        <input type="hidden" name="id" value={term.id} />

        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-sm font-medium text-slate-900">
            {TERM_LABEL[term.name] ?? term.name}
          </h3>
          {term.isCurrent ? (
            <span className="rounded bg-brand-600 px-1.5 py-0.5 text-xs font-medium text-white">
              current
            </span>
          ) : null}
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <div className="w-40">
            <Field label="Starts">
              <input
                type="date"
                name="startDate"
                required
                defaultValue={term.startDate}
                className={inputClass}
              />
            </Field>
          </div>
          <div className="w-40">
            <Field label="Ends">
              <input
                type="date"
                name="endDate"
                required
                defaultValue={term.endDate}
                className={inputClass}
              />
            </Field>
          </div>
          <div className="w-40">
            <Field label="Vacates">
              <input
                type="date"
                name="vacationDate"
                defaultValue={term.vacationDate}
                className={inputClass}
              />
            </Field>
          </div>
          <div className="w-40">
            <Field label="Next term begins">
              <input
                type="date"
                name="nextTermBegins"
                defaultValue={term.nextTermBegins}
                className={inputClass}
              />
            </Field>
          </div>
          <SubmitButton variant="secondary" pendingLabel="…">
            Save
          </SubmitButton>
        </div>
      </form>
      <Feedback state={state} />
    </li>
  );
}

export function NewYearForm() {
  const [state, formAction] = useActionState<TermState, FormData>(createAcademicYear, {});

  return (
    <form action={formAction} className="p-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-44">
          <Field label="Year">
            <input
              type="text"
              name="name"
              required
              placeholder="2027/2028"
              className={inputClass}
            />
          </Field>
        </div>
        <div className="w-40">
          <Field label="First day">
            <input type="date" name="startDate" required className={inputClass} />
          </Field>
        </div>
        <div className="w-40">
          <Field label="Last day">
            <input type="date" name="endDate" required className={inputClass} />
          </Field>
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
          <input type="checkbox" name="makeCurrent" className="h-4 w-4" />
          Make current
        </label>
        <SubmitButton pendingLabel="Creating…">Add year</SubmitButton>
      </div>

      <Feedback state={state} />

      <p className="mt-2 text-xs text-slate-400">
        Three terms are created automatically and split evenly across the year. Correct their dates
        afterwards — GES term dates are never exactly even, and the vacation date prints on the
        report card.
      </p>
    </form>
  );
}
