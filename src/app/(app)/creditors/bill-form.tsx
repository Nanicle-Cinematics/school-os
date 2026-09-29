"use client";

import { useActionState, useState } from "react";
import { buttonClass } from "../button-style";
import { recordVendorBill, type ActionState } from "@/lib/vendor-actions";
import { SubmitButton } from "../submit-button";
import { Alert, Field, inputClass } from "../ui";

type Option = { id: string; name: string };

export function BillForm({
  vendors,
  categories,
  defaultVendorId,
}: {
  vendors: Option[];
  categories: Option[];
  defaultVendorId?: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(recordVendorBill, {});
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={buttonClass("primary")}>
        Record bill
      </button>
    );
  }

  return (
    <form action={formAction} className="w-full rounded-card border border-hairline bg-surface p-4 lg:p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Record a vendor bill</h2>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-slate-500 hover:text-slate-900">
          Cancel
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Vendor">
          <select name="vendorId" required defaultValue={defaultVendorId ?? ""} className={inputClass}>
            <option value="" disabled>
              Choose a vendor…
            </option>
            {vendors.map((vendor) => (
              <option key={vendor.id} value={vendor.id}>
                {vendor.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Description">
          <input
            type="text"
            name="description"
            required
            placeholder="e.g. Termly electricity bill"
            className={inputClass}
          />
        </Field>

        <Field label="Amount (GHS)">
          <input type="text" inputMode="decimal" name="amount" required placeholder="0.00" className={inputClass} />
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

        <Field label="Due date">
          <input type="date" name="dueDate" className={inputClass} />
        </Field>
      </div>

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

      <div className="mt-4">
        <SubmitButton pendingLabel="Saving…">Save bill</SubmitButton>
      </div>
    </form>
  );
}
