"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { buttonClass } from "../button-style";
import { saveFeeStructure, type ActionState } from "@/lib/fee-actions";
import { SubmitButton } from "../submit-button";
import { Alert, Field, inputClass } from "../ui";

type Category = { id: string; name: string; code: string };
type Stage = "CRECHE" | "NURSERY" | "KINDERGARTEN" | "PRIMARY" | "JHS" | "SHS";
type Level = { id: string; name: string; stage: Stage };
type Term = { id: string; name: string; sequence: number };

/* The bands Ghanaian schools actually price by. Creche, nursery and KG share a
   band because schools quote them as one "pre-school" fee far more often than
   separately; any level can still be ticked on its own. */
const BANDS: { label: string; stages: Stage[] }[] = [
  { label: "Pre-school", stages: ["CRECHE", "NURSERY", "KINDERGARTEN"] },
  { label: "Primary", stages: ["PRIMARY"] },
  { label: "JHS", stages: ["JHS"] },
  { label: "SHS", stages: ["SHS"] },
];

export function StructureForm({
  levels,
  categories,
  terms,
  academicYearId,
  pricedLevelIds,
}: {
  levels: Level[];
  categories: Category[];
  terms: Term[];
  academicYearId: string;
  /** Levels with at least one structure this year, so a band can say which it would collide with. */
  pricedLevelIds: string[];
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [termId, setTermId] = useState("");
  const [residency, setResidency] = useState("ANY");
  const [studentType, setStudentType] = useState("ANY");
  const [open, setOpen] = useState(false);

  // A save clears the levels and amounts so the next band starts empty; the
  // conditions stay, because a bursar pricing Primary then JHS keeps them.
  const [state, formAction] = useActionState<ActionState, FormData>(async (prev, formData) => {
    const result = await saveFeeStructure(prev, formData);
    if (result.ok) {
      setSelected(new Set());
      setAmounts({});
    }
    return result;
  }, {});

  // React resets the form to its defaults once the action returns, and a
  // controlled checkbox or select is NOT put back (see CLAUDE.md). After a
  // refusal that would untick the band and drop the term to "All terms" while
  // the screen still claimed otherwise — and the resubmit would price every
  // term. So the DOM is re-applied from state after each result.
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const form = formRef.current;
      if (!form) return;
      for (const box of form.querySelectorAll<HTMLInputElement>('input[name="levelId"]')) {
        box.checked = selected.has(box.value);
      }
      const set = (name: string, value: string) => {
        const field = form.elements.namedItem(name);
        if (field instanceof HTMLSelectElement) field.value = value;
      };
      set("termId", termId);
      set("residency", residency);
      set("studentType", studentType);
    }, 0);
    return () => window.clearTimeout(timer);
    // Re-run on every action result; the values themselves are read when it fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClass("primary")}
      >
        New fee structure
      </button>
    );
  }

  const priced = new Set(pricedLevelIds);
  const bands = BANDS.map((band) => ({
    ...band,
    levels: levels.filter((level) => band.stages.includes(level.stage)),
  })).filter((band) => band.levels.length > 0);

  const toggle = (ids: string[], on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const chosen = levels.filter((level) => selected.has(level.id));
  const chosenPriced = chosen.filter((level) => priced.has(level.id));

  return (
    <form
      ref={formRef}
      action={formAction}
      className="w-full rounded-card border border-hairline bg-surface p-4 lg:p-5"
    >
      <input type="hidden" name="academicYearId" value={academicYearId} />

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">New fee structure</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-sm text-slate-500 hover:text-slate-900"
        >
          Cancel
        </button>
      </div>

      <fieldset>
        <legend className="mb-1 text-sm font-medium text-slate-700">Levels</legend>
        <p className="mb-3 text-xs text-slate-500">
          Tick every level that pays these amounts. Each gets its own structure, so a level
          priced differently — JHS 3, say — is left unticked here and given a form of its own.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {bands.map((band) => {
            const ids = band.levels.map((level) => level.id);
            const all = ids.every((id) => selected.has(id));
            return (
              <div key={band.label} className="min-w-0 rounded-lg border border-hairline p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-900">{band.label}</span>
                  <button
                    type="button"
                    onClick={() => toggle(ids, !all)}
                    className="text-xs font-medium text-brand-ink hover:underline"
                  >
                    {all ? "Clear" : "All"}
                  </button>
                </div>
                <div className="space-y-1">
                  {band.levels.map((level) => (
                    <label key={level.id} className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        name="levelId"
                        value={level.id}
                        checked={selected.has(level.id)}
                        onChange={(event) => toggle([level.id], event.target.checked)}
                      />
                      <span className="truncate">{level.name}</span>
                      {priced.has(level.id) ? (
                        <span className="ml-auto shrink-0 text-xs text-slate-400">priced</span>
                      ) : null}
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Field label="Term" hint="Leave blank to apply to every term this year.">
          <select
            name="termId"
            className={inputClass}
            value={termId}
            onChange={(event) => setTermId(event.target.value)}
          >
            <option value="">All terms</option>
            {terms.map((term) => (
              <option key={term.id} value={term.id}>
                Term {term.sequence}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Applies to">
          <select
            name="residency"
            className={inputClass}
            value={residency}
            onChange={(event) => setResidency(event.target.value)}
          >
            <option value="ANY">Day and boarding</option>
            <option value="DAY">Day students only</option>
            <option value="BOARDING">Boarders only</option>
          </select>
        </Field>

        <Field label="Student type">
          <select
            name="studentType"
            className={inputClass}
            value={studentType}
            onChange={(event) => setStudentType(event.target.value)}
          >
            <option value="ANY">New and continuing</option>
            <option value="NEW">New students only</option>
            <option value="CONTINUING">Continuing only</option>
          </select>
        </Field>
      </div>

      <div className="mt-5">
        <p className="mb-2 text-sm font-medium text-slate-700">Fee items (GHS per term)</p>
        {categories.length === 0 ? (
          <p className="rounded-lg border border-hairline bg-warning-tint px-3 py-2 text-sm text-warning-ink">
            No fee items exist yet, so there is nothing to price. Add them in the Fee items card
            below first — a structure is a set of amounts, one per item.
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {categories.map((category) => (
            <label key={category.id} className="flex items-center gap-2">
              <span className="w-40 shrink-0 truncate text-sm text-slate-600">{category.name}</span>
              <input
                type="text"
                inputMode="decimal"
                name={`amount:${category.id}`}
                placeholder="0.00"
                value={amounts[category.id] ?? ""}
                onChange={(event) =>
                  setAmounts((current) => ({ ...current, [category.id]: event.target.value }))
                }
                className={inputClass}
              />
            </label>
          ))}
        </div>
        {categories.length > 0 ? (
          <p className="mt-2 text-xs text-slate-400">
            Leave an item blank to exclude it from this structure.
          </p>
        ) : null}
      </div>

      {chosenPriced.length > 0 ? (
        <p className="mt-4 text-xs text-slate-500">
          Already priced this year: {chosenPriced.map((level) => level.name).join(", ")}. If an
          existing structure covers the same term, residency and student type, nothing is saved
          until it is removed or the level is unticked.
        </p>
      ) : null}

      {state.error ? (
        <div className="mt-4">
          <Alert tone="error">{state.error}</Alert>
        </div>
      ) : null}
      {state.ok ? (
        <div className="mt-4">
          <Alert tone="success">{state.ok}</Alert>
        </div>
      ) : null}

      {categories.length > 0 ? (
        <div className="mt-5">
          <SubmitButton pendingLabel="Saving…">
            {chosen.length > 1 ? `Save for ${chosen.length} levels` : "Save fee structure"}
          </SubmitButton>
        </div>
      ) : null}
    </form>
  );
}
