"use client";

import { useActionState, useState } from "react";
import { buttonClass } from "../button-style";
import { recordVendorPayment, type ActionState } from "@/lib/vendor-actions";
import { SubmitButton } from "../submit-button";
import { Alert, Field, inputClass } from "../ui";

type Option = { id: string; name: string };

export function PaymentForm({ vendors, defaultVendorId }: { vendors: Option[]; defaultVendorId?: string }) {
  const [state, formAction] = useActionState<ActionState, FormData>(recordVendorPayment, {});
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState("CASH");

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={buttonClass("secondary")}>
        Record payment
      </button>
    );
  }

  return (
    <form action={formAction} className="w-full rounded-card border border-hairline bg-surface p-4 lg:p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Pay a vendor</h2>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-slate-500 hover:text-slate-900">
          Cancel
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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

        <Field label="Amount (GHS)">
          <input type="text" inputMode="decimal" name="amount" required placeholder="0.00" className={inputClass} />
        </Field>

        <Field label="Method">
          <select
            name="method"
            value={method}
            onChange={(event) => setMethod(event.target.value)}
            className={inputClass}
          >
            <option value="CASH">Cash</option>
            <option value="MOBILE_MONEY">Mobile money</option>
            <option value="BANK_DEPOSIT">Bank deposit</option>
            <option value="BANK_TRANSFER">Bank transfer</option>
            <option value="CHEQUE">Cheque</option>
          </select>
        </Field>

        {method === "MOBILE_MONEY" ? (
          <Field label="Network">
            <select name="momoNetwork" className={inputClass} defaultValue="MTN">
              <option value="MTN">MTN</option>
              <option value="TELECEL">Telecel</option>
              <option value="AIRTELTIGO">AirtelTigo</option>
            </select>
          </Field>
        ) : (
          <Field label="Reference" hint="Slip or cheque number.">
            <input type="text" name="reference" className={inputClass} />
          </Field>
        )}
      </div>

      {method === "MOBILE_MONEY" ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Reference" hint="Required for mobile money.">
            <input type="text" name="reference" className={inputClass} />
          </Field>
        </div>
      ) : null}

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
        <SubmitButton pendingLabel="Saving…">Save payment</SubmitButton>
      </div>
    </form>
  );
}
