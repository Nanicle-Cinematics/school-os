import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { FINANCE } from "@/lib/permissions";
import { getExpenseList, getTermCashPosition } from "@/lib/expense-data";
import { getCurrentTerm } from "@/lib/fee-data";
import { cancelExpense } from "@/lib/expense-actions";
import { formatCedis } from "@/lib/money";
import { PageHeader, Stat, Card, EmptyRow, inputClass, thClass, tableHeadClass } from "../ui";
import { SubmitButton } from "../submit-button";
import { ExpenseForm } from "./expense-form";

export const metadata: Metadata = { title: "Expenses · School OS" };

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

export default async function ExpensesPage({ searchParams }: PageProps<"/expenses">) {
  await requireRole(FINANCE);
  const params = await searchParams;

  const currentTerm = await getCurrentTerm();
  const termId = typeof params.term === "string" ? params.term : (currentTerm?.id ?? undefined);
  const categoryId = typeof params.category === "string" ? params.category : undefined;
  const q = typeof params.q === "string" ? params.q.trim() : undefined;

  const data = await getExpenseList({ termId, categoryId, q });
  const cash = termId ? await getTermCashPosition(termId) : null;

  const maxCategory = Math.max(1, ...data.byCategory.map((row) => Number(row.total)));

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Expenses"
        subtitle={
          currentTerm
            ? `Cash book for Term ${currentTerm.sequence} · ${currentTerm.academicYear.name}`
            : "School cash book"
        }
        action={
          <ExpenseForm
            categories={data.categories}
            terms={data.terms}
            currentTermId={currentTerm?.id}
          />
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total spent" value={formatCedis(data.total)} sub={`${data.count} vouchers`} />
        {cash ? (
          <>
            <Stat label="Fees collected" value={formatCedis(cash.income)} tone="positive" />
            <Stat label="Expenditure" value={formatCedis(cash.outgoing)} tone="negative" />
            <Stat
              label="Net position"
              value={formatCedis(cash.net)}
              tone={Number(cash.net) >= 0 ? "positive" : "negative"}
              sub={Number(cash.net) >= 0 ? "in surplus" : "in deficit"}
            />
          </>
        ) : (
          <Stat label="Categories" value={String(data.categories.length)} />
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <form className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-white p-3">
            <select name="term" defaultValue={termId ?? ""} className={`${inputClass} w-auto`}>
              <option value="">All terms</option>
              {data.terms.map((term) => (
                <option key={term.id} value={term.id}>
                  Term {term.sequence} · {term.academicYear.name}
                </option>
              ))}
            </select>
            <select name="category" defaultValue={categoryId ?? ""} className={`${inputClass} w-auto`}>
              <option value="">All categories</option>
              {data.categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
            <input
              type="search"
              name="q"
              defaultValue={q ?? ""}
              placeholder="Voucher, description or payee"
              className={`${inputClass} w-56`}
            />
            <button
              type="submit"
              className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white shadow-[0_6px_16px_rgba(18,128,92,0.22)] transition hover:bg-brand-700"
            >
              Filter
            </button>
            <Link
              href="/expenses"
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 transition hover:bg-slate-50"
            >
              Reset
            </Link>
          </form>

          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className={tableHeadClass}>
                  <tr>
                    <th className={thClass}>Voucher</th>
                    <th className={thClass}>Date</th>
                    <th className={thClass}>Description</th>
                    <th className={thClass}>Category</th>
                    <th className={thClass}>Payee</th>
                    <th className={`${thClass} text-right`}>Amount</th>
                    <th className={thClass} />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.expenses.length === 0 ? (
                    <EmptyRow colSpan={7}>No expenses recorded for these filters.</EmptyRow>
                  ) : (
                    data.expenses.map((expense) => (
                      <tr key={expense.id} className="hover:bg-slate-50">
                        <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-slate-900">
                          {expense.voucherNo}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                          {dateFmt.format(expense.spentAt)}
                        </td>
                        <td className="px-4 py-2.5 text-slate-900">{expense.description}</td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                          {expense.category?.name ?? "—"}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                          {expense.payee ?? "—"}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-right font-medium tabular-nums text-slate-900">
                          {formatCedis(expense.amount)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-right">
                          <form action={cancelExpense}>
                            <input type="hidden" name="expenseId" value={expense.id} />
                            <SubmitButton variant="danger" pendingLabel="Cancelling…">
                              Cancel
                            </SubmitButton>
                          </form>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        <Card title="By category">
          {data.byCategory.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500">Nothing spent yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.byCategory.map((row) => (
                <li key={row.categoryId ?? "none"} className="px-4 py-2.5">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-700">{row.name}</span>
                    <span className="font-medium tabular-nums text-slate-900">
                      {formatCedis(row.total)}
                    </span>
                  </div>
                  <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <span
                      className="block h-full rounded-full bg-brand-600"
                      style={{ width: `${(Number(row.total) / maxCategory) * 100}%` }}
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
