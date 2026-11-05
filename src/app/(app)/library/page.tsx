import type { Metadata } from "next";
import Link from "next/link";
import { BookMarked, BookOpen, Library as LibraryIcon, TriangleAlert, Plus } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { LIBRARY } from "@/lib/permissions";
import { getLibraryOverview } from "@/lib/library-data";
import { Card, PageHeader } from "../ui";
import { ButtonLink, DataTable, Row, StatCard, cellClass, type Column } from "../primitives";
import { day } from "./format";
import { LibraryNav } from "./library-nav";
import { LoanBadge } from "./loan-badge";

export const metadata: Metadata = { title: "Library · School OS" };
export const dynamic = "force-dynamic";

const COLUMNS: Column[] = [
  { label: "Book" },
  { label: "Borrower" },
  { label: "Due", hideBelow: "sm" },
  { label: "Late" },
];

export default async function LibraryPage() {
  const auth = await requireRole(LIBRARY);
  const data = await getLibraryOverview(auth.schoolId);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Library"
        subtitle="Who has which book, what is overdue and what the shelves hold."
        action={
          data.hasCatalogue ? (
            <ButtonLink href="/library/desk" variant="primary">
              Lend or return a book
            </ButtonLink>
          ) : (
            <ButtonLink href="/library/books/new" variant="primary" icon={Plus}>
              Add a book
            </ButtonLink>
          )
        }
      />
      <LibraryNav current="/library" />

      {data.hasCatalogue ? null : (
        <Card title="Start your catalogue">
          <div className="space-y-3 px-4.5 py-4 text-sm text-slate-600">
            <p>
              The library has no books yet. Add a title with its copies one at a time, or key your accession register into a spreadsheet
              and add it all at once. Every copy gets a number to scan or type when it goes out.
            </p>
            <div className="flex flex-wrap gap-2">
              <ButtonLink href="/library/import">Add from a spreadsheet</ButtonLink>
              <ButtonLink href="/library/settings" variant="ghost">
                Set the rules first
              </ButtonLink>
            </div>
          </div>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Titles" value={String(data.titles)} icon={BookOpen} />
        <StatCard label="In stock" value={String(data.copies.ACTIVE)} caption={data.copies.LOST ? `${data.copies.LOST} lost` : undefined} icon={LibraryIcon} />
        <StatCard label="Out now" value={data.out} icon={BookMarked} />
        <StatCard label="Overdue" value={String(data.overdue.length)} icon={TriangleAlert} severity={data.overdue.length ? "soon" : "neutral"} />
      </div>

      <section className="space-y-2">
        <div className="flex items-center justify-between px-0.5">
          <h2 className="card-title text-[14.5px] font-extrabold tracking-tight text-slate-900">Overdue</h2>
          <Link href="/library/loans" className="text-sm text-brand-ink hover:underline">
            Everything that is out
          </Link>
        </div>
        <DataTable
          columns={COLUMNS}
          empty={{ icon: BookMarked, title: data.hasCatalogue ? "Nothing is overdue." : "Overdue books will be listed here once books go out." }}
        >
          {data.overdue.slice(0, 15).map((loan) => (
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
              <td className={cellClass(COLUMNS[2]!)}>{day(loan.dueOn)}</td>
              <td className={cellClass(COLUMNS[3]!)}>
                <LoanBadge state={loan.state} days={loan.daysOverdue} />
              </td>
            </Row>
          ))}
        </DataTable>
        {data.overdue.length > 15 ? (
          <p className="px-0.5 text-sm text-slate-500">
            {data.overdue.length - 15} more.{" "}
            <Link href="/library/loans?show=overdue" className="text-brand-ink hover:underline">
              See them all
            </Link>
          </p>
        ) : null}
      </section>
    </div>
  );
}
