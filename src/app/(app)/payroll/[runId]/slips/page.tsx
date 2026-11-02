import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { PAYROLL } from "@/lib/permissions";
import { getBillSchool } from "@/lib/invoice-data";
import { getPayslips } from "@/lib/payroll-data";
import { periodLabel } from "@/lib/payroll-rules";
import { PrintButton } from "../../../print-button";
import { PayslipSheet } from "../../payslip-sheet";

export const metadata: Metadata = { title: "Payslips · School OS" };
export const dynamic = "force-dynamic";

export default async function PayslipsPage({ params, searchParams }: PageProps<"/payroll/[runId]/slips">) {
  const auth = await requireRole(PAYROLL);
  const { runId } = await params;
  const query = await searchParams;
  const only = typeof query.staff === "string" ? query.staff : "";

  const data = await getPayslips(auth.schoolId, runId, only || undefined);
  const school = await getBillSchool(auth.schoolId);
  if (!data || !school) notFound();

  const { run, slips } = data;
  const label = periodLabel(run.periodYear, run.periodMonth);
  const provisional = run.status === "DRAFT";

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div>
          <Link href={`/payroll/${runId}`} className="text-sm text-slate-500 hover:text-slate-900">
            ← {label}
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">
            {only && slips[0] ? slips[0].name : `${slips.length} payslip${slips.length === 1 ? "" : "s"}`} · {label}
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">One sheet each. Use your browser&rsquo;s print dialog, or the button.</p>
        </div>
        <PrintButton label={only ? "Print this payslip" : `Print ${slips.length} payslips`} />
      </div>
      {provisional ? <p className="rounded-control bg-warning-tint px-3.5 py-2.5 text-sm text-warning-ink print:hidden">This run is still a draft. Payslips printed now say so.</p> : null}
      {slips.map((slip, i) => (
        <PayslipSheet
          key={slip.id}
          school={school}
          slip={slip}
          year={run.periodYear}
          month={run.periodMonth}
          provisional={provisional}
          printedBy={auth.name}
          breakAfter={i < slips.length - 1}
        />
      ))}
    </div>
  );
}
