"use client";

import { useActionState } from "react";
import { addCatalogueAction, checkCatalogueAction, type CatalogueState } from "@/lib/library-actions";
import { SubmitButton } from "../submit-button";
import { Alert, inputClass } from "../ui";

/**
 * Check, then add. The two buttons are two actions on one form, each with its own state. The text box shows what
 * the last action echoed back: React resets a form when its action returns, so without the echo a check would blank
 * the file it had just read. A file that was added is NOT echoed, or it could be added twice.
 */
export function CatalogueImport({ template }: { template: string }) {
  const [checked, check] = useActionState<CatalogueState, FormData>(checkCatalogueAction, {});
  const [added, add] = useActionState<CatalogueState, FormData>(addCatalogueAction, {});

  const csv = added.ok ? "" : (added.csv ?? checked.csv ?? "");
  const report = added.ok ? undefined : checked.report;
  const clean = report && report.problems.length === 0 && report.copies > 0;

  return (
    <form className="space-y-4 px-4.5 py-4">
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-slate-700">Paste the spreadsheet</span>
        <textarea name="csv" rows={9} defaultValue={csv} placeholder={template} className={`${inputClass} font-mono text-xs`} />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-slate-700">…or choose a CSV file</span>
        <input type="file" name="file" accept=".csv,text/csv" className="text-sm" />
      </label>

      {checked.error && !added.error ? <Alert tone="error">{checked.error}</Alert> : null}
      {added.error ? <Alert tone="error">{added.error}</Alert> : null}
      {added.ok ? <Alert tone="success">{added.ok}</Alert> : null}

      {report ? (
        report.problems.length > 0 ? (
          <div className="space-y-2">
            <Alert tone="error">
              {report.problems.length === 1 ? "1 problem" : `${report.problems.length} problems`} found. Nothing will be added until the file is put right.
            </Alert>
            <ul className="max-h-64 divide-y divide-hairline overflow-y-auto rounded-control border border-hairline text-sm">
              {report.problems.slice(0, 50).map((problem, index) => (
                <li key={`${problem.line}-${index}`} className="px-3 py-2">
                  <span className="font-semibold text-slate-900">{problem.line > 0 ? `Line ${problem.line}` : "File"}</span>
                  <span className="text-slate-600"> · {problem.message}</span>
                </li>
              ))}
            </ul>
            {report.problems.length > 50 ? <p className="text-xs text-slate-400">Showing the first 50.</p> : null}
          </div>
        ) : (
          <Alert tone="success">
            The file is ready: {report.books} {report.books === 1 ? "book" : "books"} and {report.copies} {report.copies === 1 ? "copy" : "copies"}. Nothing has been added yet.
          </Alert>
        )
      ) : null}

      <div className="flex flex-wrap gap-2">
        <SubmitButton variant={clean ? "secondary" : "primary"} formAction={check} pendingLabel="Checking…">
          Check the file
        </SubmitButton>
        {clean ? (
          <SubmitButton formAction={add} pendingLabel="Adding…">
            {`Add ${report!.copies} ${report!.copies === 1 ? "copy" : "copies"} to the library`}
          </SubmitButton>
        ) : null}
      </div>
    </form>
  );
}
