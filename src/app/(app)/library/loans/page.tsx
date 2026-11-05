import type { Metadata } from "next";
import Link from "next/link";
import { BookMarked } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { LIBRARY } from "@/lib/permissions";
import { getOpenLoans } from "@/lib/library-data";
import { PageHeader, filterClass } from "../../ui";
import { DataTable, Row, cellClass, type Column } from "../../primitives";
import { PrintButton } from "../../print-button";
import { day } from "../format";
import { LibraryNav } from "../library-nav";
import { LoanBadge } from "../loan-badge";

export const metadata: Metadata = { title: "Out now · Library · School OS" };
export const dynamic = "force-dynamic";

const COLUMNS: Column[] = [
  { label: "Book" },
  { label: "Borrower" },
  { label: "Lent", hideBelow: "md" },
  { label: "Due", hideBelow: "sm" },
  { label: "State" },
];

export default async function LoansPage({ searchParams }: PageProps<"/library/loans">) {
  const auth = await requireRole(LIBRARY);
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.trim() : "";
  const overdueOnly = params.show === "overdue";
  const kind = params.kind === "STUDENT" || params.kind === "STAFF" ? params.kind : undefined;

  const { rows, truncated } = await getOpenLoans(auth.schoolId, { q, overdueOnly, kind });
  const filtered = Boolean(q || overdueOnly || kind);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title={overdueOnly ? "Overdue books" : "Out now"}
        subtitle={`${rows.length}${truncated ? "+" : ""} ${overdueOnly ? "overdue" : "out"}${filtered && !overdueOnly ? " matching" : ""}, earliest due date first.`}
        action={<PrintButton label="Print this list" />}
      />
      <div className="print:hidden">
        <LibraryNav current="/library/loans" />
      </div>

      <form className="flex flex-wrap items-center gap-2 print:hidden" role="search">
        <input type="search" name="q" defaultValue={q} placeholder="Name, admission number, title or accession number" aria-label="Search loans" className={`${filterClass} w-80`} />
        <select name="show" defaultValue={overdueOnly ? "overdue" : ""} aria-label="Show" className={`${filterClass} w-40`}>
          <option value="">Everything out</option>
          <option value="overdue">Overdue only</option>
        </select>
        <select name="kind" defaultValue={kind ?? ""} aria-label="Borrower" className={`${filterClass} w-40`}>
          <option value="">Pupils and staff</option>
          <option value="STUDENT">Pupils</option>
          <option value="STAFF">Staff</option>
        </select>
        <button type="submit" className="whitespace-nowrap rounded-card border border-hairline bg-surface px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50">
          Filter
        </button>
        {filtered ? (
          <Link href="/library/loans" className="text-sm text-slate-500 hover:text-slate-900">
            Clear
          </Link>
        ) : null}
      </form>

      <DataTable
        columns={COLUMNS}
        empty={{
          icon: BookMarked,
          title: filtered ? "No loan matches that." : "No book is out at the moment.",
          action: filtered ? undefined : { label: "Lend a book", href: "/library/desk" },
        }}
      >
        {rows.map((loan) => (
          <Row key={loan.id}>
            <td className={cellClass(COLUMNS[0]!)}>
              <Link href={`/library/books/${loan.bookId}`} className="font-semibold text-slate-900 hover:underline">
                {loan.title}
              </Link>
              <span className="block text-xs text-slate-400">{loan.accessionNo}</span>
            </td>
            <td className={cellClass(COLUMNS[1]!)}>
              <Link href={`/library/desk?kind=${loan.borrower.kind}&id=${loan.borrower.id}`} className="hover:underline">
                {loan.borrower.name}
              </Link>
              <span className="block text-xs text-slate-400">
                {loan.borrower.detail}
                {loan.borrower.gone ? " · no longer at the school" : ""}
              </span>
            </td>
            <td className={cellClass(COLUMNS[2]!)}>{day(loan.borrowedOn)}</td>
            <td className={cellClass(COLUMNS[3]!)}>{day(loan.dueOn)}</td>
            <td className={cellClass(COLUMNS[4]!)}>
              <LoanBadge state={loan.state} days={loan.daysOverdue} />
            </td>
          </Row>
        ))}
      </DataTable>
      {truncated ? <p className="px-0.5 text-sm text-slate-500">Showing the first 300. Narrow the list to see the rest.</p> : null}
    </div>
  );
}
