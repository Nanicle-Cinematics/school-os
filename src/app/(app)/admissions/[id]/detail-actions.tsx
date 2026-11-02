"use client";

import { useActionState } from "react";
import type { ApplicationStatus } from "@prisma/client";
import {
  admitApplicationAction,
  deleteApplicationAction,
  moveApplicationAction,
  recordTestAction,
  type AdmissionState,
} from "@/lib/admission-actions";
import { LIMITS } from "@/lib/admissions-rules";
import { buttonClass, type ButtonVariant } from "../../button-style";
import { SubmitButton } from "../../submit-button";
import { Alert, inputClass } from "../../ui";
import Link from "next/link";

const Message = ({ state }: { state: AdmissionState }) =>
  state.error ? <Alert tone="error">{state.error}</Alert> : state.ok ? <Alert tone="success">{state.ok}</Alert> : null;

/** The entrance test or interview: a day, a mark out of 100 and a note. Recording one starts a fresh application. */
export function TestForm({
  id,
  testedOn,
  testScore,
  testNotes,
  locked,
}: {
  id: string;
  testedOn: string;
  testScore: string;
  testNotes: string;
  locked: boolean;
}) {
  const [state, action] = useActionState<AdmissionState, FormData>(recordTestAction, {});
  const v = (key: string, saved: string) => state.values?.[key] ?? saved;
  return (
    <form action={action} className="space-y-3 px-4.5 py-4">
      <input type="hidden" name="id" value={id} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-slate-700">Date of the test or interview</span>
          <input type="date" name="testedOn" defaultValue={v("testedOn", testedOn)} disabled={locked} className={inputClass} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-slate-700">Mark out of 100</span>
          <input name="testScore" inputMode="decimal" defaultValue={v("testScore", testScore)} disabled={locked} placeholder="Leave blank if not marked" className={inputClass} />
        </label>
      </div>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-slate-700">Notes</span>
        <textarea name="testNotes" rows={2} maxLength={LIMITS.testNotes} defaultValue={v("testNotes", testNotes)} disabled={locked} className={inputClass} />
      </label>
      <Message state={state} />
      {locked ? null : <SubmitButton variant="secondary" pendingLabel="Saving…">Save the result</SubmitButton>}
    </form>
  );
}

/** One step in the pipeline, as a small form of its own. */
export function MoveForm({
  id,
  to,
  label,
  variant = "secondary",
  withExpiry = false,
  withNote = false,
}: {
  id: string;
  to: ApplicationStatus;
  label: string;
  variant?: ButtonVariant;
  withExpiry?: boolean;
  withNote?: boolean;
}) {
  const [state, action] = useActionState<AdmissionState, FormData>(moveApplicationAction, {});
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="to" value={to} />
      {withExpiry ? (
        <label className="block">
          <span className="mb-1 block text-xs text-slate-500">Offer valid until (optional)</span>
          <input type="date" name="offerExpiresOn" className={inputClass} />
        </label>
      ) : null}
      {withNote ? <input name="note" maxLength={LIMITS.decisionNote} placeholder="Note (optional)" className={inputClass} /> : null}
      <SubmitButton variant={variant} pendingLabel="Working…">{label}</SubmitButton>
      <Message state={state} />
    </form>
  );
}

/** Turn an accepted application into a pupil. A class is needed when the child starts in the current year. */
export function AdmitForm({
  id,
  classes,
  needsClass,
}: {
  id: string;
  classes: { id: string; label: string; full: boolean }[];
  needsClass: boolean;
}) {
  const [state, action] = useActionState<AdmissionState, FormData>(admitApplicationAction, {});
  return (
    <form action={action} className="space-y-3 px-4.5 py-4">
      <input type="hidden" name="id" value={id} />
      {needsClass ? (
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-slate-700">Place in class</span>
          <select name="classGroupId" required defaultValue="" className={inputClass}>
            <option value="" disabled>
              Choose a class
            </option>
            {classes.map((c) => (
              <option key={c.id} value={c.id} disabled={c.full}>
                {c.label}
                {c.full ? " (full)" : ""}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="text-sm text-slate-600">
          This child starts in a later year. They are admitted now without a class, and placed once that year begins.
        </p>
      )}
      <Message state={state} />
      {state.studentId ? (
        <Link href={`/students/${state.studentId}`} className="text-sm font-semibold text-brand-ink hover:underline">
          Open the pupil&apos;s record
        </Link>
      ) : (
        <SubmitButton variant="primary" pendingLabel="Admitting…">Admit as a pupil</SubmitButton>
      )}
    </form>
  );
}

export function DeleteForm({ id }: { id: string }) {
  return (
    <form action={deleteApplicationAction} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="id" value={id} />
      <label className="flex items-center gap-2 text-sm text-slate-600">
        <input type="checkbox" name="confirm" required />
        Yes, delete it for good
      </label>
      <button type="submit" className={buttonClass("danger", "sm")}>
        Delete this application
      </button>
    </form>
  );
}
