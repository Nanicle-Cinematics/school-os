import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { FINANCE } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { getIncomeExpenditureStatement } from "@/lib/expense-data";
import { getCurrentTerm } from "@/lib/fee-data";
import { formatCedis } from "@/lib/money";
import { printedByLine } from "@/lib/paper";
import { PageHeader, Card, filterClass } from "../../ui";
import { buttonClass } from "../../button-style";
import { PrintButton } from "./print-button";

export const metadata: Metadata = { title: "Income & Expenditure Statement · School OS" };

/**
 * One document, printable, that says what the term brought in and what it
 * cost — rather than a proprietor reading the same figures off the dashboard,
 * the expenses page and a category chart and trusting they agree.
 *
 * Deliberately term-scoped, matching every other money screen (see the note
 * on netOutstanding in invoice-engine.ts): a whole-history statement would mix
 * terms whose books are long closed with the one still open.
 */
export default async function IncomeExpenditureStatementPage({
  searchParams,
}: PageProps<"/expenses/statement">) {
  const auth = await requireRole(FINANCE);
  const params = await searchParams;

  const currentTerm = await getCurrentTerm();
  const termId = typeof params.term === "string" ? params.term : currentTerm?.id;

  const terms = await prisma.term.findMany({
    where: { academicYear: { schoolId: auth.schoolId } },
    orderBy: [{ academicYear: { name: "desc" } }, { sequence: "asc" }],
    include: { academicYear: { select: { name: true } } },
    take: 12,
  });

  const statement = termId ? await getIncomeExpenditureStatement(termId) : null;
  const surplus = statement ? Number(statement.net) >= 0 : true;

  return (
    <div className="mx-auto max-w-3xl space-y-5 print:max-w-full">
      <div className="print:hidden">
        <Link href="/expenses" className="text-sm text-slate-500 hover:text-slate-900">
          ← Expenses
        </Link>
      </div>

      <PageHeader
        title="Income & Expenditure Statement"
        subtitle={
          statement
            ? `Term ${statement.term.sequence} · ${statement.term.academicYear.name}`
            : "Choose a term to generate the statement"
        }
        action={
          // A plain print button rather than a second route: this is a
          // staff-facing internal report, not a parent-facing document like a
          // receipt or a report card, so it does not need its own print
          // layout — the page chrome hides itself with print:hidden instead.
          statement ? <PrintButton /> : undefined
        }
      />

      {terms.length > 0 ? (
        <form className="flex flex-wrap items-center gap-2 print:hidden">
          <label className="text-sm text-slate-600" htmlFor="term">
            Term
          </label>
          <select id="term" name="term" defaultValue={termId ?? ""} className={`${filterClass} w-auto`}>
            {terms.map((term) => (
              <option key={term.id} value={term.id}>
                Term {term.sequence} · {term.academicYear.name}
              </option>
            ))}
          </select>
          <button type="submit" className={buttonClass("secondary")}>
            Generate
          </button>
        </form>
      ) : null}

      {!statement ? (
        <Card>
          <p className="px-4 py-6 text-sm text-slate-500">
            No terms set up yet — add one under Settings → Terms first.
          </p>
        </Card>
      ) : (
        <Card>
          <div className="divide-y divide-slate-100">
            <div className="px-4 py-3">
              <p className="text-xs font-semibold tracking-wide text-slate-400">Income</p>
              <div className="mt-2 flex items-center justify-between text-sm">
                <span className="text-slate-700">Fees collected</span>
                <span className="font-medium tabular-nums text-slate-900">
                  {formatCedis(statement.income)}
                </span>
              </div>
              {Number(statement.unapplied) > 0 ? (
                <div className="mt-1 flex items-center justify-between text-sm text-slate-500">
                  <span>Received but not yet applied to a bill (not income)</span>
                  <span className="tabular-nums">{formatCedis(statement.unapplied)}</span>
                </div>
              ) : null}
            </div>

            <div className="px-4 py-3">
              <p className="text-xs font-semibold tracking-wide text-slate-400">
                Expenditure
              </p>
              {statement.expenditureByCategory.length === 0 ? (
                <p className="mt-2 text-sm text-slate-500">Nothing spent this term.</p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {statement.expenditureByCategory.map((row) => (
                    <li
                      key={row.categoryId ?? "none"}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="text-slate-700">{row.name}</span>
                      <span className="tabular-nums text-slate-900">{formatCedis(row.total)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-2.5 flex items-center justify-between border-t border-slate-100 pt-2.5 text-sm font-medium">
                <span className="text-slate-700">Total expenditure</span>
                <span className="tabular-nums text-slate-900">{formatCedis(statement.expenditure)}</span>
              </div>
            </div>

            <div className="px-4 py-3">
              <div className="flex items-center justify-between text-base font-semibold">
                <span className={surplus ? "text-success-ink" : "text-danger-ink"}>
                  {surplus ? "Surplus" : "Deficit"} for the term
                </span>
                <span className={`tabular-nums ${surplus ? "text-success-ink" : "text-danger-ink"}`}>
                  {formatCedis(statement.net)}
                </span>
              </div>
            </div>
          </div>
        </Card>
      )}

      {statement ? (
        <p className="text-[10px] text-slate-400">{printedByLine(auth.name)}</p>
      ) : null}

      <p className="text-xs text-slate-400 print:hidden">
        Cash basis: income is fees actually collected against this term&rsquo;s invoices, and
        expenditure is vouchers already paid — the same figures the Expenses page shows, not a
        second calculation that could disagree with it.
      </p>
    </div>
  );
}
