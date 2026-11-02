"use client";

import { useActionState } from "react";
import { createApplicationAction, saveApplicationAction, type AdmissionState } from "@/lib/admission-actions";
import { ApplicationFields, type Option } from "@/app/apply/application-fields";
import { SubmitButton } from "../submit-button";
import { Alert } from "../ui";

/**
 * The office's own application form, for a walk-in or a phone call. New and edit share it.
 * A refusal hands back what was typed, so a clerk copying from a paper form loses nothing.
 */
export function ApplicationForm({
  mode,
  id,
  initial,
  levels,
  years,
}: {
  mode: "new" | "edit";
  id?: string;
  initial: Record<string, string>;
  levels: Option[];
  years: (Option & { isCurrent?: boolean })[];
}) {
  const [state, action] = useActionState<AdmissionState, FormData>(
    mode === "new" ? createApplicationAction : saveApplicationAction,
    {},
  );
  return (
    <form action={action} className="space-y-6">
      {id ? <input type="hidden" name="id" value={id} /> : null}
      <ApplicationFields defaults={state.values ?? initial} levels={levels} years={years} />
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <SubmitButton pendingLabel="Saving…">{mode === "new" ? "Record application" : "Save changes"}</SubmitButton>
    </form>
  );
}
