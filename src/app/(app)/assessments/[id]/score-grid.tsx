"use client";

import { useActionState } from "react";
import { saveScores, type ScoreEntryState } from "@/lib/assessment-actions";
import { SubmitButton } from "../../submit-button";
import { Alert } from "../../ui";

export type Row = {
  studentId: string;
  admissionNo: string;
  name: string;
  score: string;
  isAbsent: boolean;
};

export function ScoreGrid({
  assessmentId,
  maxScore,
  rows,
  readOnly,
}: {
  assessmentId: string;
  maxScore: number;
  rows: Row[];
  readOnly: boolean;
}) {
  const [state, formAction] = useActionState<ScoreEntryState, FormData>(saveScores, {});

  return (
    <form action={formAction}>
      <input type="hidden" name="assessmentId" value={assessmentId} />

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">#</th>
                <th className="px-4 py-2.5 font-medium">Admission no.</th>
                <th className="px-4 py-2.5 font-medium">Student</th>
                <th className="w-32 px-4 py-2.5 font-medium">Score / {maxScore}</th>
                <th className="w-24 px-4 py-2.5 font-medium">Absent</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row, index) => (
                <tr key={row.studentId} className="hover:bg-slate-50">
                  <td className="px-4 py-2 text-slate-400">{index + 1}</td>
                  <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-slate-500">
                    {row.admissionNo}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 font-medium text-slate-900">
                    {row.name}
                  </td>
                  <td className="px-4 py-2">
                    <input
                      type="text"
                      inputMode="decimal"
                      name={`score:${row.studentId}`}
                      defaultValue={row.score}
                      disabled={readOnly}
                      placeholder="—"
                      aria-label={`Score for ${row.name}`}
                      className="w-24 rounded-lg border border-slate-300 px-2 py-1.5 text-sm tabular-nums outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900 disabled:bg-slate-50 disabled:text-slate-400"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <input
                      type="checkbox"
                      name={`absent:${row.studentId}`}
                      defaultChecked={row.isAbsent}
                      disabled={readOnly}
                      aria-label={`${row.name} was absent`}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="mt-2 text-xs text-slate-400">
        Leave a score blank if it isn&rsquo;t marked yet — blank is excluded from the average, while
        absent counts as zero.
      </p>

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

      {!readOnly ? (
        <div className="mt-4">
          <SubmitButton pendingLabel="Saving…">Save all scores</SubmitButton>
        </div>
      ) : null}
    </form>
  );
}
