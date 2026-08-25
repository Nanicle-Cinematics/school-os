"use client";

import { useActionState } from "react";
import { linkStudent, type GuardianState } from "@/lib/guardian-actions";
import { SubmitButton } from "../../submit-button";
import { Alert, Field, inputClass } from "../../ui";

type StudentOption = { id: string; firstName: string; lastName: string; admissionNo: string };

const RELATIONSHIPS = [
  ["MOTHER", "Mother"],
  ["FATHER", "Father"],
  ["GRANDPARENT", "Grandparent"],
  ["UNCLE", "Uncle"],
  ["AUNT", "Aunt"],
  ["SIBLING", "Sibling"],
  ["GUARDIAN", "Guardian"],
  ["OTHER", "Other"],
] as const;

export function LinkStudentForm({
  guardianId,
  students,
}: {
  guardianId: string;
  students: StudentOption[];
}) {
  const [state, formAction] = useActionState<GuardianState, FormData>(linkStudent, {});

  if (students.length === 0) {
    return (
      <p className="p-4 text-sm text-slate-500">
        Every student on roll is already linked to this guardian.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-3 p-4">
      <input type="hidden" name="guardianId" value={guardianId} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Student">
          <select name="studentId" required defaultValue="" className={inputClass}>
            <option value="" disabled>
              Choose a student
            </option>
            {students.map((student) => (
              <option key={student.id} value={student.id}>
                {student.lastName}, {student.firstName} · {student.admissionNo}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Relationship">
          <select name="relationship" defaultValue="GUARDIAN" className={inputClass}>
            {RELATIONSHIPS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="flex flex-wrap gap-4 text-sm text-slate-700">
        <label className="flex items-center gap-2">
          <input type="checkbox" name="isPrimary" className="h-4 w-4" />
          Primary guardian
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="receivesBills" defaultChecked className="h-4 w-4" />
          Receives bills
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="receivesReports" defaultChecked className="h-4 w-4" />
          Receives results
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="isEmergencyContact" className="h-4 w-4" />
          Emergency contact
        </label>
      </div>

      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}

      <SubmitButton pendingLabel="Linking…">Link student</SubmitButton>
    </form>
  );
}
