import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole, requireAuth } from "@/lib/auth";
import { LEADERSHIP, canAccess } from "@/lib/permissions";
import { getReportCard } from "@/lib/results-data";
import { saveRemarks } from "@/lib/results-actions";
import { reportHold } from "@/lib/report-access";
import { formatCedis } from "@/lib/money";
import { StatusBadge, inputClass } from "../../ui";
import { ReportCard } from "../report-card";
import { SubmitButton } from "../../submit-button";

export const metadata: Metadata = { title: "Report card · School OS" };

export default async function ReportCardPage({
  params,
  searchParams,
}: PageProps<"/results/[studentId]">) {
  await requireRole(LEADERSHIP);
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
  // Staff are shown the card whatever the family owes — the office needs it to
  // have the conversation — but they are told what the parent is seeing.
  const hold = await reportHold(studentId, termId, settings);

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

      {hold ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 print:hidden">
          <strong className="font-semibold">Held from the parent.</strong>{" "}
          {formatCedis(hold.balance)} outstanding on invoice {hold.invoiceNo}, and the
          school withholds cards in arrears. It is left out of the class print run and
          the portal until the payment is recorded. You can still read it here.
        </div>
      ) : null}

      <ReportCard
        schoolName={auth.schoolName}
          schoolMotto={auth.schoolMotto}
          schoolCrestUrl={auth.schoolCrestUrl}
          headSignatureUrl={auth.headSignatureUrl}
          headName={auth.headName}
        termResult={termResult}
        subjectResults={subjectResults}
        settings={settings}
      />

      {/* Remarks editor — never printed. */}
      <form
        action={saveRemarks}
        className="rounded-card border border-hairline bg-surface p-4 print:hidden"
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
