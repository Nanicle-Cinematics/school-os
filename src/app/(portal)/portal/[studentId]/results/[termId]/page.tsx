import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMyChild } from "@/lib/portal-auth";
import { getPublishedReportCard } from "@/lib/portal-data";
import { ReportCard } from "../../../../../(app)/results/report-card";

export const metadata = { title: "Report card · School OS" };

export default async function PortalReportCardPage({
  params,
}: PageProps<"/portal/[studentId]/results/[termId]">) {
  const { studentId, termId } = await params;
  // Two independent checks, both required: the child must be this guardian's,
  // and the card must be published. Either one alone leaks something — the
  // first another family's results, the second a draft the school is still
  // arguing about.
  const ctx = await requireMyChild(studentId);

  const data = await getPublishedReportCard(studentId, termId);
  if (!data) notFound();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 print:hidden">
        <Link
          href={`/portal/${studentId}/results`}
          className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
        >
          ← All report cards
        </Link>
        <p className="text-xs text-slate-500">Use your browser&apos;s print option to save a copy.</p>
      </div>

      <div className="overflow-x-auto">
        <ReportCard
          schoolName={ctx.schoolName}
          schoolMotto={ctx.schoolMotto}
          schoolCrestUrl={ctx.schoolCrestUrl}
          headSignatureUrl={ctx.headSignatureUrl}
          headName={ctx.headName}
          termResult={data.termResult}
          subjectResults={data.subjectResults}
          settings={data.settings}
        />
      </div>
    </div>
  );
}
