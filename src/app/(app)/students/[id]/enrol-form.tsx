"use client";

import { useActionState } from "react";
import { enrolStudent, type StudentState } from "@/lib/student-actions";
import { SubmitButton } from "../../submit-button";
import { Alert, Field, inputClass } from "../../ui";

type ClassOption = { id: string; name: string; level: { name: string } };

export function EnrolForm({
  studentId,
  classGroups,
  currentClassGroupId,
  yearName,
}: {
  studentId: string;
  classGroups: ClassOption[];
  currentClassGroupId: string | null;
  yearName: string | null;
}) {
  const [state, formAction] = useActionState<StudentState, FormData>(enrolStudent, {});

  if (!yearName) {
    return (
      <p className="p-4 text-sm text-slate-500">
        No academic year is marked current, so there is no roster to join. Set one in Settings.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-3 p-4">
      <input type="hidden" name="studentId" value={studentId} />

      <Field label={`Class for ${yearName}`}>
        <select
          name="classGroupId"
          required
          defaultValue={currentClassGroupId ?? ""}
          className={inputClass}
        >
          <option value="" disabled>
            Choose a class
          </option>
          {classGroups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.level.name} {group.name}
            </option>
          ))}
        </select>
      </Field>

      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}

      <SubmitButton pendingLabel="Placing…">
        {currentClassGroupId ? "Move to this class" : "Place in class"}
      </SubmitButton>
    </form>
  );
}
