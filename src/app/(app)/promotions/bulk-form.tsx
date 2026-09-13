"use client";

import { useActionState, useState } from "react";
import { runWholeSchoolPromotion, type PromotionState } from "@/lib/promotion-actions";
import { SubmitButton } from "../submit-button";
import { Alert, EmptyRow, tableHeadClass, thClass } from "../ui";

export type BulkRow = {
  classGroupId: string;
  label: string;
  destinationLabel: string | null;
  blocked: boolean;
  students: number;
  promote: number;
  repeat: number;
  graduate: number;
  alreadyPlaced: number;
};

export function BulkPromotionForm({
  sourceYearId,
  targetYearId,
  targetYearName,
  rows,
}: {
  sourceYearId: string;
  targetYearId: string;
  targetYearName: string;
  rows: BulkRow[];
}) {
  const [state, formAction] = useActionState<PromotionState, FormData>(
    runWholeSchoolPromotion,
    {},
  );
  const [included, setIncluded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(rows.map((row) => [row.classGroupId, !row.blocked])),
  );

  const chosen = rows.filter((row) => included[row.classGroupId] && !row.blocked);
  const totals = chosen.reduce(
    (acc, row) => ({
      students: acc.students + row.students,
      promote: acc.promote + row.promote,
      repeat: acc.repeat + row.repeat,
      graduate: acc.graduate + row.graduate,
    }),
    { students: 0, promote: 0, repeat: 0, graduate: 0 },
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="sourceYearId" value={sourceYearId} />
      <input type="hidden" name="targetYearId" value={targetYearId} />

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className={tableHeadClass}>
            <tr>
              <th className={thClass}>Include</th>
              <th className={thClass}>Class</th>
              <th className={thClass}>On roll</th>
              <th className={thClass}>Goes to</th>
              <th className={thClass}>Breakdown</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 ? (
              <EmptyRow colSpan={5}>
                No class has anyone enrolled for that year.
              </EmptyRow>
            ) : (
              rows.map((row) => (
                <tr key={row.classGroupId} className={row.blocked ? "text-slate-400" : ""}>
                  <td className="px-4 py-2">
                    <input
                      type="checkbox"
                      name="class"
                      value={row.classGroupId}
                      checked={Boolean(included[row.classGroupId]) && !row.blocked}
                      disabled={row.blocked}
                      onChange={(event) =>
                        setIncluded((prev) => ({
                          ...prev,
                          [row.classGroupId]: event.target.checked,
                        }))
                      }
                      className="h-4 w-4"
                    />
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 font-medium text-slate-900">
                    {row.label}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-slate-600">
                    {row.students}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                    {row.blocked ? (
                      <span className="text-warning-ink">no class above — skipped</span>
                    ) : (
                      row.destinationLabel
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-xs text-slate-500">
                    {[
                      row.promote ? `${row.promote} up` : null,
                      row.repeat ? `${row.repeat} repeating` : null,
                      row.graduate ? `${row.graduate} graduating` : null,
                      row.alreadyPlaced ? `${row.alreadyPlaced} already placed` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="space-y-3 border-t border-slate-100 p-4">
        {state.error ? <Alert tone="error">{state.error}</Alert> : null}
        {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}

        <p className="text-xs text-slate-500">
          {chosen.length} class{chosen.length === 1 ? "" : "es"} · {totals.students} children ·{" "}
          {totals.promote} up, {totals.repeat} repeating, {totals.graduate} graduating
        </p>

        {chosen.length > 0 ? (
          <SubmitButton pendingLabel="Rolling the school over…">
            Roll {chosen.length} class{chosen.length === 1 ? "" : "es"} into {targetYearName}
          </SubmitButton>
        ) : null}

        <p className="text-xs text-slate-400">
          This uses the default for every child — the same one the single-class screen suggests.
          Handle anyone repeating on their class screen, either before or after.
        </p>
      </div>
    </form>
  );
}
