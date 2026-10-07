"use client";

import { useActionState } from "react";
import { saveRecordedMarks, type RecordsState } from "@/lib/records-actions";
import { SubmitButton } from "../../submit-button";
import { Alert, filterClass, tableHeadClass, thClass } from "../../ui";

type Row = {
  student: { id: string; firstName: string; lastName: string; admissionNo: string };
  classScore: number | null;
  examScore: number | null;
  totalScore: number | null;
  grade: string | null;
  locked: boolean;
};

// filterClass, not inputClass: inputClass is w-full, and Tailwind would let it
// win over a w-24 written beside it (see CLAUDE.md, "The look").
const markClass = `${filterClass} w-24 text-right tabular-nums`;

/**
 * The paper record, typed in. Blank is "no record", never zero — a hole in the
 * register stays a hole, and pulls the term total down where everyone can see it.
 */
export function RecordsForm({
  termId,
  classGroupId,
  subjectId,
  format,
  classWeight,
  examWeight,
  rows,
}: {
  termId: string;
  classGroupId: string;
  subjectId: string;
  format: "split" | "total";
  classWeight: number;
  examWeight: number;
  rows: Row[];
}) {
  const [state, formAction] = useActionState<RecordsState, FormData>(saveRecordedMarks, {});
  const split = format === "split";
  const locked = rows.filter((row) => row.locked).length;
  const value = (n: number | null) => (n === null ? "" : String(n));
  // After a refusal the boxes show what was typed, not what is saved: the
  // reset that follows an action puts every field back to its defaultValue.
  const typed = (key: string, saved: number | null) => state.values?.[key] ?? value(saved);

  return (
    <form action={formAction}>
      <input type="hidden" name="termId" value={termId} />
      <input type="hidden" name="classGroupId" value={classGroupId} />
      <input type="hidden" name="subjectId" value={subjectId} />
      <input type="hidden" name="format" value={format} />

      {state.ok || state.error || locked > 0 ? (
        <div className="space-y-2 p-4">
          {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}
          {state.error ? <Alert tone="error">{state.error}</Alert> : null}
          {locked > 0 ? (
            <p className="rounded-control bg-info-tint px-3.5 py-2.5 text-sm text-info-ink">
              {locked} {locked === 1 ? "pupil was" : "pupils were"} marked in School OS for this term,
              so their figures are computed and cannot be typed over here.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className={tableHeadClass}>
            <tr>
              <th className={thClass}>Pupil</th>
              {split ? (
                <>
                  <th className={`${thClass} text-right`}>Class score / {classWeight}</th>
                  <th className={`${thClass} text-right`}>Exam score / {examWeight}</th>
                </>
              ) : (
                <th className={`${thClass} text-right`}>Total / 100</th>
              )}
              <th className={`${thClass} text-right`}>Saved total</th>
              <th className={thClass}>Grade</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr key={row.student.id}>
                <td className="px-4 py-2">
                  {row.locked ? null : <input type="hidden" name={`row:${row.student.id}`} value="1" />}
                  <p className="font-medium text-slate-900">
                    {row.student.lastName}, {row.student.firstName}
                  </p>
                  <p className="text-xs text-slate-400">{row.student.admissionNo}</p>
                </td>
                {split ? (
                  <>
                    <td className="px-4 py-2 text-right">
                      <input
                        name={`class:${row.student.id}`}
                        inputMode="decimal"
                        defaultValue={typed(`class:${row.student.id}`, row.classScore)}
                        disabled={row.locked}
                        aria-label={`Class score for ${row.student.firstName} ${row.student.lastName}`}
                        className={markClass}
                      />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <input
                        name={`exam:${row.student.id}`}
                        inputMode="decimal"
                        defaultValue={typed(`exam:${row.student.id}`, row.examScore)}
                        disabled={row.locked}
                        aria-label={`Exam score for ${row.student.firstName} ${row.student.lastName}`}
                        className={markClass}
                      />
                    </td>
                  </>
                ) : (
                  <td className="px-4 py-2 text-right">
                    <input
                      name={`total:${row.student.id}`}
                      inputMode="decimal"
                      defaultValue={typed(`total:${row.student.id}`, row.totalScore)}
                      disabled={row.locked}
                      aria-label={`Total for ${row.student.firstName} ${row.student.lastName}`}
                      className={markClass}
                    />
                  </td>
                )}
                <td className="px-4 py-2 text-right tabular-nums text-slate-700">{value(row.totalScore) || "—"}</td>
                <td className="px-4 py-2 text-slate-700">{row.grade ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 p-4">
        <p className="text-xs text-slate-500">
          Leave a box empty where the records have nothing. Totals, grades and positions are worked
          out when you save, on the school&rsquo;s grading scale.
        </p>
        <SubmitButton pendingLabel="Saving…">Save records</SubmitButton>
      </div>
    </form>
  );
}
