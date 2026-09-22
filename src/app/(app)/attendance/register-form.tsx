"use client";

import { useActionState, useMemo, useState } from "react";
import type { AttendanceMark } from "@prisma/client";
import { saveRegister, type RegisterState } from "@/lib/attendance-actions";
import { SubmitButton } from "../submit-button";
import { Alert } from "../ui";

export type RegisterRowView = {
  studentId: string;
  admissionNo: string;
  name: string;
  mark: AttendanceMark | null;
  note: string | null;
};

/**
 * Four marks, in the order a teacher reaches for them.
 *
 * Present first because it is the overwhelming majority of every register, and
 * Absent last because reaching past Late and Excused to get to it is a small
 * pause in exactly the place a pause is worth having.
 */
const MARKS: { value: AttendanceMark; short: string; label: string; tone: string }[] = [
  { value: "PRESENT", short: "P", label: "Present", tone: "bg-success-tint text-success-ink" },
  { value: "LATE", short: "L", label: "Late", tone: "bg-warning-tint text-warning-ink" },
  { value: "EXCUSED", short: "E", label: "Excused", tone: "bg-slate-200 text-slate-700" },
  { value: "ABSENT", short: "A", label: "Absent", tone: "bg-danger-tint text-danger-ink" },
];

export function RegisterForm({
  classGroupId,
  date,
  boys,
  girls,
  taken,
}: {
  classGroupId: string;
  date: string;
  boys: RegisterRowView[];
  girls: RegisterRowView[];
  taken: boolean;
}) {
  const [state, formAction] = useActionState<RegisterState, FormData>(saveRegister, {});
  const rows = useMemo(() => [...boys, ...girls], [boys, girls]);

  const [marks, setMarks] = useState<Record<string, AttendanceMark | "">>(() =>
    Object.fromEntries(rows.map((row) => [row.studentId, row.mark ?? ""])),
  );
  const [notes, setNotes] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.map((row) => [row.studentId, row.note ?? ""])),
  );

  const counts = rows.reduce(
    (acc, row) => {
      const mark = marks[row.studentId];
      if (mark === "PRESENT" || mark === "LATE") acc.inSchool += 1;
      else if (mark === "EXCUSED" || mark === "ABSENT") acc.away += 1;
      else acc.unmarked += 1;
      return acc;
    },
    { inSchool: 0, away: 0, unmarked: 0 },
  );

  /**
   * The one button that makes a daily register survivable.
   *
   * A class of forty is thirty-eight taps of "Present" and two of something
   * else. Starting from all-present and correcting the exceptions is how the
   * paper register is actually kept, and it turns the job into the two marks
   * that carry information.
   */
  const markAllPresent = () =>
    setMarks(Object.fromEntries(rows.map((row) => [row.studentId, "PRESENT" as AttendanceMark])));

  const clearAll = () => setMarks(Object.fromEntries(rows.map((row) => [row.studentId, ""])));

  return (
    <form action={formAction}>
      <input type="hidden" name="classGroupId" value={classGroupId} />
      <input type="hidden" name="date" value={date} />

      <div className="flex flex-wrap items-center gap-2 border-b border-hairline p-4">
        <button
          type="button"
          onClick={markAllPresent}
          className="rounded-full bg-success-tint px-3 py-1.5 text-sm font-semibold text-success-ink transition hover:brightness-95"
        >
          Everyone present
        </button>
        <button
          type="button"
          onClick={clearAll}
          className="rounded-full border border-hairline px-3 py-1.5 text-sm font-semibold text-slate-600 transition hover:bg-slate-50"
        >
          Clear
        </button>
        <p className="ml-auto text-xs text-slate-500">
          {counts.inSchool} in school · {counts.away} away
          {counts.unmarked > 0 ? ` · ${counts.unmarked} not marked` : ""}
        </p>
      </div>

      <div className="divide-y divide-slate-100">
        {[
          { label: "Boys", rows: boys },
          { label: "Girls", rows: girls },
        ].map((section) =>
          section.rows.length === 0 ? null : (
            <div key={section.label}>
              <p className="bg-slate-50 px-4 py-1.5 text-xs font-extrabold uppercase tracking-wide text-slate-500">
                {section.label} ({section.rows.length})
              </p>
              {section.rows.map((row, index) => {
                const mark = marks[row.studentId];
                return (
                  <div
                    key={row.studentId}
                    className="flex flex-wrap items-center gap-3 border-t border-slate-100 px-4 py-2"
                  >
                    <span className="w-6 shrink-0 text-right text-xs tabular-nums text-slate-400">
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-slate-900">{row.name}</span>
                      <span className="font-mono text-xs text-slate-400">{row.admissionNo}</span>
                    </span>

                    <input type="hidden" name={`mark:${row.studentId}`} value={mark} />

                    <span className="flex shrink-0 gap-1">
                      {MARKS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          aria-pressed={mark === option.value}
                          aria-label={`${row.name}: ${option.label}`}
                          title={option.label}
                          onClick={() =>
                            setMarks((prev) => ({
                              ...prev,
                              // Pressing the mark a child already has takes it
                              // off, so a mis-tap has an undo that is not
                              // "guess what it was before".
                              [row.studentId]: prev[row.studentId] === option.value ? "" : option.value,
                            }))
                          }
                          className={`h-9 w-9 rounded-full text-sm font-extrabold transition ${
                            mark === option.value
                              ? option.tone
                              : "border border-hairline bg-surface text-slate-400 hover:bg-slate-50"
                          }`}
                        >
                          {option.short}
                        </button>
                      ))}
                    </span>

                    {mark === "EXCUSED" ? (
                      <input
                        type="text"
                        name={`note:${row.studentId}`}
                        value={notes[row.studentId] ?? ""}
                        onChange={(event) =>
                          setNotes((prev) => ({ ...prev, [row.studentId]: event.target.value }))
                        }
                        placeholder="Reason (sick, funeral…)"
                        maxLength={200}
                        className="w-full rounded-lg border border-hairline bg-surface px-3 py-1.5 text-sm sm:w-56"
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          ),
        )}
      </div>

      <div className="space-y-3 border-t border-hairline p-4">
        {state.error ? <Alert tone="error">{state.error}</Alert> : null}
        {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}

        <SubmitButton pendingLabel="Saving…">
          {taken ? "Update the register" : "Save the register"}
        </SubmitButton>
      </div>
    </form>
  );
}
