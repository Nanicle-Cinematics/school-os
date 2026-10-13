"use client";

import { useActionState, useMemo, useState } from "react";
import { saveSheet, type SheetState } from "@/lib/sheet-actions";
import { checkScore } from "@/lib/score-limits";
import { SubmitButton } from "../../submit-button";
import { Alert, Avatar, ScoreBadge } from "../../ui";

type Column = {
  id: string;
  title: string;
  maxScore: number;
  isExam: boolean;
  status: string;
  marked: number;
};
type Student = { id: string; firstName: string; lastName: string; admissionNo: string };
type Cell = { rawScore: string | null; isAbsent: boolean };

/**
 * The running class score, computed in the browser from what is typed.
 *
 * Mirrors the server engine exactly: each component's percentage weighted by
 * its own maximum reduces to (marks earned / marks available), scaled to the
 * school's class and exam split. A teacher who cannot see the effect of a mark
 * until after publishing is marking blind.
 */
function totalsFor(
  columns: Column[],
  values: Record<string, string>,
  absent: Record<string, boolean>,
  maxima: Record<string, string>,
  studentId: string,
  classWeight: number,
  examWeight: number,
) {
  const part = (items: Column[], outOf: number) => {
    let earned = 0;
    let available = 0;
    let any = false;

    for (const column of items) {
      const key = `${column.id}:${studentId}`;
      const max = Number(maxima[column.id] ?? column.maxScore);
      if (!Number.isFinite(max) || max <= 0) continue;

      if (absent[key]) {
        available += max;
        any = true;
        continue;
      }
      const raw = values[key];
      if (raw === undefined || raw.trim() === "") continue;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) continue;

      earned += parsed;
      available += max;
      any = true;
    }

    if (!any || available <= 0) return null;
    return (earned / available) * outOf;
  };

  const classPart = part(columns.filter((c) => !c.isExam), classWeight);
  const examPart = part(columns.filter((c) => c.isExam), examWeight);
  if (classPart === null && examPart === null) return null;
  return { classPart, examPart, total: (classPart ?? 0) + (examPart ?? 0) };
}

export function SheetForm({
  termId,
  classGroupId,
  subjectId,
  columns,
  students,
  scoreFor,
  classWeight,
  examWeight,
  isLeadership,
}: {
  termId: string;
  classGroupId: string;
  subjectId: string;
  columns: Column[];
  students: Student[];
  scoreFor: Record<string, Cell>;
  classWeight: number;
  examWeight: number;
  /**
   * ⚠️ Only leadership may raise a component's ceiling from here — see the
   * matching guard in saveSheet. A plain teacher's max-marks box is locked to
   * what Settings → Assessment components assigned, or the server-side cap
   * would be trivially bypassable by anyone who could still edit this box even
   * though their submitted value is now ignored.
   */
  isLeadership: boolean;
}) {
  const [state, formAction] = useActionState<SheetState, FormData>(saveSheet, {});

  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const [key, cell] of Object.entries(scoreFor)) {
      initial[key] = cell.rawScore ?? "";
    }
    return initial;
  });
  const [absent, setAbsent] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const [key, cell] of Object.entries(scoreFor)) {
      if (cell.isAbsent) initial[key] = true;
    }
    return initial;
  });
  const [maxima, setMaxima] = useState<Record<string, string>>(() =>
    Object.fromEntries(columns.map((c) => [c.id, String(c.maxScore)])),
  );

  const marksAvailable = useMemo(
    () =>
      columns
        .filter((c) => !c.isExam)
        .reduce((sum, c) => sum + (Number(maxima[c.id]) || 0), 0),
    [columns, maxima],
  );

  // Every cell the server would refuse, by the SAME rule (`checkScore`, which `saveSheet` decides
  // with), so this screen cannot accept a mark the save will then reject. An absent pupil's box is
  // not sent as a mark, so it is not judged; an approved column is skipped by the server, so it is
  // skipped here.
  const problems = useMemo(() => {
    const found = new Map<string, string>();
    for (const column of columns) {
      if (column.status === "APPROVED") continue;
      const max = Number(maxima[column.id]);
      for (const student of students) {
        const key = `${column.id}:${student.id}`;
        if (absent[key]) continue;
        const verdict = checkScore(values[key] ?? "", max);
        if (!verdict.ok) {
          found.set(key, `${student.lastName}, ${column.title}: ${verdict.reason}`);
        }
      }
    }
    return found;
  }, [columns, students, values, absent, maxima]);
  const blocked = problems.size > 0;
  const firstProblem = problems.values().next().value as string | undefined;

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="termId" value={termId} />
      <input type="hidden" name="classGroupId" value={classGroupId} />
      <input type="hidden" name="subjectId" value={subjectId} />

      <div className="overflow-x-auto rounded-card border border-hairline bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/60">
              <th className="sticky left-0 z-10 bg-slate-50 px-3 py-2.5 text-left text-[10.5px] font-extrabold text-slate-400">
                Pupil
              </th>
              {columns.map((column) => (
                <th key={column.id} className="px-2 py-2 text-center align-top">
                  <p className="text-[11px] font-extrabold text-slate-500">{column.title}</p>
                  <label className="mt-1 flex items-center justify-center gap-1">
                    <span className="sr-only">Total marks for {column.title}</span>
                    <span className="text-xs text-slate-400">/</span>
                    <input
                      type="number"
                      // No `name` at all when locked — a disabled input is not
                      // submitted by a browser, but this also keeps a raw POST
                      // replay from finding a max: field to forge. saveSheet
                      // ignores one anyway, but the field not existing here is
                      // one less thing to reason about.
                      name={isLeadership ? `max:${column.id}` : undefined}
                      min={1}
                      max={1000}
                      step="1"
                      value={maxima[column.id] ?? ""}
                      disabled={!isLeadership || column.status === "APPROVED"}
                      onChange={(e) =>
                        setMaxima((prev) => ({ ...prev, [column.id]: e.target.value }))
                      }
                      className="w-14 rounded-md border border-slate-200 px-1 py-0.5 text-center text-xs font-semibold tabular-nums outline-none focus:border-brand-500 disabled:bg-slate-100 disabled:text-slate-400"
                      aria-label={`Total marks for ${column.title}`}
                    />
                  </label>
                  {column.status === "APPROVED" ? (
                    <p className="mt-0.5 text-[10px] text-warning-ink">locked</p>
                  ) : !isLeadership ? (
                    <p className="mt-0.5 text-[10px] text-slate-400">set by the school</p>
                  ) : null}
                </th>
              ))}
              <th className="px-3 py-2.5 text-right text-[10.5px] font-extrabold text-slate-400">
                Class ({classWeight})
              </th>
              <th className="px-3 py-2.5 text-right text-[10.5px] font-extrabold text-slate-400">
                Exam ({examWeight})
              </th>
              <th className="px-3 py-2.5 text-center text-[10.5px] font-extrabold text-slate-400">
                Total
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {students.map((student) => {
              const totals = totalsFor(
                columns,
                values,
                absent,
                maxima,
                student.id,
                classWeight,
                examWeight,
              );
              return (
                <tr key={student.id} className="hover:bg-slate-50/60">
                  <td className="sticky left-0 z-10 bg-surface px-3 py-2">
                    <div className="flex items-center gap-2.5">
                      <Avatar firstName={student.firstName} lastName={student.lastName} size="sm" />
                      <div className="min-w-0">
                        <p className="truncate font-bold text-slate-900">
                          {student.lastName}, {student.firstName}
                        </p>
                        <p className="font-mono text-[11px] text-slate-400">
                          {student.admissionNo}
                        </p>
                      </div>
                    </div>
                  </td>

                  {columns.map((column) => {
                    const key = `${column.id}:${student.id}`;
                    const locked = column.status === "APPROVED";
                    const isAbsent = absent[key] ?? false;
                    return (
                      <td key={column.id} className="px-2 py-1.5 text-center">
                        <input
                          type="number"
                          name={`score:${column.id}:${student.id}`}
                          min={0}
                          max={Number(maxima[column.id]) || column.maxScore}
                          step="0.01"
                          aria-invalid={problems.has(key) ? true : undefined}
                          value={isAbsent ? "" : (values[key] ?? "")}
                          disabled={locked || isAbsent}
                          onChange={(e) =>
                            setValues((prev) => ({ ...prev, [key]: e.target.value }))
                          }
                          className={`w-[3.75rem] rounded-lg border-[1.5px] px-1.5 py-1.5 text-center font-semibold tabular-nums outline-none transition focus:ring-2 ${problems.has(key) ? "border-danger-ink bg-danger-tint text-danger-ink focus:border-danger-ink focus:ring-danger-ink/25" : "border-slate-200 focus:border-brand-500 focus:ring-brand-500/25"} disabled:bg-slate-100 disabled:font-normal`}
                          aria-label={`${column.title} for ${student.firstName} ${student.lastName}`}
                        />
                        <label className="mt-0.5 flex items-center justify-center gap-1 text-[10px] text-slate-400">
                          <input
                            type="checkbox"
                            name={`absent:${column.id}:${student.id}`}
                            checked={isAbsent}
                            disabled={locked}
                            onChange={(e) =>
                              setAbsent((prev) => ({ ...prev, [key]: e.target.checked }))
                            }
                            className="h-3 w-3"
                          />
                          abs
                        </label>
                      </td>
                    );
                  })}

                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                    {totals?.classPart != null ? totals.classPart.toFixed(1) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                    {totals?.examPart != null ? totals.examPart.toFixed(1) : "—"}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <ScoreBadge value={totals ? totals.total : null} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {blocked ? (
        <Alert tone="error">
          {problems.size === 1 ? "1 mark is" : `${problems.size} marks are`} out of range and{" "}
          {problems.size === 1 ? "is" : "are"} marked in red. Fix {problems.size === 1 ? "it" : "them"}{" "}
          to save. First: {firstProblem}
        </Alert>
      ) : null}
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Saving…" disabled={blocked}>
          Save the sheet
        </SubmitButton>
        <p className="text-xs text-slate-500">
          The class components are worth {marksAvailable} marks in total, scaled to {classWeight}.
          Blank means not marked yet; <span className="font-medium">abs</span> counts as zero.
        </p>
      </div>
    </form>
  );
}
