"use client";

import { useActionState } from "react";
import { saveEarlierClasses, type RecordsState } from "@/lib/records-actions";
import { SubmitButton } from "../../../submit-button";
import { Alert, inputClass, tableHeadClass, thClass } from "../../../ui";

type Row = {
  student: { id: string; firstName: string; lastName: string; admissionNo: string };
  savedClassGroupId: string | null;
  proposedClassGroupId: string | null;
  hasResults: boolean;
};

/**
 * One select per pupil, saved once. A pupil already placed shows that class;
 * anyone else shows the guess, which is why the note above the table says so
 * — a default nobody was told about reads as a fact.
 */
export function PlacementForm({
  yearId,
  yearName,
  classGroupId,
  rows,
  classes,
}: {
  yearId: string;
  yearName: string;
  classGroupId: string;
  rows: Row[];
  classes: { id: string; label: string }[];
}) {
  const [state, formAction] = useActionState<RecordsState, FormData>(saveEarlierClasses, {});
  const guessed = rows.filter((row) => !row.savedClassGroupId).length;

  return (
    <form action={formAction}>
      <input type="hidden" name="yearId" value={yearId} />
      <input type="hidden" name="classGroupId" value={classGroupId} />

      {state.ok || state.error || guessed > 0 ? (
        <div className="space-y-2 p-4">
          {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}
          {state.error ? <Alert tone="error">{state.error}</Alert> : null}
          {guessed > 0 ? (
            <p className="rounded-control bg-warning-tint px-3.5 py-2.5 text-sm text-warning-ink">
              {guessed} {guessed === 1 ? "pupil has" : "pupils have"} no class recorded for {yearName}{" "}
              yet, so the class shown is a guess from today&rsquo;s class. Correct anyone who repeated,
              changed stream or joined the school later, then save — nothing is written until you do.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className={tableHeadClass}>
            <tr>
              <th className={thClass}>Pupil</th>
              <th className={thClass}>Class in {yearName}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr key={row.student.id}>
                <td className="px-4 py-2">
                  <p className="font-medium text-slate-900">
                    {row.student.lastName}, {row.student.firstName}
                  </p>
                  <p className="text-xs text-slate-400">{row.student.admissionNo}</p>
                </td>
                <td className="px-4 py-2">
                  <select
                    name={`place:${row.student.id}`}
                    defaultValue={row.savedClassGroupId ?? row.proposedClassGroupId ?? ""}
                    className={inputClass}
                    disabled={row.hasResults}
                    title={row.hasResults ? `Results are recorded for ${yearName}; clear them to move this pupil` : undefined}
                  >
                    <option value="">Not at this school that year</option>
                    {classes.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  {row.hasResults ? (
                    <p className="mt-1 text-xs text-slate-500">Results recorded — placement is fixed.</p>
                  ) : !row.savedClassGroupId ? (
                    // "Not at this school" is the absence of a row, so it cannot
                    // be told apart from "never recorded" — a pupil saved that
                    // way is offered the guess again next time. Say so on the
                    // row, so a later save is a decision rather than an accident.
                    <p className="mt-1 text-xs text-warning-ink">Suggested — nothing saved for this pupil yet.</p>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 p-4">
        <p className="text-xs text-slate-500">
          &ldquo;Not at this school that year&rdquo; leaves that year empty for the pupil — the
          results screen will not list them for it, and this screen will suggest a class again.
        </p>
        <SubmitButton pendingLabel="Saving…">Save earlier classes</SubmitButton>
      </div>
    </form>
  );
}
