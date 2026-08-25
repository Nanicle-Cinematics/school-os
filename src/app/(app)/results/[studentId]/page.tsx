import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole, requireAuth } from "@/lib/auth";
import { ACADEMIC, LEADERSHIP, canAccess } from "@/lib/permissions";
import { getReportCard } from "@/lib/results-data";
import { saveRemarks } from "@/lib/results-actions";
import { StatusBadge, inputClass } from "../../ui";
import { ReportCard } from "../report-card";
import { SubmitButton } from "../../submit-button";

export const metadata: Metadata = { title: "Report card · School OS" };

export default async function ReportCardPage({
  params,
  searchParams,
}: PageProps<"/results/[studentId]">) {
  await requireRole(ACADEMIC);
  const auth = await requireAuth();
  const { studentId } = await params;
  const query = await searchParams;
  const termId = typeof query.term === "string" ? query.term : "";

  if (!termId) {
    notFound();
  }

  const data = await getReportCard(termId, studentId);
  if (!data) {
    notFound();
  }

  const { termResult, subjectResults, settings } = data;
  const isLeadership = canAccess(auth.roles, LEADERSHIP);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between print:hidden">
        <Link
          href={`/results/broadsheet?term=${termId}&class=${termResult.classGroupId}`}
          className="text-sm text-slate-500 hover:text-slate-900"
        >
          ← Broadsheet
        </Link>
        <StatusBadge status={termResult.status} />
      </div>

      <ReportCard
        schoolName={auth.schoolName}
        termResult={termResult}
        subjectResults={subjectResults}
        settings={settings}
      />

      {/* Remarks editor — never printed. */}
      <form
        action={saveRemarks}
        className="rounded-xl border border-slate-200 bg-white p-4 print:hidden"
      >
        <input type="hidden" name="termId" value={termId} />
        <input type="hidden" name="studentId" value={studentId} />
        <h2 className="text-sm font-semibold text-slate-900">Edit remarks and attendance</h2>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Conduct</span>
            <input
              name="conduct"
              defaultValue={termResult.conduct ?? ""}
              className={inputClass}
              placeholder="e.g. Respectful"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Attitude</span>
            <input name="attitude" defaultValue={termResult.attitude ?? ""} className={inputClass} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Interest</span>
            <input name="interest" defaultValue={termResult.interest ?? ""} className={inputClass} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Days present</span>
            <input
              type="number"
              name="daysPresent"
              defaultValue={termResult.daysPresent ?? ""}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Days in term</span>
            <input
              type="number"
              name="daysTotal"
              defaultValue={termResult.daysTotal ?? ""}
              className={inputClass}
            />
          </label>
        </div>

        <div className="mt-3 space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">
              Class teacher&rsquo;s remark
            </span>
            <input
              name="formTeacherRemark"
              defaultValue={termResult.formTeacherRemark ?? ""}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">
              Head teacher&rsquo;s remark {isLeadership ? "" : "(head only)"}
            </span>
            <input
              name="headRemark"
              defaultValue={termResult.headRemark ?? ""}
              disabled={!isLeadership}
              className={`${inputClass} disabled:bg-slate-50 disabled:text-slate-400`}
            />
          </label>
        </div>

        <div className="mt-4">
          <SubmitButton pendingLabel="Saving…">Save remarks</SubmitButton>
        </div>
      </form>
    </div>
  );
}
