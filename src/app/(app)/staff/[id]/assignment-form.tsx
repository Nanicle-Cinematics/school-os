"use client";

import { useActionState } from "react";
import { addTeachingAssignment, type StaffState } from "@/lib/staff-actions";
import { SubmitButton } from "../../submit-button";
import { Alert, Field, inputClass } from "../../ui";

type SubjectOption = { id: string; name: string; code: string };
type ClassOption = { id: string; name: string; level: { name: string } };

export function AssignmentForm({
  staffId,
  subjects,
  classGroups,
}: {
  staffId: string;
  subjects: SubjectOption[];
  classGroups: ClassOption[];
}) {
  const [state, formAction] = useActionState<StaffState, FormData>(addTeachingAssignment, {});

  return (
    <form action={formAction} className="space-y-3 p-4">
      <input type="hidden" name="staffId" value={staffId} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Subject">
          <select name="subjectId" required defaultValue="" className={inputClass}>
            <option value="" disabled>
              Choose a subject
            </option>
            {subjects.map((subject) => (
              <option key={subject.id} value={subject.id}>
                {subject.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Class">
          <select name="classGroupId" required defaultValue="" className={inputClass}>
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
      </div>

      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}

      <SubmitButton pendingLabel="Adding…">Add assignment</SubmitButton>
    </form>
  );
}
