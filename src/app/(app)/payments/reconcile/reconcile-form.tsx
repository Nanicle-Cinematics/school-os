"use client";

import { useActionState } from "react";
import { reconcileStatement, type ReconcileState } from "@/lib/reconcile-actions";
import { formatCedis } from "@/lib/money";
import { SubmitButton } from "../../submit-button";
import { inputClass } from "../../ui";
import { Card } from "../../ui";

/**
 * Paste a statement, see what does not line up.
 *
 * The result is deliberately two lists, not a score. "23 of 25 matched" tells a
 * bursar nothing they can act on; the two lines in the account with no receipt,
 * and the one receipt with no money behind it, are the entire job.
 */
export function ReconcileForm() {
  const [state, formAction] = useActionState<ReconcileState, FormData>(reconcileStatement, {});

  return (
    <div className="space-y-4">
      <Card title="Paste the statement">
        <form action={formAction} className="p-4">
          <p className="text-sm text-slate-500">
            Copy the rows from your bank or MoMo statement — header included. Date, credit amount
            and a reference is enough, in any column order. Cash receipts are left out of this on
            purpose: they never appear on a statement.
          </p>
          <textarea
            name="statement"
            rows={8}
            required
            placeholder={"Date,Credit,Reference,Narration\n05/06/2026,450.00,MP2606051234,MTN MoMo Ama Mensah\n06/06/2026,1200.00,TRF88213,Transfer Kofi Frimpong"}
            className={`${inputClass} mt-3 font-mono text-xs`}
          />
          {state.error ? <p className="mt-2 text-sm text-danger-ink">{state.error}</p> : null}
          {state.ok ? <p className="mt-2 text-sm text-success-ink">{state.ok}</p> : null}
          <div className="mt-3">
            <SubmitButton pendingLabel="Matching…">Reconcile</SubmitButton>
          </div>
        </form>
      </Card>

      {state.report ? (
        <>
          <Card title={`In the account, not in the book — ${state.report.unmatchedLines.length}`}>
            {state.report.unmatchedLines.length === 0 ? (
              <p className="px-4 py-6 text-sm text-slate-500">
                Every line on the statement has a receipt behind it.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {state.report.unmatchedLines.map((line, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                    <span className="min-w-0">
                      <span className="text-slate-600">{line.paidAt}</span>
                      <span className="ml-2 truncate text-slate-500">
                        {[line.reference, line.narration].filter(Boolean).join(" · ") || "no reference"}
                      </span>
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums">
                      {formatCedis(line.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={`In the book, not in the account — ${state.report.unmatchedPayments.length}`}>
            {state.report.unmatchedPayments.length === 0 ? (
              <p className="px-4 py-6 text-sm text-slate-500">
                Every non-cash receipt in this window is on the statement.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {state.report.unmatchedPayments.map((payment) => (
                  <li
                    key={payment.receiptNo}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
                  >
                    <span>
                      <span className="font-mono text-xs text-slate-900">{payment.receiptNo}</span>
                      <span className="ml-2 text-slate-500">{payment.paidAt}</span>
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums">
                      {formatCedis(payment.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {state.report.skipped.length > 0 ? (
            <p className="text-xs text-slate-400">
              {state.report.skipped.length} line
              {state.report.skipped.length === 1 ? "" : "s"} could not be read and were left out —
              they had no date or no credit amount.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
