import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMyChild } from "@/lib/portal-auth";
import { getChildHeader, getChildFinance, getPublishedTerms } from "@/lib/portal-data";
import { formatCedis } from "@/lib/money";
import { termLabel } from "@/lib/academic-year";
import { ChildHeader } from "../child-header";

export const metadata = { title: "My child · School OS" };

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export default async function ChildOverviewPage({ params }: PageProps<"/portal/[studentId]">) {
  const { studentId } = await params;
  // Ownership is checked before a single row about this child is read.
  await requireMyChild(studentId);

  const child = await getChildHeader(studentId);
  if (!child) notFound();

  const finance = await getChildFinance(studentId);
  const terms = await getPublishedTerms(studentId);
  const latest = terms[0] ?? null;

  const owing = Number(finance.outstanding) > 0;

  return (
    <div className="space-y-5">
      <ChildHeader child={child} />

      <Link
        href={`/portal/${studentId}/fees`}
        className="block rounded-2xl border border-slate-200 bg-surface p-5 transition hover:border-brand-300 hover:shadow-sm"
      >
        <div className="flex items-baseline justify-between gap-4">
          <p className="text-sm font-semibold text-slate-600">School fees</p>
          <span className="text-xs font-semibold text-brand-ink">View bills &amp; receipts →</span>
        </div>
        <p
          className={`mt-2 text-3xl font-extrabold tabular-nums ${
            owing ? "text-accent-700" : "text-brand-ink"
          }`}
        >
          {owing ? formatCedis(finance.outstanding) : "Paid up"}
        </p>
        <p className="mt-1 text-sm text-slate-500">
          {owing
            ? `Outstanding across ${finance.invoices.length} bill${finance.invoices.length === 1 ? "" : "s"}`
            : "Nothing outstanding. Thank you."}
        </p>
      </Link>

      <Link
        href={`/portal/${studentId}/results`}
        className="block rounded-2xl border border-slate-200 bg-surface p-5 transition hover:border-brand-300 hover:shadow-sm"
      >
        <div className="flex items-baseline justify-between gap-4">
          <p className="text-sm font-semibold text-slate-600">Report cards</p>
          {terms.length > 0 ? (
            <span className="text-xs font-semibold text-brand-ink">See all →</span>
          ) : null}
        </div>

        {latest ? (
          <>
            <p className="mt-2 text-lg font-extrabold text-slate-900">
              {termLabel(latest.term.name)} Term · {latest.term.academicYear.name}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              {latest.average != null ? `Average ${Number(latest.average).toFixed(1)}%` : "Published"}
              {latest.classPosition && latest.classSize
                ? ` · ${latest.classPosition} of ${latest.classSize}`
                : ""}
              {latest.publishedAt ? ` · ${dateFmt.format(latest.publishedAt)}` : ""}
            </p>
          </>
        ) : (
          // Says WHY there is nothing rather than showing a blank card: an
          // unpublished result is invisible here by design, and a parent should
          // not read that as the school having lost the marks.
          <p className="mt-2 text-sm text-slate-500">
            No report card has been published yet. They appear here once the
            school releases the term&apos;s results.
          </p>
        )}
      </Link>
    </div>
  );
}
