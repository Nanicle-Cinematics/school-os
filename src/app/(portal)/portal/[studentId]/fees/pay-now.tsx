"use client";

import { useActionState } from "react";
import { startCheckout, type CheckoutState } from "@/lib/online-payment-actions";
import { SubmitButton } from "@/app/(app)/submit-button";
import { Alert } from "@/app/(app)/ui";

/**
 * Pay a child's fees online.
 *
 * The amount is a convenience (it starts at the whole balance); the server re-reads what is owing
 * and refuses anything above it, so editing the box proves nothing. The form is re-keyed on every
 * refusal because React resets a form when its action returns: without the key the box would snap
 * back to the full balance while the message above it talked about the figure the parent typed.
 */
export function PayNow({ studentId, owing }: { studentId: string; owing: string }) {
  const [state, formAction] = useActionState<CheckoutState, FormData>(startCheckout.bind(null, studentId), {});

  return (
    <form
      key={`${state.error ?? ""}|${state.amount ?? ""}`}
      action={formAction}
      className="rounded-card border border-hairline bg-surface p-5 shadow-card"
    >
      <p className="text-sm font-semibold text-slate-600">Pay online</p>
      <label className="mt-2 block text-xs text-slate-500" htmlFor="pay-amount">
        Amount to pay (GH₵)
      </label>
      <input
        id="pay-amount"
        name="amount"
        inputMode="decimal"
        autoComplete="off"
        defaultValue={state.amount ?? owing}
        className="mt-1 w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-lg font-bold tabular-nums text-slate-900"
      />
      {state.error ? (
        <div className="mt-3">
          <Alert tone="error">{state.error}</Alert>
        </div>
      ) : null}
      <div className="mt-4">
        <SubmitButton pendingLabel="Taking you to Paystack…">Pay with mobile money or card</SubmitButton>
      </div>
      <p className="mt-3 text-xs text-slate-500">
        You will pay on Paystack&apos;s secure page. The school sees the payment as soon as it is confirmed.
      </p>
    </form>
  );
}
