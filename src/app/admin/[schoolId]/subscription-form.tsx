"use client";

import { useActionState } from "react";
import type { Plan, SubscriptionStatus } from "@prisma/client";
import {
  updateSubscription,
  recordSubscriptionPayment,
  type PlatformState,
} from "@/lib/platform-actions";
import { PLANS, STATUS_LABELS } from "@/lib/subscription";

const inputClass =
  "w-full rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500";

/**
 * The lever this whole console exists for.
 *
 * Everything on it was already in the schema and enforced nowhere — so the
 * screen deliberately states what each state DOES, rather than only naming it.
 * "Past due" means nothing to someone deciding whether to press it; "read-only,
 * they can still print report cards" is the fact they are weighing.
 */
export function SubscriptionForm({
  school,
}: {
  school: {
    id: string;
    plan: Plan;
    subscriptionStatus: SubscriptionStatus;
    studentCap: number | null;
    trialEndsAt: Date | null;
    paidUntil: Date | null;
    monthlyFee: number | null;
  };
}) {
  const [state, action] = useActionState<PlatformState, FormData>(updateSubscription, {});
  const [paid, payAction] = useActionState<PlatformState, FormData>(recordSubscriptionPayment, {});


  return (
    <form action={action} className="space-y-4 p-4">
      <input type="hidden" name="schoolId" value={school.id} />

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-slate-700">Plan</span>
          <select name="plan" defaultValue={school.plan} className={inputClass}>
            {(Object.keys(PLANS) as Plan[]).map((plan) => (
              <option key={plan} value={plan}>
                {PLANS[plan].label}
                {PLANS[plan].studentCap ? ` — up to ${PLANS[plan].studentCap} pupils` : " — no cap"}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-slate-700">Subscription</span>
          <select
            name="subscriptionStatus"
            defaultValue={school.subscriptionStatus}
            className={inputClass}
          >
            {(Object.keys(STATUS_LABELS) as SubscriptionStatus[]).map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-slate-700">Pupil cap</span>
          <input
            type="number"
            name="studentCap"
            min={1}
            defaultValue={school.studentCap ?? ""}
            placeholder="No cap"
            className={inputClass}
          />
          <span className="mt-1 block text-xs text-slate-500">
            Blank for no cap. Existing pupils are never affected — the cap refuses new admissions.
          </span>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-slate-700">Monthly fee (GH₵)</span>
          <input
            type="number"
            name="monthlyFee"
            min={0}
            step="0.01"
            defaultValue={school.monthlyFee ?? ""}
            placeholder="Not set"
            className={inputClass}
          />
          <span className="mt-1 block text-xs text-slate-500">
            Counts towards monthly revenue only while the subscription is Active.
          </span>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-slate-700">Paid until</span>
          <input
            type="date"
            name="paidUntil"
            defaultValue={school.paidUntil ? school.paidUntil.toISOString().slice(0, 10) : ""}
            className={inputClass}
          />
          <span className="mt-1 block text-xs text-slate-500">
            An Active school goes read-only a week after this date. Use the button below for an
            ordinary month rather than editing it by hand.
          </span>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-slate-700">Trial ends</span>
          <input
            type="date"
            name="trialEndsAt"
            defaultValue={school.trialEndsAt ? school.trialEndsAt.toISOString().slice(0, 10) : ""}
            className={inputClass}
          />
          <span className="mt-1 block text-xs text-slate-500">
            Only read while the subscription is Trialing. Blank means an open trial, not an expired one.
          </span>
        </label>
      </div>

      <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
        <p className="font-semibold text-slate-700">What these do</p>
        <p className="mt-1">
          <strong>Active</strong> — everything works. <strong>Trialing</strong> — the same until the
          date above passes.
        </p>
        <p>
          <strong>Past due</strong>, <strong>Suspended</strong> and <strong>Cancelled</strong> put
          the school into read-only: staff sign in, read records and print report cards, but cannot
          admit, bill, mark or publish. Parents are never affected — the portal only reads.
        </p>
      </div>

      {state.error ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p role="alert" className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
          {state.ok}
        </p>
      ) : null}

      <button
        type="submit"
        className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700"
      >
        Save subscription
      </button>

      {/* The ordinary monthly action, one press, so the common case is not
          somebody typing a date into the field above and getting it wrong. It
          advances from the date already held rather than from today, so paying
          late does not shorten the month bought. */}
      <div className="mt-4 border-t border-slate-100 pt-4">
        {paid.ok ? (
          <p role="alert" className="mb-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
            {paid.ok}
          </p>
        ) : null}
        {paid.error ? (
          <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {paid.error}
          </p>
        ) : null}
        <button
          type="submit"
          formAction={payAction}
          className="rounded-lg border border-slate-200 bg-surface px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          Record a month&apos;s payment
        </button>
        <span className="ml-3 text-xs text-slate-500">
          Moves the due date on a month and marks the school Active.
        </span>
        <p className="mt-2 text-sm text-slate-600">
          {school.paidUntil ? (
            <>
              Paid to{" "}
              <span className="font-semibold text-slate-900">
                {school.paidUntil.toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </span>
            </>
          ) : (
            "No payment recorded yet."
          )}
        </p>
      </div>
    </form>
  );
}
