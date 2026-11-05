import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { LIBRARY } from "@/lib/permissions";
import { getBookCategories } from "@/lib/library-data";
import { Card, PageHeader } from "../../../ui";
import { BookForm } from "../../forms";
import { LibraryNav } from "../../library-nav";

export const metadata: Metadata = { title: "Add a book · Library · School OS" };
export const dynamic = "force-dynamic";

export default async function NewBookPage() {
  const auth = await requireRole(LIBRARY);
  const categories = await getBookCategories(auth.schoolId);
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader title="Add a book" subtitle="A title and its first copies. Each copy is numbered so it can be scanned." />
      <LibraryNav current="/library/books" />
      <Card>
        <BookForm categories={categories} />
      </Card>
    </div>
  );
}
