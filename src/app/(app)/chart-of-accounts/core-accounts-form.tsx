"use client";

import { useActionState } from "react";
import { saveCoreAccounts, type ActionState } from "@/lib/ledger-actions";
import { SubmitButton } from "../submit-button";
import { Alert, Field, inputClass } from "../ui";

type Account = { id: string; code: string; name: string };

/**
 * Which account is Cash, Bank, Mobile Money, Accounts Receivable and
 * Accounts Payable — the mappings the posting engine reads for every
 * invoice, payment, expense and vendor bill. Left blank, a school keeps
 * billing, paying and spending exactly as before; nothing here is required.
 */
export function CoreAccountsForm({
  values,
  assetAccounts,
  liabilityAccounts,
}: {
  values: {
    cashAccountId: string;
    bankAccountId: string;
    momoAccountId: string;
    receivableAccountId: string;
    payableAccountId: string;
  };
  assetAccounts: Account[];
  liabilityAccounts: Account[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(saveCoreAccounts, {});

  const assetField = (name: string, label: string, defaultValue: string) => (
    <Field label={label}>
      <select name={name} defaultValue={defaultValue} className={inputClass}>
        <option value="">Not set</option>
        {assetAccounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.code} — {account.name}
          </option>
        ))}
      </select>
    </Field>
  );

  return (
    <form action={formAction} className="p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {assetField("cashAccountId", "Cash payments post to", values.cashAccountId)}
        {assetField("bankAccountId", "Bank payments post to", values.bankAccountId)}
        {assetField("momoAccountId", "Mobile money payments post to", values.momoAccountId)}
        {assetField("receivableAccountId", "Fees owed (Accounts Receivable)", values.receivableAccountId)}

        <Field label="Owed to suppliers (Accounts Payable)">
          <select
            name="payableAccountId"
            defaultValue={values.payableAccountId}
            className={inputClass}
          >
            <option value="">Not set</option>
            {liabilityAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} — {account.name}
              </option>
            ))}
          </select>
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
        <SubmitButton pendingLabel="Saving…">Save default postings</SubmitButton>
      </div>
    </form>
  );
}
