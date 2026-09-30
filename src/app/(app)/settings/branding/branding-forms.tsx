"use client";

import { useActionState, useRef, useState, type FormEvent } from "react";
import { uploadSchoolAsset, removeSchoolAsset, type AssetState } from "@/lib/asset-actions";
import { MAX_ASSET_BYTES } from "@/lib/asset-constants";
import { SubmitButton } from "../../submit-button";
import { Alert } from "../../ui";

export type AssetSlot = {
  kind: "CREST" | "LOGO" | "HEAD_SIGNATURE";
  title: string;
  blurb: string;
  /** Null when nothing has been uploaded. */
  url: string | null;
  /** How it is shown here, matching how it prints. */
  frame: "square" | "wide";
};

function Preview({ slot }: { slot: AssetSlot }) {
  const box =
    slot.frame === "square"
      ? "h-24 w-24 rounded-lg"
      : "h-16 w-48 rounded-lg";
  if (!slot.url) {
    return (
      <div
        className={`${box} flex items-center justify-center border border-dashed border-slate-300 bg-slate-50 text-center text-[11px] leading-tight text-slate-400`}
      >
        Nothing
        <br />
        uploaded
      </div>
    );
  }
  return (
    <div className={`${box} flex items-center justify-center border border-slate-200 bg-surface p-2`}>
      {/* Not next/image: this is a private, session-scoped route serving bytes
          straight from the row, so there is nothing for the optimiser to fetch. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={slot.url} alt={slot.title} className="max-h-full max-w-full object-contain" />
    </div>
  );
}

export function AssetForm({ slot }: { slot: AssetSlot }) {
  const [state, formAction] = useActionState<AssetState, FormData>(uploadSchoolAsset, {});
  const [chosen, setChosen] = useState<string | null>(null);
  // Caught before the request ever goes out. Server Actions cap the request
  // body well above MAX_ASSET_BYTES (see next.config.ts), but a phone photo
  // clears even that routinely — and without this check the person would
  // wait for a round trip just to get a platform-level failure instead of a
  // clear reason. Independent of `state.error`: this fires pre-submission,
  // before useActionState has anything to report.
  const [clientError, setClientError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    const file = inputRef.current?.files?.[0];
    if (file && file.size > MAX_ASSET_BYTES) {
      event.preventDefault();
      setClientError(
        `That file is ${Math.round(file.size / 1024)} KB. Keep it under ${MAX_ASSET_BYTES / 1024} KB — a crest does not need more.`,
      );
    }
  }

  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:gap-5">
      <Preview slot={slot} />

      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold text-slate-900">{slot.title}</h3>
        <p className="mt-0.5 text-xs text-slate-500">{slot.blurb}</p>

        {clientError ? (
          <div className="mt-2">
            <Alert tone="error">{clientError}</Alert>
          </div>
        ) : state.error ? (
          <div className="mt-2">
            <Alert tone="error">{state.error}</Alert>
          </div>
        ) : null}
        {!clientError && state.ok ? (
          <div className="mt-2">
            <Alert tone="success">{state.ok}</Alert>
          </div>
        ) : null}

        <form
          action={formAction}
          onSubmit={handleSubmit}
          className="mt-3 flex flex-wrap items-center gap-2"
        >
          <input type="hidden" name="kind" value={slot.kind} />
          <input
            ref={inputRef}
            type="file"
            name="file"
            accept="image/png,image/jpeg,image/webp"
            required
            onChange={(event) => {
              setClientError(null);
              setChosen(event.target.files?.[0]?.name ?? null);
            }}
            className="block w-full max-w-xs text-xs text-slate-600 file:mr-3 file:rounded-lg file:border file:border-slate-300 file:bg-surface file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-50"
          />
          <SubmitButton>{slot.url ? "Replace" : "Upload"}</SubmitButton>
        </form>

        {chosen ? <p className="mt-1.5 text-xs text-slate-400">Chosen: {chosen}</p> : null}

        {slot.url ? (
          <form action={removeSchoolAsset} className="mt-2">
            <input type="hidden" name="kind" value={slot.kind} />
            <button
              type="submit"
              className="text-xs font-medium text-danger-ink transition hover:text-danger-ink"
            >
              Remove
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
