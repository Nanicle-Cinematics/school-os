"use client";

import { useActionState, useRef, useState } from "react";
import { saveClassAssignments, type ClassState } from "@/lib/class-actions";
import { SubmitButton } from "../../submit-button";
import { Alert, inputClass, tableHeadClass, thClass } from "../../ui";

export type SubjectRow = {
  subjectId: string;
  name: string;
  code: string;
  staffId: string | null;
  previousStaffId: string | null;
};

export type TeacherOption = { id: string; firstName: string; lastName: string };

/**
 * Who teaches every subject in this class, on one screen and saved once.
 *
 * Two staffing models have to fit here without a mode switch. In KG and lower
 * primary one teacher takes the whole class, so "give every subject to…" fills
 * the column in a single click. At JHS each subject has its own teacher, so the
 * rows are edited individually. Both end in the same submit.
 */
export function AssignmentsForm({
  classGroupId,
  rows,
  teachers,
  previousYearName,
}: {
  classGroupId: string;
  rows: SubjectRow[];
  teachers: TeacherOption[];
  previousYearName: string | null;
}) {
  const [state, formAction] = useActionState<ClassState, FormData>(saveClassAssignments, {});
  const formRef = useRef<HTMLFormElement>(null);
  const [bulk, setBulk] = useState("");

  // Prefilled from last year where this year is empty, so a rollover is a
  // review rather than a retyping. Nothing is written until Save.
  const prefilled = rows.some((row) => !row.staffId && row.previousStaffId);

  function applyToAll(staffId: string) {
    setBulk(staffId);
    const form = formRef.current;
    if (!form || !staffId) return;
    for (const row of rows) {
      const select = form.elements.namedItem(`teacher:${row.subjectId}`);
      if (select instanceof HTMLSelectElement) select.value = staffId;
    }
  }

  const name = (teacher: TeacherOption) => `${teacher.firstName} ${teacher.lastName}`;

  return (
    <form ref={formRef} action={formAction}>
      <input type="hidden" name="classGroupId" value={classGroupId} />

      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}

      {previousYearName && prefilled ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          No assignments for this year yet, so the teachers below are carried over from{" "}
          {previousYearName}. Change anything that has moved, then save — nothing is written until
          you do.
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-3 border-b border-slate-100 p-4">
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
            Give every subject to
          </span>
          <select
            value={bulk}
            onChange={(event) => applyToAll(event.target.value)}
            className={inputClass}
          >
            <option value="">Choose a teacher…</option>
            {teachers.map((teacher) => (
              <option key={teacher.id} value={teacher.id}>
                {name(teacher)}
              </option>
            ))}
          </select>
        </label>
        <p className="mb-2 text-xs text-slate-500">
          For a class that has one teacher for everything. You can still change individual rows
          afterwards.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className={tableHeadClass}>
            <tr>
              <th className={thClass}>Subject</th>
              <th className={thClass}>Teacher</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr key={row.subjectId}>
                <td className="whitespace-nowrap px-4 py-2 text-slate-900">{row.name}</td>
                <td className="px-4 py-2">
                  <select
                    name={`teacher:${row.subjectId}`}
                    defaultValue={row.staffId ?? row.previousStaffId ?? ""}
                    className={inputClass}
                  >
                    <option value="">— nobody yet —</option>
                    {teachers.map((teacher) => (
                      <option key={teacher.id} value={teacher.id}>
                        {name(teacher)}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-slate-100 p-4">
        <p className="text-xs text-slate-500">
          A subject left as &ldquo;nobody yet&rdquo; has no teacher, and no one can enter its marks.
        </p>
        <SubmitButton>Save assignments</SubmitButton>
      </div>
    </form>
  );
}
