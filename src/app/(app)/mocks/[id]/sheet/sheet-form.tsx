"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { saveMockSheet, type MockState } from "@/lib/mock-actions";
import { SubmitButton } from "../../../submit-button";
import { Alert, Avatar, inputClass } from "../../../ui";

type Student = { id: string; firstName: string; lastName: string; admissionNo: string };
type Band = { grade: string; min: number; max: number };

/** The grade a typed mark will get, shown as the teacher types. */
function gradeOf(bands: Band[], value: number) {
  return (
    bands.find((b) => value >= b.min && value <= b.max)?.grade ??
    [...bands].filter((b) => value >= b.min).sort((a, b) => b.min - a.min)[0]?.grade ??
    null
  );
}

export function MockSheetForm({
  mockExamId,
  classGroupId,
  subjectId,
  students,
  scoreFor,
  bands,
  locked,
}: {
  mockExamId: string;
  classGroupId: string;
  subjectId: string;
  students: Student[];
  scoreFor: Record<string, { rawScore: string | null; isAbsent: boolean }>;
  bands: Band[];
  locked: boolean;
}) {
  const [state, formAction] = useActionState<MockState, FormData>(saveMockSheet, {});
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(students.map((s) => [s.id, scoreFor[s.id]?.rawScore ?? ""])),
  );
  const [absent, setAbsent] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(students.map((s) => [s.id, scoreFor[s.id]?.isAbsent ?? false])),
  );

  // React resets the form once the action returns, and a controlled checkbox
  // is NOT put back (CLAUDE.md). Without this an "absent" tick disappears from
  // the screen after a save — or after a refusal — while state still holds it.
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      for (const box of formRef.current?.querySelectorAll<HTMLInputElement>('input[name^="absent:"]') ?? []) {
        box.checked = absent[box.name.slice("absent:".length)] ?? false;
      }
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const entered = students.filter((s) => absent[s.id] || values[s.id]?.trim()).length;

  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      <input type="hidden" name="mockExamId" value={mockExamId} />
      <input type="hidden" name="classGroupId" value={classGroupId} />
      <input type="hidden" name="subjectId" value={subjectId} />

      <section className="overflow-hidden rounded-card border border-hairline bg-surface shadow-card">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="px-4 py-2.5 font-extrabold">Candidate</th>
              <th className="px-4 py-2.5 text-right font-extrabold">Mark / 100</th>
              <th className="px-4 py-2.5 text-right font-extrabold">Grade</th>
              <th className="px-4 py-2.5 text-center font-extrabold">Absent</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {students.map((student) => {
              const raw = values[student.id] ?? "";
              const number = raw.trim() === "" ? null : Number(raw);
              const valid = number === null || (Number.isFinite(number) && number >= 0 && number <= 100);
              const grade = absent[student.id] ? gradeOf(bands, 0) : number !== null && valid ? gradeOf(bands, number) : null;
              return (
                <tr key={student.id}>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-3">
                      <Avatar firstName={student.firstName} lastName={student.lastName} />
                      <div className="min-w-0">
                        <p className="truncate font-medium text-slate-900">
                          {student.lastName}, {student.firstName}
                        </p>
                        <p className="font-mono text-xs text-slate-400">{student.admissionNo}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <input
                      type="text"
                      inputMode="decimal"
                      name={`score:${student.id}`}
                      aria-label={`Mark for ${student.firstName} ${student.lastName}`}
                      value={raw}
                      disabled={locked || absent[student.id]}
                      onChange={(event) => setValues((v) => ({ ...v, [student.id]: event.target.value }))}
                      className={`${inputClass} ml-auto max-w-24 text-right tabular-nums ${valid ? "" : "border-danger-ink"}`}
                    />
                  </td>
                  <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-700">{grade ?? "—"}</td>
                  <td className="px-4 py-2 text-center">
                    <input
                      type="checkbox"
                      name={`absent:${student.id}`}
                      aria-label={`${student.firstName} ${student.lastName} was absent`}
                      checked={absent[student.id] ?? false}
                      disabled={locked}
                      onChange={(event) => setAbsent((a) => ({ ...a, [student.id]: event.target.checked }))}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <p className="text-xs text-slate-500">
        {entered} of {students.length} entered. Leave a mark blank if the paper is not marked yet; tick
        absent for a candidate who did not sit it, which counts as 0.
      </p>

      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}

      {!locked ? <SubmitButton pendingLabel="Saving…">Save marks</SubmitButton> : null}
    </form>
  );
}
