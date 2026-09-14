"use client";

import { useActionState } from "react";
import { createPlan, cancelPlan, type PlanState } from "@/lib/plan-actions";
import { planStanding } from "@/lib/plan-engine";
import { formatCedis } from "@/lib/money";
import { SubmitButton } from "../../submit-button";
import { inputClass } from "../../ui";

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

type Instalment = { id: string; sequence: number; dueDate: Date; amount: string };

/**
 * The arrangement on one bill: agree one, or see how it is being kept.
 *
 * ⚠️ Standing is computed against the SCHEDULE, not the bill. A parent who owes
 * ₵900 of ₵1,200 is in arrears by the invoice and in perfectly good standing by
 * a plan that asked for ₵300 by today — and that distinction is the only reason
 * this feature exists.
 */
export function PlanCard({
  invoiceId,
  balance,
  amountPaid,
  plan,
  today,
}: {
  invoiceId: string;
  balance: number;
  amountPaid: string;
  plan: { id: string; note: string | null; cancelledAt: Date | null; instalments: Instalment[] } | null;
  today: string;
}) {
  const [state, formAction] = useActionState<PlanState, FormData>(createPlan, {});

  if (plan && !plan.cancelledAt) {
    const standing = planStanding(
      plan.instalments.map((i) => ({
        sequence: i.sequence,
        dueDate: new Date(i.dueDate),
        amount: i.amount,
      })),
      amountPaid,
    );
    /**
     * How much of each instalment the payments cover, worked out BEFORE the
     * render rather than by mutating a running total inside .map().
     *
     * React's compiler refuses the mutating version (react-hooks/immutability)
     * and is right to: a render that depends on the order its children happen to
     * be evaluated in is a render that breaks the first time anything reorders
     * or re-runs it.
     */
    const coverage = plan.instalments.reduce<{ rows: number[]; left: number }>(
      (acc, instalment) => {
        const amount = Number(instalment.amount);
        const applied = Math.min(acc.left, amount);
        return { rows: [...acc.rows, applied], left: acc.left - applied };
      },
      { rows: [], left: Number(amountPaid) },
    ).rows;

    return (
      <div className="p-4">
        <p className={`text-sm ${standing.onTrack ? "text-success-ink" : "text-danger-ink"}`}>
          {standing.onTrack
            ? standing.nextDue
              ? `Up to date. Next instalment ${formatCedis(standing.nextDue.amount)} on ${dateFmt.format(standing.nextDue.dueDate)}.`
              : "Up to date — every instalment covered."
            : `Behind by ${formatCedis(standing.shortfall)} against the agreed dates.`}
        </p>
        {plan.note ? <p className="mt-1 text-xs text-slate-500">{plan.note}</p> : null}

        <ul className="mt-3 divide-y divide-slate-100 border-y border-hairline">
          {plan.instalments.map((instalment, index) => {
            const amount = Number(instalment.amount);
            const thisCovered = coverage[index] ?? 0;
            const paid = thisCovered >= amount - 0.005;
            const part = !paid && thisCovered > 0;
            const due = new Date(instalment.dueDate);
            const late = !paid && due < new Date();
            return (
              <li key={instalment.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="text-slate-600">
                  {instalment.sequence}. {dateFmt.format(due)}
                  {late ? <span className="ml-2 text-xs text-danger-ink">overdue</span> : null}
                </span>
                <span className="tabular-nums">
                  {formatCedis(amount)}
                  <span className={`ml-2 text-xs ${paid ? "text-success-ink" : "text-slate-400"}`}>
                    {paid ? "covered" : part ? `${formatCedis(thisCovered)} in` : "outstanding"}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>

        <form action={cancelPlan} className="mt-3">
          <input type="hidden" name="planId" value={plan.id} />
          <input type="hidden" name="invoiceId" value={invoiceId} />
          <SubmitButton pendingLabel="Ending…" variant="secondary">
            End this arrangement
          </SubmitButton>
        </form>
      </div>
    );
  }

  if (balance <= 0) {
    return <p className="p-4 text-sm text-slate-500">This bill is settled — there is nothing to spread.</p>;
  }

  return (
    <form action={formAction} className="p-4">
      <p className="text-sm text-slate-500">
        Spread the {formatCedis(balance)} still owing over agreed dates. The bill does not change —
        this records when the school agreed the money would arrive, so the family is not chased or
        their report card withheld while they keep to it.
      </p>

      <input type="hidden" name="invoiceId" value={invoiceId} />
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <label className="text-sm">
          <span className="mb-1.5 block font-medium text-slate-700">Instalments</span>
          <input type="number" name="count" min={2} max={12} defaultValue={3} required className={inputClass} />
        </label>
        <label className="text-sm">
          <span className="mb-1.5 block font-medium text-slate-700">First due</span>
          <input type="date" name="firstDue" defaultValue={today} required className={inputClass} />
        </label>
        <label className="text-sm">
          <span className="mb-1.5 block font-medium text-slate-700">Days apart</span>
          <input type="number" name="everyDays" min={1} max={120} defaultValue={30} required className={inputClass} />
        </label>
      </div>
      <label className="mt-3 block text-sm">
        <span className="mb-1.5 block font-medium text-slate-700">Note</span>
        <input type="text" name="note" maxLength={200} placeholder="Agreed with the father on the phone." className={inputClass} />
      </label>

      {state.error ? <p className="mt-2 text-sm text-danger-ink">{state.error}</p> : null}
      {state.ok ? <p className="mt-2 text-sm text-success-ink">{state.ok}</p> : null}

      <div className="mt-3">
        <SubmitButton pendingLabel="Agreeing…">Agree a plan</SubmitButton>
      </div>
    </form>
  );
}
