"use client";

import { useActionState } from "react";
import { saveApplicationFormAction, type AdmissionState } from "@/lib/admission-actions";
import { LIMITS } from "@/lib/admissions-rules";
import { buttonClass } from "../button-style";
import { Alert, inputClass } from "../ui";

/**
 * Open or close the parent-facing form, and write the note above it (test dates, what to bring).
 * Two submit buttons rather than a tick-box: React resets a form when its action returns and does not put a
 * controlled checkbox back, so a label that followed the box would then lie about the state.
 */
export function FormPanel({ link, open, note }: { link: string; open: boolean; note: string }) {
  const [state, action, pending] = useActionState<AdmissionState, FormData>(saveApplicationFormAction, {});
  return (
    <form action={action} className="space-y-3 px-4.5 py-4">
      <p className="text-sm text-slate-600">
        Parents apply on their phones from one link, with no login. The form is{" "}
        <strong className={open ? "text-success-ink" : "text-slate-900"}>{open ? "open" : "closed"}</strong>.
      </p>
      <div className="flex flex-wrap items-center gap-2 rounded-control bg-slate-100 px-3 py-2 text-sm">
        <span className="text-slate-500">Link to share:</span>
        <a href={link} target="_blank" rel="noreferrer" className="break-all font-mono text-[13px] font-semibold text-brand-ink hover:underline">
          {link}
        </a>
      </div>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-slate-700">Note shown above the form</span>
        <textarea
          name="note"
          rows={3}
          maxLength={LIMITS.intro}
          defaultValue={state.values?.note ?? note}
          placeholder="Entrance test on Saturdays at 9am. Bring the birth certificate and the last report."
          className={inputClass}
        />
      </label>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        {open ? (
          <>
            <button type="submit" name="open" value="1" disabled={pending} className={buttonClass("secondary")}>
              Save the note
            </button>
            <button type="submit" name="open" value="0" disabled={pending} className={buttonClass("danger")}>
              Close the form
            </button>
          </>
        ) : (
          <button type="submit" name="open" value="1" disabled={pending} className={buttonClass("primary")}>
            Open the form
          </button>
        )}
      </div>
    </form>
  );
}
