import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { LIBRARY } from "@/lib/permissions";
import { CATALOGUE_ROW_CAP, CATALOGUE_TEMPLATE_HEADERS } from "@/lib/library-rules";
import { Card, PageHeader } from "../../ui";
import { CatalogueImport } from "../import-form";
import { LibraryNav } from "../library-nav";

export const metadata: Metadata = { title: "Add from a spreadsheet · Library · School OS" };
export const dynamic = "force-dynamic";

const TEMPLATE = [
  CATALOGUE_TEMPLATE_HEADERS.join(","),
  "ACC-00001,Things Fall Apart,Chinua Achebe,9780385474542,Heinemann,1958,Novels,A3,35",
  ",Ghana Atlas for Schools,,,,2015,Reference,B1,",
].join("\n");

export default async function ImportPage() {
  await requireRole(LIBRARY);
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader title="Add from a spreadsheet" subtitle="Key your accession register in once instead of a book at a time." />
      <LibraryNav current="/library/import" />

      <Card title="How it works">
        <ul className="list-disc space-y-1.5 px-9 py-4 text-sm text-slate-600">
          <li>One row is one copy. Only the title is required.</li>
          <li>
            Leave <strong>accession_no</strong> blank and the library numbers the copy for you. Keep the number if the book already carries one.
          </li>
          <li>Rows with the same title, author and ISBN become one book with several copies.</li>
          <li>Nothing is added if any row has a problem. The check lists every one, with its line.</li>
          <li>Up to {CATALOGUE_ROW_CAP} rows at a time. Headings can be in any order.</li>
        </ul>
      </Card>

      <Card title="Your spreadsheet">
        <CatalogueImport template={TEMPLATE} />
      </Card>
    </div>
  );
}
