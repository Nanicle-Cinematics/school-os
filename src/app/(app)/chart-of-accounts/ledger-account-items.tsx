"use client";

import { useActionState } from "react";
import type { AccountType } from "@prisma/client";
import {
  applyDefaultChartOfAccountsAction,
  deleteLedgerAccount,
  saveLedgerAccount,
  type ActionState,
} from "@/lib/ledger-actions";
import { SubmitButton } from "../submit-button";
import { Alert, inputClass } from "../ui";
import { formatCedis } from "@/lib/money";

export type LedgerAccountRow = {
  id: string;
  name: string;
  code: string;
  type: AccountType;
  order: number;
  balance: number;
  isCoreAccount: boolean;
  _count: {
    feeCategoriesAsIncome: number;
    expenseCategoriesAsExpense: number;
    journalLines: number;
  };
};

const TYPE_LABEL: Record<AccountType, string> = {
  ASSET: "Asset",
  LIABILITY: "Liability",
  EQUITY: "Equity",
  INCOME: "Income",
  EXPENSE: "Expense",
};

const ACCOUNT_TYPES: AccountType[] = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"];

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

function AccountRow({ account }: { account: LedgerAccountRow }) {
  const [state, formAction] = useActionState<ActionState, FormData>(saveLedgerAccount, {});
  const inUse =
    account._count.feeCategoriesAsIncome +
    account._count.expenseCategoriesAsExpense +
    account._count.journalLines +
    (account.isCoreAccount ? 1 : 0);

  return (
    <li className="border-t border-slate-100 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <form action={formAction} className="flex flex-1 flex-wrap items-center gap-2">
          <input type="hidden" name="id" value={account.id} />
          <span className="font-mono text-xs text-slate-400">{account.code}</span>
          <input
            type="text"
            name="name"
            required
            defaultValue={account.name}
            aria-label="Account name"
            className={`${inputClass} max-w-64`}
          />
          <SubmitButton variant="secondary" pendingLabel="…">
            Save
          </SubmitButton>
        </form>

        <span className="self-center font-mono text-sm tabular-nums text-slate-700">
          {formatCedis(account.balance)}
        </span>

        {inUse > 0 ? (
          <p className="self-center text-xs text-slate-400" title="In use by a fee item or expense heading.">
            in use · {inUse} item{inUse === 1 ? "" : "s"}
          </p>
        ) : (
          <form action={deleteLedgerAccount} className="self-center">
            <input type="hidden" name="id" value={account.id} />
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

export function LedgerAccountSection({ accounts }: { accounts: LedgerAccountRow[] }) {
  const [addState, addAction] = useActionState<ActionState, FormData>(saveLedgerAccount, {});
  const [defaultsState, defaultsAction] = useActionState<ActionState, FormData>(
    applyDefaultChartOfAccountsAction,
    {},
  );

  const byType = ACCOUNT_TYPES.map((type) => ({
    type,
    accounts: accounts.filter((a) => a.type === type),
  }));

  return (
    <>
      {accounts.length === 0 ? (
        <div className="border-b border-slate-100 bg-warning-tint/60 px-4 py-3 text-sm text-warning-ink">
          This school has no chart of accounts yet. Start from the standard one below and edit it, or
          add your own.
        </div>
      ) : (
        byType.map(({ type, accounts: group }) =>
          group.length > 0 ? (
            <div key={type}>
              <p className="border-t border-slate-100 bg-slate-50/60 px-4 py-2 text-xs font-semibold text-slate-500">
                {TYPE_LABEL[type]}
              </p>
              <ul>
                {group.map((account) => (
                  <AccountRow key={account.id} account={account} />
                ))}
              </ul>
            </div>
          ) : null,
        )
      )}

      <div className="border-t border-slate-100 bg-slate-50/60 p-4">
        <form action={addAction} className="flex flex-wrap items-start gap-2">
          <select name="type" defaultValue="" required aria-label="Account type" className={`${inputClass} max-w-40`}>
            <option value="" disabled>
              Type…
            </option>
            {ACCOUNT_TYPES.map((type) => (
              <option key={type} value={type}>
                {TYPE_LABEL[type]}
              </option>
            ))}
          </select>
          <input
            type="text"
            name="name"
            required
            placeholder="PTA Building Fund"
            aria-label="Account name"
            className={`${inputClass} max-w-64`}
          />
          <SubmitButton pendingLabel="Adding…">Add account</SubmitButton>
        </form>
        <Feedback state={addState} />

        <div className="mt-4 border-t border-slate-200 pt-3">
          <form action={defaultsAction}>
            <SubmitButton variant="secondary" pendingLabel="Adding…">
              {accounts.length === 0
                ? "Add the standard chart of accounts"
                : "Add any standard accounts that are missing"}
            </SubmitButton>
          </form>
          <Feedback state={defaultsState} />
          <p className="mt-2 text-xs text-slate-400">
            Cash, Bank, Mobile Money, Accounts Receivable, Accounts Payable, Owner&rsquo;s Equity, plus
            one income account per fee item and one expense account per expense heading — linked
            automatically where both already exist.
          </p>
        </div>
      </div>
    </>
  );
}
