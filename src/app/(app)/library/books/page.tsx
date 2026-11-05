import type { Metadata } from "next";
import Link from "next/link";
import { BookOpen, Plus } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { LIBRARY } from "@/lib/permissions";
import { getBookCategories, getBooks } from "@/lib/library-data";
import { PageHeader, filterClass } from "../../ui";
import { ButtonLink, DataTable, Row, cellClass, type Column } from "../../primitives";
import { LibraryNav } from "../library-nav";

export const metadata: Metadata = { title: "Books · Library · School OS" };
export const dynamic = "force-dynamic";

const COLUMNS: Column[] = [
  { label: "Title" },
  { label: "Category", hideBelow: "md" },
  { label: "Shelf", hideBelow: "lg" },
  { label: "Copies", numeric: true, hideBelow: "sm" },
  { label: "On the shelf", numeric: true },
];

export default async function BooksPage({ searchParams }: PageProps<"/library/books">) {
  const auth = await requireRole(LIBRARY);
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.trim() : "";
  const category = typeof params.category === "string" ? params.category : "";

  const categories = await getBookCategories(auth.schoolId);
  const { rows, truncated } = await getBooks(auth.schoolId, { q, category });
  const filtered = Boolean(q || category);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Books"
        subtitle="Every title the library holds, and how many copies are on the shelf."
        action={
          <ButtonLink href="/library/books/new" variant="primary" icon={Plus}>
            Add a book
          </ButtonLink>
        }
      />
      <LibraryNav current="/library/books" />

      <form className="flex flex-wrap items-center gap-2" role="search">
        <input type="search" name="q" defaultValue={q} placeholder="Title, author, ISBN or accession number" aria-label="Search books" className={`${filterClass} w-72`} />
        <select name="category" defaultValue={category} aria-label="Category" className={`${filterClass} w-44`}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button type="submit" className="whitespace-nowrap rounded-card border border-hairline bg-surface px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50">
          Filter
        </button>
        {filtered ? (
          <Link href="/library/books" className="text-sm text-slate-500 hover:text-slate-900">
            Clear
          </Link>
        ) : null}
      </form>

      <DataTable
        columns={COLUMNS}
        empty={{
          icon: BookOpen,
          title: filtered ? "No book matches that search." : "The library has no books yet.",
          action: filtered ? undefined : { label: "Add the first book", href: "/library/books/new" },
        }}
      >
        {rows.map((book) => (
          <Row key={book.id}>
            <td className={cellClass(COLUMNS[0]!)}>
              <Link href={`/library/books/${book.id}`} className="font-semibold text-slate-900 hover:underline">
                {book.title}
              </Link>
              {book.author ? <span className="block text-xs text-slate-400">{book.author}</span> : null}
            </td>
            <td className={cellClass(COLUMNS[1]!)}>{book.category ?? "—"}</td>
            <td className={cellClass(COLUMNS[2]!)}>{book.shelf ?? "—"}</td>
            <td className={cellClass(COLUMNS[3]!)}>{book.copies}</td>
            <td className={cellClass(COLUMNS[4]!)}>
              <span className={book.copies > 0 && book.available === 0 ? "font-semibold text-warning-ink" : ""}>{book.available}</span>
              {book.out ? <span className="block text-xs text-slate-400">{book.out} out</span> : null}
            </td>
          </Row>
        ))}
      </DataTable>
      {truncated ? <p className="px-0.5 text-sm text-slate-500">Showing the first 300. Search to narrow the list.</p> : null}
    </div>
  );
}
