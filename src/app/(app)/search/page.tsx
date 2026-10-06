import type { Metadata } from "next";
import { buttonClass } from "../button-style";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth";
import { landingFor } from "@/lib/permissions";
import { setTenantContext } from "@/lib/tenant-context";
import { canSearch, search } from "@/lib/search-data";
import { Card, PageHeader, inputClass } from "../ui";

export const metadata: Metadata = { title: "Search · School OS" };

export default async function SearchPage({ searchParams }: PageProps<"/search">) {
  const auth = await requireAuth();
  // Not requireRole: search spans offices, and who may search is the same
  // question as which groups they get back.
  if (!canSearch(auth.roles)) {
    redirect(landingFor(auth.roles));
  }
  setTenantContext(auth.tenant);

  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const results = await search(auth.schoolId, query, auth.roles);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title="Search"
        subtitle="A pupil, a guardian, a member of staff, an invoice or a receipt."
      />

      <form method="get" className="flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={query}
          autoFocus
          placeholder="Name, admission number, phone, receipt or invoice number"
          className={inputClass}
        />
        <button
          type="submit"
          className={buttonClass("primary", "md", "shrink-0")}
        >
          Search
        </button>
      </form>

      {query.trim().length === 0 ? (
        <p className="px-1 text-sm text-slate-500">
          Type at least two characters. A phone number finds the guardian and their children; an
          admission number finds the pupil, their invoices and their receipts.
        </p>
      ) : query.trim().length < 2 ? (
        <p className="px-1 text-sm text-slate-500">Type at least two characters.</p>
      ) : results.total === 0 ? (
        <Card>
          <p className="px-4 py-10 text-center text-sm text-slate-500">
            Nothing matches &ldquo;{results.query}&rdquo;.
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          {results.groups.map((group) => (
            <Card key={group.label} title={group.label}>
              <ul className="divide-y divide-slate-100">
                {group.hits.map((hit) => (
                  <li key={hit.id}>
                    <Link
                      href={hit.href}
                      className="flex items-center gap-3 px-4 py-3 transition hover:bg-slate-50"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-bold text-slate-900">
                          {hit.title}
                        </span>
                        <span className="block truncate text-xs text-slate-500">{hit.detail}</span>
                      </span>
                      <span aria-hidden="true" className="shrink-0 text-slate-300">
                        &rarr;
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
          {results.capped ? (
            <p className="px-1 text-xs text-slate-400">
              Showing the first few of each kind. Narrow the search to see more.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
