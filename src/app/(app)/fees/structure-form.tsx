"use client";

import { useActionState, useState } from "react";
import { saveFeeStructure, type ActionState } from "@/lib/fee-actions";
import { SubmitButton } from "../submit-button";
import { Alert, Field, inputClass } from "../ui";

type Category = { id: string; name: string; code: string };
type Level = { id: string; name: string };
type Term = { id: string; name: string; sequence: number };

export function StructureForm({
  levels,
  categories,
  terms,
  academicYearId,
}: {
  levels: Level[];
  categories: Category[];
  terms: Term[];
  academicYearId: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(saveFeeStructure, {});
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white shadow-[0_6px_16px_rgba(18,128,92,0.22)] transition hover:bg-brand-700"
      >
        New fee structure
      </button>
    );
  }

  return (
    <form
      action={formAction}
      className="w-full rounded-xl border border-slate-200 bg-white p-4 lg:p-5"
    >
      <input type="hidden" name="academicYearId" value={academicYearId} />

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">New fee structure</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-sm text-slate-500 hover:text-slate-900"
        >
          Cancel
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Level">
          <select name="levelId" required className={inputClass} defaultValue="">
            <option value="" disabled>
              Choose…
            </option>
            {levels.map((level) => (
              <option key={level.id} value={level.id}>
                {level.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Term" hint="Leave blank to apply to every term this year.">
          <select name="termId" className={inputClass} defaultValue="">
            <option value="">All terms</option>
            {terms.map((term) => (
              <option key={term.id} value={term.id}>
                Term {term.sequence}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Applies to">
          <select name="residency" className={inputClass} defaultValue="ANY">
            <option value="ANY">Day and boarding</option>
            <option value="DAY">Day students only</option>
            <option value="BOARDING">Boarders only</option>
          </select>
        </Field>

        <Field label="Student type">
          <select name="studentType" className={inputClass} defaultValue="ANY">
            <option value="ANY">New and continuing</option>
            <option value="NEW">New students only</option>
            <option value="CONTINUING">Continuing only</option>
          </select>
        </Field>
      </div>

      <div className="mt-5">
        <p className="mb-2 text-sm font-medium text-slate-700">Fee items (GHS per term)</p>
        {categories.length === 0 ? (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            No fee items exist yet, so there is nothing to price. Add them in the Fee items card
            below first — a structure is a set of amounts, one per item.
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {categories.map((category) => (
            <label key={category.id} className="flex items-center gap-2">
              <span className="w-40 shrink-0 truncate text-sm text-slate-600">{category.name}</span>
              <input
                type="text"
                inputMode="decimal"
                name={`amount:${category.id}`}
                placeholder="0.00"
                className={inputClass}
              />
            </label>
          ))}
        </div>
        {categories.length > 0 ? (
          <p className="mt-2 text-xs text-slate-400">
            Leave an item blank to exclude it from this structure.
          </p>
        ) : null}
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

      {categories.length > 0 ? (
        <div className="mt-5">
          <SubmitButton pendingLabel="Saving…">Save fee structure</SubmitButton>
        </div>
      ) : null}
    </form>
  );
}
