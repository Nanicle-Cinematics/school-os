"use client";

import { setExpenseCategoryAccount, setFeeCategoryAccount } from "@/lib/ledger-actions";
import { SubmitButton } from "../submit-button";
import { inputClass } from "../ui";

type Account = { id: string; code: string; name: string };
type FeeCategory = { id: string; name: string; incomeAccountId: string | null };
type ExpenseCategory = { id: string; name: string; expenseAccountId: string | null };

/**
 * Which account a fee item or expense heading posts to, once posting exists.
 * A category left unmapped just doesn't post — see the posting engine's
 * "skip rather than block" rule — so this can be filled in gradually.
 */
export function CategoryMappings({
  feeCategories,
  expenseCategories,
  incomeAccounts,
  expenseAccounts,
}: {
  feeCategories: FeeCategory[];
  expenseCategories: ExpenseCategory[];
  incomeAccounts: Account[];
  expenseAccounts: Account[];
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div>
        <p className="mb-2 text-xs font-semibold text-slate-500">
          Fee items → income account
        </p>
        <ul className="space-y-1.5">
          {feeCategories.map((category) => (
            <li key={category.id} className="flex items-center gap-2">
              <form action={setFeeCategoryAccount} className="flex flex-1 items-center gap-2">
                <input type="hidden" name="feeCategoryId" value={category.id} />
                <span className="w-32 shrink-0 truncate text-sm text-slate-700" title={category.name}>
                  {category.name}
                </span>
                <select
                  name="incomeAccountId"
                  defaultValue={category.incomeAccountId ?? ""}
                  aria-label={`Income account for ${category.name}`}
                  className={`${inputClass} flex-1`}
                >
                  <option value="">Not linked</option>
                  {incomeAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} — {account.name}
                    </option>
                  ))}
                </select>
                <SubmitButton variant="secondary" pendingLabel="…">
                  Save
                </SubmitButton>
              </form>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <p className="mb-2 text-xs font-semibold text-slate-500">
          Expense headings → expense account
        </p>
        <ul className="space-y-1.5">
          {expenseCategories.map((category) => (
            <li key={category.id} className="flex items-center gap-2">
              <form action={setExpenseCategoryAccount} className="flex flex-1 items-center gap-2">
                <input type="hidden" name="expenseCategoryId" value={category.id} />
                <span className="w-32 shrink-0 truncate text-sm text-slate-700" title={category.name}>
                  {category.name}
                </span>
                <select
                  name="expenseAccountId"
                  defaultValue={category.expenseAccountId ?? ""}
                  aria-label={`Expense account for ${category.name}`}
                  className={`${inputClass} flex-1`}
                >
                  <option value="">Not linked</option>
                  {expenseAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} — {account.name}
                    </option>
                  ))}
                </select>
                <SubmitButton variant="secondary" pendingLabel="…">
                  Save
                </SubmitButton>
              </form>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
