"use client";

import { useActionState, useState } from "react";
import { buttonClass } from "../button-style";
import { recordExpense, type ExpenseState } from "@/lib/expense-actions";
import { SubmitButton } from "../submit-button";
import { Alert, Field, inputClass } from "../ui";

type Option = { id: string; name: string };
type TermOption = { id: string; sequence: number; academicYear: { name: string } };

export function ExpenseForm({
  categories,
  terms,
  currentTermId,
}: {
  categories: Option[];
  terms: TermOption[];
  currentTermId?: string;
}) {
  const [state, formAction] = useActionState<ExpenseState, FormData>(recordExpense, {});
  const [open, setOpen] = useState(false);
  const today = new Date().toISOString().slice(0, 10);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClass("primary")}
      >
        Record expense
      </button>
    );
  }

  return (
    <form
      action={formAction}
      // multipart, or the file never leaves the browser and the attachment
      // silently does not happen.
      encType="multipart/form-data"
      className="w-full rounded-card border border-hairline bg-surface p-4 lg:p-5"
    >
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Record expense</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-sm text-slate-500 hover:text-slate-900"
        >
          Cancel
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Description">
          <input
            type="text"
            name="description"
            required
            placeholder="e.g. ECG electricity bill"
            className={inputClass}
          />
        </Field>

        <Field label="Amount (GHS)">
          <input
            type="text"
            inputMode="decimal"
            name="amount"
            required
            placeholder="0.00"
            className={inputClass}
          />
        </Field>

        <Field label="Category">
          <select name="categoryId" className={inputClass} defaultValue="">
            <option value="">Uncategorised</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Payee">
          <input type="text" name="payee" placeholder="Vendor or staff name" className={inputClass} />
        </Field>

        <Field label="Method">
          <select name="method" className={inputClass} defaultValue="CASH">
            <option value="CASH">Cash</option>
            <option value="MOBILE_MONEY">Mobile money</option>
            <option value="BANK_TRANSFER">Bank transfer</option>
            <option value="CHEQUE">Cheque</option>
          </select>
        </Field>

        <Field label="Reference">
          <input type="text" name="reference" className={inputClass} />
        </Field>

        {/* The photograph of the paper. Optional, because a bursar without a
            camera to hand must still be able to record the spend — but this is
            the column the schema has always had and nothing ever wrote. */}
        <Field label="Receipt" hint="Photo or PDF of the receipt. Optional.">
          <input
            type="file"
            name="receipt"
            accept="image/png,image/jpeg,image/webp,image/heic,application/pdf"
            className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-full file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
          />
        </Field>

        <Field label="Term" hint="Keeps income and expenditure comparable per term.">
          <select name="termId" className={inputClass} defaultValue={currentTermId ?? ""}>
            <option value="">Not term-specific</option>
            {terms.map((term) => (
              <option key={term.id} value={term.id}>
                Term {term.sequence} · {term.academicYear.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Date spent">
          <input type="date" name="spentAt" defaultValue={today} className={inputClass} />
        </Field>
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
        <SubmitButton pendingLabel="Recording…">Save expense</SubmitButton>
      </div>
    </form>
  );
}
