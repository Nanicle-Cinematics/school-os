"use client";

import { useActionState, useState } from "react";
import { saveSubjectLevels, type SubjectState } from "@/lib/subject-actions";
import { SubmitButton } from "../../submit-button";
import { Alert, tableHeadClass, thClass } from "../../ui";

type Row = {
  level: { id: string; code: string; name: string };
  offered: boolean;
  isElective: boolean;
  countsForAggregate: boolean;
};

export function LevelsForm({ subjectId, rows }: { subjectId: string; rows: Row[] }) {
  const [state, formAction] = useActionState<SubjectState, FormData>(saveSubjectLevels, {});
  // Held in state only so the per-level flags visibly grey out when a level is
  // unticked; the server re-reads the checkboxes regardless.
  const [offered, setOffered] = useState(
    () => new Set(rows.filter((row) => row.offered).map((row) => row.level.id)),
  );

  function toggle(levelId: string, on: boolean) {
    setOffered((prev) => {
      const next = new Set(prev);
      if (on) {
        next.add(levelId);
      } else {
        next.delete(levelId);
      }
      return next;
    });
  }

  return (
    <form action={formAction}>
      <input type="hidden" name="subjectId" value={subjectId} />

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className={tableHeadClass}>
            <tr>
              <th className={thClass}>Level</th>
              <th className={thClass}>Offered</th>
              <th className={thClass}>Elective</th>
              <th className={thClass}>Counts for aggregate</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => {
              const on = offered.has(row.level.id);
              return (
                <tr key={row.level.id} className={on ? "" : "text-slate-400"}>
                  <td className="whitespace-nowrap px-4 py-2 font-medium text-slate-900">
                    {row.level.name}
                  </td>
                  <td className="px-4 py-2">
                    <input
                      type="checkbox"
                      name="offered"
                      value={row.level.id}
                      defaultChecked={row.offered}
                      onChange={(event) => toggle(row.level.id, event.target.checked)}
                      className="h-4 w-4"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <input
                      type="checkbox"
                      name={`elective:${row.level.id}`}
                      defaultChecked={row.isElective}
                      disabled={!on}
                      className="h-4 w-4"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <input
                      type="checkbox"
                      name={`aggregate:${row.level.id}`}
                      defaultChecked={row.countsForAggregate}
                      disabled={!on}
                      className="h-4 w-4"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="space-y-3 border-t border-slate-100 p-4">
        {state.error ? <Alert tone="error">{state.error}</Alert> : null}
        {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}
        <SubmitButton pendingLabel="Saving…">Save levels</SubmitButton>
      </div>
    </form>
  );
}
