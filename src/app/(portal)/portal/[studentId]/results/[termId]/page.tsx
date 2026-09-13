import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMyChild } from "@/lib/portal-auth";
import { getPublishedReportCard } from "@/lib/portal-data";
import { formatCedis } from "@/lib/money";
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

  const back = (
    <Link
      href={`/portal/${studentId}/results`}
      className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
    >
      ← All report cards
    </Link>
  );

  /**
   * Withheld for arrears. Says the amount and how to pay, because a parent who
   * is only told "no" has to ring the school to find out what for — and the
   * school turned this on precisely so the conversation would be about the fees
   * rather than about the software.
   */
  if (data.held) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">{back}</div>
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <h2 className="font-heading text-base font-extrabold text-amber-900">
            This report card is being held
          </h2>
          <p className="mt-2 text-sm text-amber-900">
            The school releases report cards once fees are settled.{" "}
            <strong className="font-semibold tabular-nums">
              {formatCedis(data.hold.balance)}
            </strong>{" "}
            is outstanding on invoice {data.hold.invoiceNo}.
          </p>
          {data.paymentInstructions ? (
            <div className="mt-3 border-t border-amber-200 pt-3">
              <p className="text-xs font-semibold text-amber-800">
                How to pay
              </p>
              <p className="mt-1 whitespace-pre-line text-sm text-amber-900">
                {data.paymentInstructions}
              </p>
            </div>
          ) : null}
          <p className="mt-3 text-xs text-amber-800">
            The card appears here as soon as the payment is recorded. Speak to the
            school office if you have already paid.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 print:hidden">
        {back}
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
