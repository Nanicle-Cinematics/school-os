"use client";

import { useActionState, useState } from "react";
import { saveScores, type ScoreEntryState } from "@/lib/assessment-actions";
import { checkScore } from "@/lib/score-limits";
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

  // Held here, not left in the DOM, so what is typed is checked as it is typed and survives a
  // refused save. The rule is `checkScore`, the same function `saveScores` decides with, so this
  // screen cannot accept what the server will refuse, or the other way round.
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.map((row) => [row.studentId, row.score])),
  );
  const [absent, setAbsent] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(rows.map((row) => [row.studentId, row.isAbsent])),
  );

  // An absent pupil's box is ignored by the server, so it is ignored here too.
  const problems = new Map<string, string>();
  for (const row of rows) {
    if (absent[row.studentId]) continue;
    const verdict = checkScore(values[row.studentId] ?? "", maxScore);
    if (!verdict.ok) problems.set(row.studentId, verdict.reason);
  }
  const blocked = problems.size > 0;

  return (
    <form action={formAction}>
      <input type="hidden" name="assessmentId" value={assessmentId} />

      <div className="overflow-hidden rounded-card border border-hairline bg-surface">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">#</th>
                <th className="px-4 py-2.5 font-medium">Admission no.</th>
                <th className="px-4 py-2.5 font-medium">Student</th>
                <th className="w-32 px-4 py-2.5 font-medium">Score / {maxScore}</th>
                <th className="w-24 px-4 py-2.5 font-medium">Absent</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row, index) => {
                const problem = problems.get(row.studentId);
                return (
                  <tr key={row.studentId} className="hover:bg-slate-50">
                    <td className="px-4 py-2 align-top text-slate-400">{index + 1}</td>
                    <td className="whitespace-nowrap px-4 py-2 align-top font-mono text-xs text-slate-500">
                      {row.admissionNo}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 align-top font-medium text-slate-900">
                      {row.name}
                    </td>
                    <td className="px-4 py-2 align-top">
                      <input
                        type="text"
                        inputMode="decimal"
                        name={`score:${row.studentId}`}
                        value={absent[row.studentId] ? "" : (values[row.studentId] ?? "")}
                        onChange={(e) =>
                          setValues((prev) => ({ ...prev, [row.studentId]: e.target.value }))
                        }
                        // `disabled` is for the whole sheet being locked. An absent pupil's box is
                        // `readOnly` instead: a disabled input is not submitted, and the server only
                        // looks for absences among the `score:` fields it receives.
                        disabled={readOnly}
                        readOnly={absent[row.studentId] ?? false}
                        placeholder="—"
                        aria-label={`Score for ${row.name}`}
                        aria-invalid={problem ? true : undefined}
                        aria-describedby={problem ? `score-problem-${row.studentId}` : undefined}
                        className={`w-24 rounded-lg border px-2 py-1.5 text-sm tabular-nums outline-none focus:ring-2 ${
                          problem
                            ? "border-danger-ink focus:border-danger-ink focus:ring-danger-ink/20"
                            : "border-slate-300 focus:border-brand-500 focus:ring-brand-500/20"
                        } disabled:bg-slate-100 read-only:bg-slate-100`}
                      />
                      {problem ? (
                        <p id={`score-problem-${row.studentId}`} className="mt-1 max-w-48 text-xs text-danger-ink">
                          {problem}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 align-top">
                      <input
                        type="checkbox"
                        name={`absent:${row.studentId}`}
                        checked={absent[row.studentId] ?? false}
                        onChange={(e) =>
                          setAbsent((prev) => ({ ...prev, [row.studentId]: e.target.checked }))
                        }
                        disabled={readOnly}
                        aria-label={`${row.name} was absent`}
                        className="mt-2 h-4 w-4 rounded border-slate-300"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="mt-2 text-xs text-slate-400">
        Marked out of {maxScore}; a score above that is refused. Leave a score blank if it isn&rsquo;t
        marked yet — blank is excluded from the average, while absent counts as zero.
      </p>

      {blocked ? (
        <div className="mt-3">
          <Alert tone="error">
            {problems.size === 1 ? "1 mark is" : `${problems.size} marks are`} out of range. Fix{" "}
            {problems.size === 1 ? "it" : "them"} to save: this assessment is marked out of {maxScore}.
          </Alert>
        </div>
      ) : null}
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
          <SubmitButton pendingLabel="Saving…" disabled={blocked}>
            Save all scores
          </SubmitButton>
        </div>
      ) : null}
    </form>
  );
}
