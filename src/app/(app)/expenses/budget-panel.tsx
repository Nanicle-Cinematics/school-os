"use client";

import { useActionState } from "react";
import { setBudget, type BudgetState } from "@/lib/budget-actions";
import type { BudgetRow } from "@/lib/budget-data";
import { formatCedis } from "@/lib/money";
import { SubmitButton } from "../submit-button";
import { inputClass } from "../ui";

/**
 * Budget against actual, per heading.
 *
 * The bar is the actual as a share of the budget, and it is the only thing on
 * the row that is coloured — over goes red, near goes amber, the rest stays
 * brand. Colour here has one meaning: how close this heading is to the line the
 * proprietor drew.
 *
 * An unbudgeted heading shows its spend and an empty box rather than a zero
 * bar. A bar implies a ceiling, and there is not one.
 */
export function BudgetPanel({
  rows,
  termId,
  mayEdit,
}: {
  rows: BudgetRow[];
  termId: string;
  mayEdit: boolean;
}) {
  const [state, formAction] = useActionState<BudgetState, FormData>(setBudget, {});

  return (
    <div className="p-4">
      {state.error ? <p className="mb-3 text-sm text-danger-ink">{state.error}</p> : null}
      {state.ok ? <p className="mb-3 text-sm text-success-ink">{state.ok}</p> : null}

      <ul className="space-y-3">
        {rows.map((row) => {
          const over = row.budget !== null && row.actual > row.budget;
          const near = !over && row.usedPct !== null && row.usedPct >= 80;
          return (
            <li key={row.categoryId} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
              <div className="min-w-0">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-sm font-medium text-slate-900">{row.name}</span>
                  <span className="shrink-0 text-xs tabular-nums text-slate-500">
                    {formatCedis(row.actual)}
                    {row.budget === null ? (
                      <span className="text-slate-400"> · no budget set</span>
                    ) : (
                      <>
                        {" of "}
                        {formatCedis(row.budget)}
                        <span className={over ? "font-semibold text-danger-ink" : "text-slate-400"}>
                          {" · "}
                          {over
                            ? `${formatCedis(row.actual - row.budget)} over`
                            : `${formatCedis(row.budget - row.actual)} left`}
                        </span>
                      </>
                    )}
                  </span>
                </div>
                {row.budget === null ? null : (
                  <span className="mt-1 block h-2 overflow-hidden rounded-full bg-slate-100">
                    <span
                      className={`block h-full rounded-full ${
                        over ? "bg-danger-ink" : near ? "bg-accent-600" : "bg-brand-600"
                      }`}
                      style={{ width: `${Math.min(100, Math.round(row.usedPct ?? 0))}%` }}
                    />
                  </span>
                )}
              </div>

              {mayEdit ? (
                <form action={formAction} className="flex shrink-0 items-center gap-2">
                  <input type="hidden" name="termId" value={termId} />
                  <input type="hidden" name="categoryId" value={row.categoryId} />
                  <input
                    type="text"
                    inputMode="decimal"
                    name="amount"
                    defaultValue={row.budget === null ? "" : String(row.budget)}
                    placeholder="none"
                    aria-label={`Budget for ${row.name}`}
                    className={`${inputClass} w-28`}
                  />
                  <SubmitButton pendingLabel="…" variant="secondary">
                    Set
                  </SubmitButton>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
