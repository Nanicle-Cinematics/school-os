"use client";

import { useActionState } from "react";
import {
  applyDefaultFeeItems,
  deleteFeeCategory,
  saveFeeCategory,
  type ActionState,
} from "@/lib/fee-actions";
import { SubmitButton } from "../submit-button";
import { Alert, inputClass } from "../ui";

export type FeeItemRow = {
  id: string;
  name: string;
  code: string;
  order: number;
  _count: { structureItems: number; invoiceItems: number };
};

function Feedback({ state }: { state: ActionState }) {
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

function FeeItem({ item }: { item: FeeItemRow }) {
  const [state, formAction] = useActionState<ActionState, FormData>(saveFeeCategory, {});

  const priced = item._count.structureItems;
  const billed = item._count.invoiceItems;
  const held = [
    priced > 0 ? `${priced} structure${priced === 1 ? "" : "s"}` : null,
    billed > 0 ? `${billed} bill${billed === 1 ? "" : "s"}` : null,
  ].filter(Boolean);

  return (
    <li className="border-t border-slate-100 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <form action={formAction} className="flex flex-1 flex-wrap items-start gap-2">
          <input type="hidden" name="id" value={item.id} />
          <input
            type="text"
            name="name"
            required
            defaultValue={item.name}
            aria-label="Fee item name"
            className={`${inputClass} max-w-64`}
          />
          <input
            type="number"
            name="order"
            defaultValue={item.order}
            aria-label="Order on the bill"
            className={`${inputClass} max-w-24`}
          />
          <SubmitButton variant="secondary" pendingLabel="…">
            Save
          </SubmitButton>
        </form>

        {held.length > 0 ? (
          <p
            className="self-center text-xs text-slate-400"
            title={`Used by ${held.join(", ")}. Price it at zero instead of deleting it.`}
          >
            in use · {held.join(", ")}
          </p>
        ) : (
          <form action={deleteFeeCategory} className="self-center">
            <input type="hidden" name="id" value={item.id} />
            <SubmitButton variant="danger" pendingLabel="…">
              Delete item
            </SubmitButton>
          </form>
        )}
      </div>
      <Feedback state={state} />
    </li>
  );
}

/**
 * The lines a bill is made of, managed on the same screen that prices them.
 *
 * They live here rather than in Settings because a bursar discovers they are
 * missing at the moment they try to price a level, and sending them to another
 * screen to come back is the whole friction worth removing.
 */
export function FeeItemSection({ items }: { items: FeeItemRow[] }) {
  const [addState, addAction] = useActionState<ActionState, FormData>(saveFeeCategory, {});
  const [defaultsState, defaultsAction] = useActionState<ActionState, FormData>(
    applyDefaultFeeItems,
    {},
  );

  return (
    <>
      {items.length === 0 ? (
        <div className="border-b border-slate-100 bg-amber-50/60 px-4 py-3 text-sm text-amber-900">
          This school has no fee items yet, so there is nothing to enter an amount against. Start
          from the usual ones below and edit them, or add your own.
        </div>
      ) : null}

      <ul>
        {items.map((item) => (
          <FeeItem key={item.id} item={item} />
        ))}
      </ul>

      <div className="border-t border-slate-100 bg-slate-50/60 p-4">
        <form action={addAction} className="flex flex-wrap items-start gap-2">
          <input
            type="text"
            name="name"
            required
            placeholder="Transport Levy"
            aria-label="Fee item name"
            className={`${inputClass} max-w-64`}
          />
          <SubmitButton pendingLabel="Adding…">Add fee item</SubmitButton>
        </form>
        <Feedback state={addState} />
        <p className="mt-2 text-xs text-slate-400">
          An item is what appears as a line on the parent&rsquo;s bill. The amount is set per level
          below, so the same item can cost different amounts in KG and JHS.
        </p>

        {/* Kept visible once the list is populated, like the curriculum button:
            a school that deleted an item it now charges again should be able to
            get it back without retyping it. */}
        <div className="mt-4 border-t border-slate-200 pt-3">
          <form action={defaultsAction}>
            <SubmitButton variant="secondary" pendingLabel="Adding…">
              {items.length === 0
                ? "Add the standard fee items"
                : "Add any standard items that are missing"}
            </SubmitButton>
          </form>
          <Feedback state={defaultsState} />
          <p className="mt-2 text-xs text-slate-400">
            Tuition, PTA Levy, Examination, Feeding, ICT, Sports and Stationery — plus the matching
            headings for the expenses cash book. Nothing you have renamed is touched.
          </p>
        </div>
      </div>
    </>
  );
}
