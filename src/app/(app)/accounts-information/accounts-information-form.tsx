"use client";

import { useActionState } from "react";
import { saveAccountsInformation, type ActionState } from "@/lib/accounts-information-actions";
import { SubmitButton } from "../submit-button";
import { Alert, Field, inputClass } from "../ui";

export function AccountsInformationForm({
  values,
}: {
  values: { tin: string; paymentInstructions: string; invoiceNote: string };
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(saveAccountsInformation, {});

  return (
    <form action={formAction} className="p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Tax Identification Number (TIN)" hint="Ghana Revenue Authority TIN, printed on every bill.">
          <input
            type="text"
            name="tin"
            defaultValue={values.tin}
            placeholder="e.g. GHA-000000000-0"
            className={inputClass}
          />
        </Field>
      </div>

      <div className="mt-3 grid gap-3">
        <Field
          label="How to pay"
          hint="Printed on every invoice. Momo number and merchant name, bank account, or where to pay at the school."
        >
          <textarea
            name="paymentInstructions"
            rows={4}
            defaultValue={values.paymentInstructions}
            placeholder={"MTN MoMo: 024 000 0000 (Nanicle Academy)\nBank: GCB 1234567890123, Adum Branch\nOr pay at the bursar's office, 8am–3pm."}
            className={inputClass}
          />
        </Field>

        <Field label="Note under the total" hint="One line, e.g. a deadline or a late-payment rule.">
          <input
            type="text"
            name="invoiceNote"
            maxLength={200}
            defaultValue={values.invoiceNote}
            placeholder="Fees are payable in full by the third week of term."
            className={inputClass}
          />
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
        <SubmitButton pendingLabel="Saving…">Save accounts information</SubmitButton>
      </div>
    </form>
  );
}
