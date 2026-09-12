"use client";

import { useActionState, useState } from "react";
import { createAssessment, type AssessmentState } from "@/lib/assessment-actions";
import { SubmitButton } from "../submit-button";
import { Alert, Field, inputClass } from "../ui";

type Option = { id: string; name: string };
type ClassOption = { id: string; name: string; level: { name: string } };
type TermOption = { id: string; sequence: number; academicYear: { name: string } };

export function NewAssessment({
  classGroups,
  subjects,
  terms,
  currentTermId,
}: {
  classGroups: ClassOption[];
  subjects: Option[];
  terms: TermOption[];
  currentTermId?: string;
}) {
  const [state, formAction] = useActionState<AssessmentState, FormData>(createAssessment, {});
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white shadow-[0_6px_16px_rgba(18,128,92,0.22)] transition hover:bg-brand-700"
      >
        New assessment
      </button>
    );
  }

  return (
    <form action={formAction} className="w-full rounded-card border border-hairline bg-surface p-4 lg:p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">New assessment</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-sm text-slate-500 hover:text-slate-900"
        >
          Cancel
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Term">
          <select name="termId" defaultValue={currentTermId ?? ""} className={inputClass} required>
            <option value="" disabled>
              Choose…
            </option>
            {terms.map((term) => (
              <option key={term.id} value={term.id}>
                Term {term.sequence} · {term.academicYear.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Class">
          <select name="classGroupId" className={inputClass} required defaultValue="">
            <option value="" disabled>
              Choose…
            </option>
            {classGroups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.level.name} {group.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Subject">
          <select name="subjectId" className={inputClass} required defaultValue="">
            <option value="" disabled>
              Choose…
            </option>
            {subjects.map((subject) => (
              <option key={subject.id} value={subject.id}>
                {subject.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Type">
          <select name="type" className={inputClass} defaultValue="CLASS_TEST">
            <option value="CLASS_EXERCISE">Class exercise</option>
            <option value="CLASS_TEST">Class test</option>
            <option value="HOMEWORK">Homework</option>
            <option value="PROJECT">Project</option>
            <option value="MIDTERM_EXAM">Mid-term exam</option>
            <option value="END_OF_TERM_EXAM">End of term exam</option>
          </select>
        </Field>

        <Field label="Title">
          <input
            type="text"
            name="title"
            required
            placeholder="e.g. Class Test 2"
            className={inputClass}
          />
        </Field>

        <Field label="Maximum score">
          <input
            type="number"
            name="maxScore"
            defaultValue={100}
            min={1}
            step="0.01"
            className={inputClass}
          />
        </Field>

        <Field
          label="Weight"
          hint="Share of the class score. Leave 0 to weight all items equally."
        >
          <input type="number" name="weight" defaultValue={0} min={0} step="0.01" className={inputClass} />
        </Field>

        <Field label="Due date">
          <input type="date" name="dueDate" className={inputClass} />
        </Field>
      </div>

      {state.error ? (
        <div className="mt-4">
          <Alert tone="error">{state.error}</Alert>
        </div>
      ) : null}

      <div className="mt-5">
        <SubmitButton pendingLabel="Creating…">Create &amp; enter scores</SubmitButton>
      </div>
    </form>
  );
}
