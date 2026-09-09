import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMyChild } from "@/lib/portal-auth";
import { getChildHeader, getPublishedTerms } from "@/lib/portal-data";
import { ChildHeader } from "../../child-header";

export const metadata = { title: "Report cards · School OS" };

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export default async function ChildResultsPage({
  params,
}: PageProps<"/portal/[studentId]/results">) {
  const { studentId } = await params;
  await requireMyChild(studentId);

  const child = await getChildHeader(studentId);
  if (!child) notFound();

  const terms = await getPublishedTerms(studentId);

  return (
    <div className="space-y-5">
      <ChildHeader child={child} />

      <h2 className="font-heading text-lg font-extrabold tracking-tight text-slate-900">
        Report cards
      </h2>

      {terms.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-600">
          No report card has been published yet. They appear here once the school
          releases the term&apos;s results.
        </p>
      ) : (
        <ul className="space-y-3">
          {terms.map((t) => (
            <li key={t.termId}>
              <Link
                href={`/portal/${studentId}/results/${t.termId}`}
                className="flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-brand-300 hover:shadow-sm"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-bold text-slate-900">
                    {t.term.name} Term · {t.term.academicYear.name}
                  </p>
                  <p className="truncate text-sm text-slate-500">
                    {t.publishedAt ? `Published ${dateFmt.format(t.publishedAt)}` : "Published"}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  {t.average != null ? (
                    <p className="font-bold tabular-nums text-slate-900">
                      {Number(t.average).toFixed(1)}%
                    </p>
                  ) : null}
                  {t.classPosition && t.classSize ? (
                    <p className="text-xs text-slate-500">
                      {t.classPosition} of {t.classSize}
                    </p>
                  ) : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
