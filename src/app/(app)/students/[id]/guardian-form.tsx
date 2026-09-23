"use client";

import { useActionState } from "react";
import { linkStudent, type GuardianState } from "@/lib/guardian-actions";
import { addGuardianToStudent, type StudentState } from "@/lib/student-actions";
import { SubmitButton } from "../../submit-button";
import { Alert, Field, inputClass } from "../../ui";

type GuardianOption = { id: string; firstName: string; lastName: string; phone: string };

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

function Flags() {
  return (
    <div className="mt-3 flex flex-wrap gap-4 text-sm text-slate-700">
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
  );
}

export function LinkExistingGuardianForm({
  studentId,
  guardians,
}: {
  studentId: string;
  guardians: GuardianOption[];
}) {
  const [state, formAction] = useActionState<GuardianState, FormData>(linkStudent, {});

  if (guardians.length === 0) {
    return <p className="p-4 text-sm text-slate-500">Every guardian on file is already linked to this student.</p>;
  }

  return (
    <form action={formAction} className="space-y-3 p-4">
      <input type="hidden" name="studentId" value={studentId} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Guardian">
          <select name="guardianId" required defaultValue="" className={inputClass}>
            <option value="" disabled>
              Choose a guardian
            </option>
            {guardians.map((guardian) => (
              <option key={guardian.id} value={guardian.id}>
                {guardian.lastName}, {guardian.firstName} · {guardian.phone}
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

      <Flags />

      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}

      <SubmitButton pendingLabel="Linking…">Link guardian</SubmitButton>
    </form>
  );
}

export function AddNewGuardianForm({ studentId }: { studentId: string }) {
  const [state, formAction] = useActionState<StudentState, FormData>(addGuardianToStudent, {});

  return (
    <form action={formAction} className="space-y-3 p-4">
      <input type="hidden" name="studentId" value={studentId} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Full name">
          <input type="text" name="guardianName" required placeholder="Kofi Mensah" className={inputClass} />
        </Field>

        <Field label="Phone" hint="A family already on file is matched by this number.">
          <input type="tel" name="guardianPhone" required placeholder="0244123456" className={inputClass} />
        </Field>

        <Field label="Relationship">
          <select name="guardianRelationship" defaultValue="GUARDIAN" className={inputClass}>
            {RELATIONSHIPS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Flags />

      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}

      <SubmitButton pendingLabel="Adding…">Add guardian</SubmitButton>
    </form>
  );
}
