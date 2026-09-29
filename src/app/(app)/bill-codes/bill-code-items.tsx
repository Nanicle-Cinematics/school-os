"use client";

import { useActionState } from "react";
import {
  applyDefaultBillCodesAction,
  deleteBillCode,
  saveBillCode,
  type ActionState,
} from "@/lib/billcode-actions";
import type { BillCodeRow } from "@/lib/billcode-data";
import { SubmitButton } from "../submit-button";
import { Alert, inputClass } from "../ui";

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

function BillCodeRowItem({ item }: { item: BillCodeRow }) {
  const [state, formAction] = useActionState<ActionState, FormData>(saveBillCode, {});
  const billed = item._count.invoices;

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
            aria-label="Bill name"
            className={`${inputClass} max-w-64`}
          />
          <input
            type="number"
            name="order"
            defaultValue={item.order}
            aria-label="Order"
            className={`${inputClass} max-w-24`}
          />
          <SubmitButton variant="secondary" pendingLabel="…">
            Save
          </SubmitButton>
        </form>

        {billed > 0 ? (
          <p
            className="self-center text-xs text-slate-400"
            title={`On ${billed} invoice${billed === 1 ? "" : "s"} already.`}
          >
            in use · {billed} invoice{billed === 1 ? "" : "s"}
          </p>
        ) : (
          <form action={deleteBillCode} className="self-center">
            <input type="hidden" name="id" value={item.id} />
            <SubmitButton variant="danger" pendingLabel="…">
              Delete
            </SubmitButton>
          </form>
        )}
      </div>
      <Feedback state={state} />
    </li>
  );
}

/**
 * What KIND of bill a school issues, managed on its own screen because a bill
 * code classifies the whole invoice, not a fee line within it — see
 * `BillCode` in schema.prisma.
 */
export function BillCodeSection({ items }: { items: BillCodeRow[] }) {
  const [addState, addAction] = useActionState<ActionState, FormData>(saveBillCode, {});
  const [defaultsState, defaultsAction] = useActionState<ActionState, FormData>(
    applyDefaultBillCodesAction,
    {},
  );

  return (
    <>
      {items.length === 0 ? (
        <div className="border-b border-slate-100 bg-warning-tint/60 px-4 py-3 text-sm text-warning-ink">
          This school has no bill codes yet. Start from the usual ones below and edit them, or add
          your own.
        </div>
      ) : null}

      <ul>
        {items.map((item) => (
          <BillCodeRowItem key={item.id} item={item} />
        ))}
      </ul>

      <div className="border-t border-slate-100 bg-slate-50/60 p-4">
        <form action={addAction} className="flex flex-wrap items-start gap-2">
          <input
            type="text"
            name="name"
            required
            placeholder="Speech and Prize-Giving Bill"
            aria-label="Bill name"
            className={`${inputClass} max-w-64`}
          />
          <SubmitButton pendingLabel="Adding…">Add bill code</SubmitButton>
        </form>
        <Feedback state={addState} />
        <p className="mt-2 text-xs text-slate-400">
          Term Fees Bill is what the term&rsquo;s invoices are stamped with. The others classify
          any one-off bill this school issues outside the normal term invoicing.
        </p>

        <div className="mt-4 border-t border-slate-200 pt-3">
          <form action={defaultsAction}>
            <SubmitButton variant="secondary" pendingLabel="Adding…">
              {items.length === 0
                ? "Add the standard bill codes"
                : "Add any standard codes that are missing"}
            </SubmitButton>
          </form>
          <Feedback state={defaultsState} />
          <p className="mt-2 text-xs text-slate-400">
            Term Fees, PTA, Trip/Excursion, Uniform and Other — plus any this school adds.
          </p>
        </div>
      </div>
    </>
  );
}
