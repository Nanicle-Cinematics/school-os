"use client";

import { useActionState, useState } from "react";
import { runPromotion, type PromotionState } from "@/lib/promotion-actions";
import type { Decision } from "@/lib/promotion-data";
import { SubmitButton } from "../submit-button";
import { Alert, EmptyRow, filterClass, tableHeadClass, thClass } from "../ui";

type ClassOption = { id: string; name: string; level: { name: string } };

export type PlanRow = {
  studentId: string;
  admissionNo: string;
  name: string;
  suggestion: Decision;
  fromReportCard: string | null;
  destinationId: string | null;
  alreadyPlacedIn: string | null;
  /** The year's marks and what they were out of — 1861 of 2700. */
  yearMarks: number | null;
  yearPossible: number | null;
  yearPercent: number | null;
  belowPass: boolean;
};

const DECISION_LABELS: [Decision, string][] = [
  ["PROMOTE", "Promote"],
  ["REPEAT", "Repeat"],
  ["GRADUATE", "Graduate"],
  ["HOLD", "Leave alone"],
];

export function PromotionForm({
  classGroupId,
  sourceYearId,
  targetYearId,
  targetYearName,
  rows,
  destinationClasses,
  repeatClasses,
  hasNextLevel,
  passMark,
}: {
  classGroupId: string;
  sourceYearId: string;
  targetYearId: string;
  targetYearName: string;
  rows: PlanRow[];
  destinationClasses: ClassOption[];
  repeatClasses: ClassOption[];
  hasNextLevel: boolean;
  passMark: number;
}) {
  const [state, formAction] = useActionState<PromotionState, FormData>(runPromotion, {});
  const [decisions, setDecisions] = useState<Record<string, Decision>>(() =>
    Object.fromEntries(rows.map((row) => [row.studentId, row.suggestion])),
  );

  const counts = rows.reduce(
    (acc, row) => {
      acc[decisions[row.studentId]] += 1;
      return acc;
    },
    { PROMOTE: 0, REPEAT: 0, GRADUATE: 0, HOLD: 0 } as Record<Decision, number>,
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="classGroupId" value={classGroupId} />
      <input type="hidden" name="sourceYearId" value={sourceYearId} />
      <input type="hidden" name="targetYearId" value={targetYearId} />

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className={tableHeadClass}>
            <tr>
              <th className={thClass}>Student</th>
              <th className={thClass}>Year mark</th>
              <th className={thClass}>Report card said</th>
              <th className={thClass}>Decision</th>
              <th className={thClass}>Class in {targetYearName}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 ? (
              <EmptyRow colSpan={5}>Nobody is enrolled in this class for that year.</EmptyRow>
            ) : (
              rows.map((row) => {
                const decision = decisions[row.studentId];
                const options = decision === "REPEAT" ? repeatClasses : destinationClasses;
                const needsClass = decision === "PROMOTE" || decision === "REPEAT";

                return (
                  <tr key={row.studentId} className="align-middle">
                    <td className="whitespace-nowrap px-4 py-2">
                      <input type="hidden" name="student" value={row.studentId} />
                      <span className="font-medium text-slate-900">{row.name}</span>
                      <span className="ml-2 font-mono text-xs text-slate-400">
                        {row.admissionNo}
                      </span>
                      {row.alreadyPlacedIn ? (
                        <span className="ml-2 rounded bg-warning-tint px-1.5 py-0.5 text-xs text-warning-ink">
                          already in {row.alreadyPlacedIn}
                        </span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums">
                      {row.yearPercent === null ? (
                        <span className="text-slate-400">not computed</span>
                      ) : (
                        <>
                          <span
                            className={
                              row.belowPass
                                ? "font-semibold text-danger-ink"
                                : "font-medium text-slate-900"
                            }
                          >
                            {row.yearPercent.toFixed(1)}%
                          </span>
                          <span className="ml-2 text-xs text-slate-400">
                            {Math.round(row.yearMarks ?? 0)} / {row.yearPossible}
                          </span>
                        </>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-slate-500">
                      {row.fromReportCard ? row.fromReportCard.toLowerCase() : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2">
                      <select
                        name={`decision:${row.studentId}`}
                        value={decision}
                        onChange={(event) =>
                          setDecisions((prev) => ({
                            ...prev,
                            [row.studentId]: event.target.value as Decision,
                          }))
                        }
                        className={`${filterClass} w-36`}
                      >
                        {DECISION_LABELS.map(([value, label]) => (
                          <option
                            key={value}
                            value={value}
                            disabled={value === "PROMOTE" && !hasNextLevel}
                          >
                            {label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2">
                      {needsClass ? (
                        <select
                          name={`class:${row.studentId}`}
                          defaultValue={row.destinationId ?? ""}
                          className={`${filterClass} w-44`}
                        >
                          {options.length === 0 ? (
                            <option value="">No class exists</option>
                          ) : null}
                          {options.map((group) => (
                            <option key={group.id} value={group.id}>
                              {group.level.name} {group.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-slate-400">
                          {decision === "GRADUATE" ? "leaves the school" : "unchanged"}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="space-y-3 border-t border-slate-100 p-4">
        {state.error ? <Alert tone="error">{state.error}</Alert> : null}
        {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}

        <p className="text-xs text-slate-500">
          {counts.PROMOTE} promoting · {counts.REPEAT} repeating · {counts.GRADUATE} graduating ·{" "}
          {counts.HOLD} left alone
        </p>

        <p className="text-xs text-slate-400">
          The decision each row starts on comes from the year&rsquo;s marks against a {passMark}%
          pass. Change any of them — what you press here is what happens.
        </p>

        {rows.length > 0 ? (
          <SubmitButton pendingLabel="Rolling over…">
            Roll {rows.length} student{rows.length === 1 ? "" : "s"} into {targetYearName}
          </SubmitButton>
        ) : null}
      </div>
    </form>
  );
}
