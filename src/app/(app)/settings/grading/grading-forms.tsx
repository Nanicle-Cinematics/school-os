"use client";

import { useActionState, useState } from "react";
import { deleteBand, saveBand, saveScale, type GradingState } from "@/lib/grading-actions";
import { SubmitButton } from "../../submit-button";
import { Alert, inputClass } from "../../ui";

export type Band = {
  id: string;
  grade: string;
  minScore: string;
  maxScore: string;
  points: number;
  remark: string;
  isPass: boolean;
};

function Feedback({ state }: { state: GradingState }) {
  if (!state.error && !state.ok) {
    return null;
  }
  return (
    <div className="mt-2">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}
    </div>
  );
}

function BandFields({ band }: { band?: Band }) {
  return (
    <div className="grid flex-1 gap-2 sm:grid-cols-6">
      <input
        type="text"
        name="grade"
        required
        placeholder="A1"
        defaultValue={band?.grade ?? ""}
        aria-label="Grade"
        className={inputClass}
      />
      <input
        type="number"
        name="minScore"
        required
        min={0}
        max={100}
        step="0.01"
        placeholder="From"
        defaultValue={band?.minScore ?? ""}
        aria-label="Lowest score"
        className={inputClass}
      />
      <input
        type="number"
        name="maxScore"
        required
        min={0}
        max={100}
        step="0.01"
        placeholder="To"
        defaultValue={band?.maxScore ?? ""}
        aria-label="Highest score"
        className={inputClass}
      />
      <input
        type="number"
        name="points"
        required
        min={0}
        placeholder="Points"
        defaultValue={band?.points ?? ""}
        aria-label="Aggregate points"
        className={inputClass}
      />
      <input
        type="text"
        name="remark"
        required
        placeholder="Excellent"
        defaultValue={band?.remark ?? ""}
        aria-label="Remark"
        className={`${inputClass} sm:col-span-2`}
      />
    </div>
  );
}

function BandRow({ scaleId, band }: { scaleId: string; band: Band }) {
  const [state, formAction] = useActionState<GradingState, FormData>(saveBand, {});

  return (
    <li className="border-t border-slate-100 p-3">
      <div className="flex flex-wrap items-start gap-2">
        <form action={formAction} className="flex flex-1 flex-wrap items-start gap-2">
          <input type="hidden" name="gradingScaleId" value={scaleId} />
          <input type="hidden" name="id" value={band.id} />
          <BandFields band={band} />
          <label className="flex items-center gap-1.5 self-center whitespace-nowrap text-xs text-slate-600">
            <input type="checkbox" name="isPass" defaultChecked={band.isPass} className="h-4 w-4" />
            pass
          </label>
          <SubmitButton variant="secondary" pendingLabel="…">
            Save
          </SubmitButton>
        </form>

        <form action={deleteBand} className="self-center">
          <input type="hidden" name="id" value={band.id} />
          <input type="hidden" name="gradingScaleId" value={scaleId} />
          <SubmitButton variant="danger" pendingLabel="…">
            Delete
          </SubmitButton>
        </form>
      </div>
      <Feedback state={state} />
    </li>
  );
}

export function BandEditor({ scaleId, bands }: { scaleId: string; bands: Band[] }) {
  const [state, formAction] = useActionState<GradingState, FormData>(saveBand, {});

  return (
    <>
      <ul>
        {bands.map((band) => (
          <BandRow key={band.id} scaleId={scaleId} band={band} />
        ))}
      </ul>

      <div className="border-t border-slate-100 bg-slate-50/60 p-3">
        <form action={formAction} className="flex flex-wrap items-start gap-2">
          <input type="hidden" name="gradingScaleId" value={scaleId} />
          <BandFields />
          <label className="flex items-center gap-1.5 self-center whitespace-nowrap text-xs text-slate-600">
            <input type="checkbox" name="isPass" defaultChecked className="h-4 w-4" />
            pass
          </label>
          <SubmitButton pendingLabel="Adding…">Add band</SubmitButton>
        </form>
        <Feedback state={state} />
      </div>
    </>
  );
}

export function ScaleNameForm({
  scale,
  isDefault,
}: {
  scale: { id: string; name: string };
  isDefault: boolean;
}) {
  const [state, formAction] = useActionState<GradingState, FormData>(saveScale, {});

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2 p-3">
      <input type="hidden" name="id" value={scale.id} />
      <input
        type="text"
        name="name"
        required
        defaultValue={scale.name}
        aria-label="Scale name"
        className={`${inputClass} max-w-72`}
      />
      <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-slate-600">
        <input
          type="checkbox"
          name="isDefault"
          defaultChecked={isDefault}
          disabled={isDefault}
          className="h-4 w-4"
        />
        {isDefault ? "is the default" : "make default"}
      </label>
      <SubmitButton variant="secondary" pendingLabel="…">
        Save
      </SubmitButton>
      <div className="w-full">
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function NewScaleForm() {
  const [state, formAction] = useActionState<GradingState, FormData>(saveScale, {});
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white shadow-[0_6px_16px_rgba(18,128,92,0.22)] transition hover:bg-brand-700"
      >
        New scale
      </button>
    );
  }

  return (
    <form action={formAction} className="w-full rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">New grading scale</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-sm text-slate-500 hover:text-slate-900"
        >
          Cancel
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          name="name"
          required
          placeholder="Basic School 1–9"
          aria-label="Scale name"
          className={`${inputClass} max-w-72`}
        />
        <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-slate-600">
          <input type="checkbox" name="isDefault" className="h-4 w-4" />
          make default
        </label>
        <SubmitButton pendingLabel="Creating…">Create</SubmitButton>
      </div>

      <Feedback state={state} />
      <p className="mt-2 text-xs text-slate-400">Add its bands once it exists.</p>
    </form>
  );
}
