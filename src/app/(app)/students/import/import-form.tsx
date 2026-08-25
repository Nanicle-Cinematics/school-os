"use client";

import { useActionState } from "react";
import { commitImport, previewImport, type ImportState } from "@/lib/import-actions";
import { SubmitButton } from "../../submit-button";
import { Alert, EmptyRow, inputClass, tableHeadClass, thClass } from "../../ui";

export function ImportForm({ template }: { template: string }) {
  const [state, formAction] = useActionState<ImportState, FormData>(previewImport, {});

  return (
    <>
      <form action={formAction} className="space-y-3 p-4">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-slate-700">
            Paste the spreadsheet
          </span>
          <textarea
            name="csv"
            rows={8}
            defaultValue={state.csv ?? ""}
            placeholder={template}
            className={`${inputClass} font-mono text-xs`}
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-slate-700">
            …or choose a CSV file
          </span>
          <input type="file" name="file" accept=".csv,text/csv" className="text-sm" />
        </label>

        {state.error ? <Alert tone="error">{state.error}</Alert> : null}
        {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}

        <SubmitButton pendingLabel="Checking…">Check the file</SubmitButton>
      </form>

      {state.report ? <Report state={state} /> : null}
    </>
  );
}

function Report({ state }: { state: ImportState }) {
  const [commitState, commitAction] = useActionState<ImportState, FormData>(commitImport, {});
  const report = state.report!;

  return (
    <div className="border-t border-slate-200">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className={tableHeadClass}>
            <tr>
              <th className={thClass}>Line</th>
              <th className={thClass}>Name</th>
              <th className={thClass}>Class</th>
              <th className={thClass}>Guardian</th>
              <th className={thClass}>Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {report.rows.length === 0 ? (
              <EmptyRow colSpan={5}>Nothing to show.</EmptyRow>
            ) : (
              report.rows.map((row) => (
                <tr key={row.line} className={row.errors.length ? "bg-red-50/40" : ""}>
                  <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-slate-400">
                    {row.line}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 font-medium text-slate-900">
                    {row.name}
                    {row.admissionNo ? (
                      <span className="ml-2 font-mono text-xs font-normal text-slate-400">
                        {row.admissionNo}
                      </span>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                    {row.className || "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                    {row.guardian ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {row.errors.length ? (
                      <span className="text-red-700">{row.errors.join("; ")}</span>
                    ) : row.warnings.length ? (
                      <span className="text-amber-600">{row.warnings.join("; ")}</span>
                    ) : (
                      <span className="text-green-700">ready</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <form action={commitAction} className="space-y-3 border-t border-slate-100 p-4">
        <input type="hidden" name="csv" value={state.csv ?? ""} />

        {commitState.error ? <Alert tone="error">{commitState.error}</Alert> : null}
        {commitState.ok ? <Alert tone="success">{commitState.ok}</Alert> : null}

        <p className="text-xs text-slate-500">
          {report.ready} ready · {report.blocked} with problems
          {report.blocked ? " (those rows are skipped)" : ""}
        </p>

        {report.ready > 0 && !commitState.ok ? (
          <SubmitButton pendingLabel="Importing…">Import {report.ready} students</SubmitButton>
        ) : null}
      </form>
    </div>
  );
}
