import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { History } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { LIBRARY } from "@/lib/permissions";
import { getBook, getBookCategories } from "@/lib/library-data";
import { COPY_STATUS_LABEL } from "@/lib/library-rules";
import { Card, PageHeader } from "../../../ui";
import { DataTable, Row, cellClass, type Column } from "../../../primitives";
import { day } from "../../format";
import { AddCopiesForm, BookForm, CopyActions, DeleteBookButton } from "../../forms";
import { LibraryNav } from "../../library-nav";
import { LoanBadge } from "../../loan-badge";

export const metadata: Metadata = { title: "Book · Library · School OS" };
export const dynamic = "force-dynamic";

const HISTORY: Column[] = [
  { label: "Copy" },
  { label: "Borrower" },
  { label: "Lent", hideBelow: "sm" },
  { label: "Result" },
];

export default async function BookPage({ params }: PageProps<"/library/books/[id]">) {
  const auth = await requireRole(LIBRARY);
  const { id } = await params;
  const found = await getBook(auth.schoolId, id);
  if (!found) notFound();
  const { book, copies, history } = found;
  const categories = await getBookCategories(auth.schoolId);

  const stock = copies.filter((copy) => copy.status === "ACTIVE");
  const out = stock.filter((copy) => copy.loan).length;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title={book.title}
        subtitle={[book.author, book.category, `${stock.length - out} of ${stock.length} on the shelf`].filter(Boolean).join(" · ")}
      />
      <LibraryNav current="/library/books" />

      <Card title="Details">
        <BookForm
          bookId={book.id}
          categories={categories}
          book={{
            title: book.title,
            author: book.author ?? "",
            isbn: book.isbn ?? "",
            publisher: book.publisher ?? "",
            publishedYear: book.publishedYear ? String(book.publishedYear) : "",
            category: book.category ?? "",
            shelf: book.shelf ?? "",
            replacementCost: book.replacementCost ?? "",
            notes: book.notes ?? "",
          }}
        />
      </Card>

      <Card title="Copies">
        {copies.length === 0 ? (
          <p className="px-4.5 py-4 text-sm text-slate-500">This title has no copies yet. Add some below.</p>
        ) : (
          <ul className="divide-y divide-hairline">
            {copies.map((copy) => (
              <li key={copy.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4.5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-900">{copy.accessionNo}</p>
                  <p className="text-xs text-slate-500">
                    {copy.loan ? (
                      <>
                        Out to{" "}
                        <Link href={`/library/desk?kind=${copy.loan.borrower.kind}&id=${copy.loan.borrower.id}`} className="text-brand-ink hover:underline">
                          {copy.loan.borrower.name}
                        </Link>
                        , due {day(copy.loan.dueOn)}
                      </>
                    ) : copy.status === "ACTIVE" ? (
                      "On the shelf"
                    ) : (
                      `${COPY_STATUS_LABEL[copy.status]} ${day(copy.statusChangedOn)}${copy.statusNote ? ` · ${copy.statusNote}` : ""}`
                    )}
                  </p>
                </div>
                {copy.loan ? <LoanBadge state={copy.loan.state} days={copy.loan.daysOverdue} /> : null}
                <CopyActions copyId={copy.id} status={copy.status} onLoan={copy.loan !== null} everLent={copy.everLent} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Add copies">
        <AddCopiesForm bookId={book.id} />
      </Card>

      <section className="space-y-2">
        <h2 className="card-title px-0.5 text-[14.5px] font-extrabold tracking-tight text-slate-900">Who has had it</h2>
        <DataTable columns={HISTORY} empty={{ icon: History, title: "This book has not been lent yet." }}>
          {history.map((loan) => (
            <Row key={loan.id}>
              <td className={cellClass(HISTORY[0]!)}>{loan.accessionNo}</td>
              <td className={cellClass(HISTORY[1]!)}>
                <Link href={`/library/desk?kind=${loan.borrower.kind}&id=${loan.borrower.id}`} className="hover:underline">
                  {loan.borrower.name}
                </Link>
                <span className="block text-xs text-slate-400">{loan.borrower.detail}</span>
              </td>
              <td className={cellClass(HISTORY[2]!)}>{day(loan.borrowedOn)}</td>
              <td className={cellClass(HISTORY[3]!)}>
                <LoanBadge state={loan.state} days={loan.daysOverdue} />
                {loan.returnedOn ? <span className="ml-2 text-xs text-slate-400">{day(loan.returnedOn)}</span> : null}
              </td>
            </Row>
          ))}
        </DataTable>
      </section>

      <Card title="Remove this title">
        <div className="space-y-3 px-4.5 py-4 text-sm text-slate-600">
          <p>
            Only a title that has never been lent can be deleted. Once a copy has gone out, its record is kept so the history of who had it
            stays true; withdraw its copies instead.
          </p>
          <DeleteBookButton bookId={book.id} title={book.title} />
        </div>
      </Card>
    </div>
  );
}
