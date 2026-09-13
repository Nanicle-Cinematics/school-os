"use client";

import { useActionState } from "react";
import { generateInvoices, type GenerateState } from "@/lib/invoice-actions";
import { SubmitButton } from "../submit-button";
import { Alert, inputClass } from "../ui";

type Term = { id: string; sequence: number; academicYear: { name: string } };

export function GenerateForm({ terms, currentTermId }: { terms: Term[]; currentTermId?: string }) {
  const [state, formAction] = useActionState<GenerateState, FormData>(generateInvoices, {});

  return (
    <div className="rounded-card border border-hairline bg-surface p-4">
      <h2 className="text-sm font-semibold text-slate-900">Generate term invoices</h2>
      <p className="mt-0.5 text-sm text-slate-500">
        Bills every active student from their level&rsquo;s fee structure, carrying last
        term&rsquo;s balance forward. Students who already have an invoice are skipped, so this is
        safe to re-run.
      </p>

      <form action={formAction} className="mt-3 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-slate-700">Term</span>
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
        </label>
        <SubmitButton pendingLabel="Generating…">Generate invoices</SubmitButton>
      </form>

      {state.error ? (
        <div className="mt-3">
          <Alert tone="error">{state.error}</Alert>
        </div>
      ) : null}
      {state.ok ? (
        <div className="mt-3">
          <Alert tone="success">{state.ok}</Alert>
        </div>
      ) : null}

      {state.blocked && state.blocked.length > 0 ? (
        <div className="mt-3 space-y-2">
          {state.blocked.map((group) => (
            <div
              key={group.problem}
              className="rounded-lg border border-hairline bg-warning-tint px-3 py-2 text-sm text-warning-ink"
            >
              <p className="font-medium">
                {group.students.length} student{group.students.length === 1 ? "" : "s"} skipped —{" "}
                {group.problem}
              </p>
              <p className="mt-0.5 text-warning-ink">{group.fix}</p>
              <p className="mt-1 text-xs text-warning-ink/80">
                {group.students
                  .slice(0, 12)
                  .map((s) => `${s.admissionNo} ${s.name}`)
                  .join(", ")}
                {group.students.length > 12 ? ` and ${group.students.length - 12} more` : ""}
              </p>
            </div>
          ))}
          <p className="text-xs text-slate-500">
            Nothing was lost — fix the above and run this again. Students who already have an
            invoice are skipped, so re-running only fills the gaps.
          </p>
        </div>
      ) : null}
    </div>
  );
}
