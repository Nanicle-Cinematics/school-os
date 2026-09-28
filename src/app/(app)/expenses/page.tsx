import type { Metadata } from "next";
import { buttonClass } from "../button-style";
import { Banknote, Layers, TrendingUp, Wallet } from "lucide-react";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { FINANCE, LEADERSHIP, canAccess } from "@/lib/permissions";
import { getExpenseList, getTermCashPosition } from "@/lib/expense-data";
import { getBudgetVsActual, budgetTotals } from "@/lib/budget-data";
import { getCurrentTerm } from "@/lib/fee-data";
import { approveExpense, cancelExpense } from "@/lib/expense-actions";
import { formatCedis } from "@/lib/money";
import { PageHeader, Card, Alert, filterClass } from "../ui";
import { DataTable, Row, StatCard, type Column } from "../primitives";
import { SubmitButton } from "../submit-button";
import { ExpenseForm } from "./expense-form";
import { BudgetPanel } from "./budget-panel";

export const metadata: Metadata = { title: "Expenses · School OS" };

const COLUMNS: Column[] = [
  { label: "Voucher" },
  { label: "Date" },
  { label: "Description" },
  { label: "Category" },
  { label: "Payee" },
  { label: "Amount", numeric: true },
  { label: "" },
];

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export default async function ExpensesPage({
  searchParams,
}: PageProps<"/expenses">) {
  const auth = await requireRole(FINANCE);
  const params = await searchParams;

  const currentTerm = await getCurrentTerm();
  const termId =
    typeof params.term === "string"
      ? params.term
      : (currentTerm?.id ?? undefined);
  const categoryId =
    typeof params.category === "string" ? params.category : undefined;
  const q = typeof params.q === "string" ? params.q.trim() : undefined;

  const data = await getExpenseList({ termId, categoryId, q });
  const cash = termId ? await getTermCashPosition(termId) : null;
  const mayApprove = canAccess(auth.roles, LEADERSHIP);
  const budget = termId ? await getBudgetVsActual(termId) : null;
  const budgetSummary = budget ? budgetTotals(budget) : null;

  const NOTICES: Record<string, { tone: "error" | "success"; text: string }> = {
    own: {
      tone: "error",
      text: "You recorded that voucher, so you cannot also approve it — a second signature that can be your own is not a second signature. Ask another head or the proprietor.",
    },
    "not-pending": {
      tone: "error",
      text: "That expense is not waiting for approval — someone has already signed it off, or it was cancelled.",
    },
    missing: { tone: "error", text: "That expense no longer exists." },
  };
  const notice =
    typeof params.error === "string"
      ? NOTICES[params.error]
      : params.approved === "1"
        ? { tone: "success" as const, text: "Approved. It now counts in the cash book." }
        : undefined;

  const maxCategory = Math.max(
    1,
    ...data.byCategory.map((row) => Number(row.total)),
  );

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
          <div className="flex items-center gap-3">
            <Link
              href="/expenses/statement"
              className="text-sm font-medium text-slate-500 hover:text-slate-900"
            >
              Income &amp; Expenditure Statement →
            </Link>
            <ExpenseForm
              categories={data.categories}
              terms={data.terms}
              currentTermId={currentTerm?.id}
            />
          </div>
        }
      />

      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}

      {/* Held for a second signature. Above the figures deliberately: this is
          money already out of the drawer that the cash book is NOT counting, so
          a proprietor who scrolls past it is reading a net position that is
          missing something. Everyone in finance sees the queue; only leadership
          gets the button. */}
      {data.pending.length > 0 ? (
        <Card
          title={`${data.pending.length} expense${data.pending.length === 1 ? "" : "s"} awaiting approval`}
        >
          <ul className="divide-y divide-slate-100">
            {data.pending.map((expense) => (
              <li key={expense.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-900">
                    {expense.description}
                  </p>
                  <p className="text-xs text-slate-500">
                    {[
                      expense.voucherNo,
                      expense.category?.name,
                      expense.payee,
                      expense.recordedBy ? `recorded by ${expense.recordedBy.name}` : null,
                      dateFmt.format(expense.spentAt),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {/* An approver signing without seeing the paper is a rubber
                      stamp, so the receipt sits next to the button rather than
                      one click away on another screen. */}
                  {expense.receiptUrl ? (
                    <a
                      href={expense.receiptUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-medium text-brand-ink hover:underline"
                    >
                      View receipt
                    </a>
                  ) : (
                    <span className="text-xs text-slate-400">no receipt attached</span>
                  )}
                  <span className="font-semibold tabular-nums text-slate-900">
                    {formatCedis(expense.amount)}
                  </span>
                  {mayApprove ? (
                    <form action={approveExpense}>
                      <input type="hidden" name="expenseId" value={expense.id} />
                      <SubmitButton pendingLabel="Approving…" variant="secondary">
                        Approve
                      </SubmitButton>
                    </form>
                  ) : (
                    <span className="text-xs text-slate-400">needs a head or proprietor</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {budget && termId ? (
        <Card title="Budget against actual">
          {/* The sentence a proprietor wants before the rows: what was planned,
              what is gone, and whether anything is past its line. Unbudgeted
              spending is named separately rather than folded in — "nobody
              decided" is a different problem from "somebody exceeded". */}
          <p className="border-b border-hairline px-4 py-2.5 text-sm text-slate-500">
            {budgetSummary && budgetSummary.budgeted > 0
              ? [
                  `${formatCedis(budgetSummary.actual)} spent of ${formatCedis(budgetSummary.budgeted)} budgeted`,
                  budgetSummary.over.length > 0
                    ? `${budgetSummary.over.length} heading${budgetSummary.over.length === 1 ? "" : "s"} over`
                    : null,
                  budgetSummary.unbudgeted.length > 0
                    ? `${budgetSummary.unbudgeted.length} unbudgeted`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "No budget set for this term yet — put a figure beside a heading to start one."}
          </p>
          <BudgetPanel rows={budget} termId={termId} mayEdit={mayApprove} />
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Total spent"
          value={formatCedis(data.total)}
          caption={`${data.count} vouchers`}
          icon={Wallet}
        />
        {cash ? (
          <>
            <StatCard
              label="Fees collected"
              value={formatCedis(cash.income)}
              icon={Banknote}
              severity="done"
            />
            <StatCard
              label="Expenditure"
              value={formatCedis(cash.outgoing)}
              icon={Wallet}
            />
            <StatCard
              label="Net position"
              value={formatCedis(cash.net)}
              caption={Number(cash.net) >= 0 ? "in surplus" : "in deficit"}
              icon={TrendingUp}
            />
          </>
        ) : (
          <StatCard
            label="Categories"
            value={String(data.categories.length)}
            icon={Layers}
          />
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <form className="mb-4 flex flex-wrap items-end gap-2 rounded-card border border-hairline bg-surface p-3">
            <select
              name="term"
              defaultValue={termId ?? ""}
              className={`${filterClass} w-auto`}
            >
              <option value="">All terms</option>
              {data.terms.map((term) => (
                <option key={term.id} value={term.id}>
                  Term {term.sequence} · {term.academicYear.name}
                </option>
              ))}
            </select>
            <select
              name="category"
              defaultValue={categoryId ?? ""}
              className={`${filterClass} w-auto`}
            >
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
              className={`${filterClass} w-56`}
            />
            <button
              type="submit"
              className={buttonClass("secondary")}
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
              <DataTable
                columns={COLUMNS}
                empty={{
                  icon: Wallet,
                  title: "No expenditure recorded for this term yet.",
                  action: undefined,
                }}
              >
                {data.expenses.map((expense) => (
                  <Row key={expense.id}>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-slate-900">
                      {expense.receiptUrl ? (
                        <a
                          href={expense.receiptUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:underline"
                          title="View the attached receipt"
                        >
                          {expense.voucherNo} 📎
                        </a>
                      ) : (
                        expense.voucherNo
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                      {dateFmt.format(expense.spentAt)}
                    </td>
                    <td className="px-4 py-2.5 text-slate-900">
                      {expense.description}
                    </td>
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
                        <input
                          type="hidden"
                          name="expenseId"
                          value={expense.id}
                        />
                        <SubmitButton
                          variant="danger"
                          pendingLabel="Cancelling…"
                        >
                          Cancel
                        </SubmitButton>
                      </form>
                    </td>
                  </Row>
                ))}
              </DataTable>
            </div>
          </Card>
        </div>

        <Card title="By category">
          {data.byCategory.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500">
              Nothing spent yet.
            </p>
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
                      style={{
                        width: `${(Number(row.total) / maxCategory) * 100}%`,
                      }}
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
