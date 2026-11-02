import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FileText } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { PAYROLL } from "@/lib/permissions";
import { getPayslips } from "@/lib/payroll-data";
import { periodLabel, remittanceSplit, sumRun } from "@/lib/payroll-rules";
import { PrintButton } from "../../../print-button";
import { DataTable, Row, cellClass, type Column } from "../../../primitives";
import { gh } from "../../format";

export const metadata: Metadata = { title: "Statutory schedules · School OS" };
export const dynamic = "force-dynamic";

const SSNIT_COLUMNS: Column[] = [
  { label: "Employee" },
  { label: "SSNIT number", hideBelow: "sm" },
  { label: "Basic salary", numeric: true },
  { label: "Employee share", numeric: true },
  { label: "Employer share", numeric: true },
  { label: "Total", numeric: true },
];

const PAYE_COLUMNS: Column[] = [
  { label: "Employee" },
  { label: "TIN", hideBelow: "sm" },
  { label: "Gross pay", numeric: true },
  { label: "Taxable pay", numeric: true, hideBelow: "md" },
  { label: "Chargeable", numeric: true, hideBelow: "md" },
  { label: "PAYE", numeric: true },
];

export default async function SchedulePage({ params }: PageProps<"/payroll/[runId]/schedule">) {
  const auth = await requireRole(PAYROLL);
  const { runId } = await params;
  const data = await getPayslips(auth.schoolId, runId);
  if (!data) notFound();

  const { run, slips } = data;
  const label = periodLabel(run.periodYear, run.periodMonth);
  const totals = sumRun(slips);
  const split = remittanceSplit(totals);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div>
          <Link href={`/payroll/${runId}`} className="text-sm text-slate-500 hover:text-slate-900">
            ← {label}
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">Statutory schedules · {label}</h1>
          <p className="mt-0.5 text-sm text-slate-500">What is owed to SSNIT and to GRA for this month, one line a person.</p>
        </div>
        <PrintButton label="Print the schedules" />
      </div>
      {run.status === "DRAFT" ? (
        <p className="rounded-control bg-warning-tint px-3.5 py-2.5 text-sm text-warning-ink">This run is still a draft; the figures may change when it is approved.</p>
      ) : null}

      <h2 className="px-0.5 font-heading text-lg text-slate-900">SSNIT · {label}</h2>
      <DataTable columns={SSNIT_COLUMNS} empty={{ icon: FileText, title: "Nobody is in this run." }}>
        {slips.map((s) => (
          <Row key={s.id}>
            <td className={`${cellClass(SSNIT_COLUMNS[0])} font-semibold text-slate-900`}>{s.name}</td>
            <td className={`${cellClass(SSNIT_COLUMNS[1])} font-mono text-xs text-slate-600`}>{s.ssnitNumber ?? "not recorded"}</td>
            <td className={cellClass(SSNIT_COLUMNS[2])}>{gh(s.ssnitBase)}</td>
            <td className={cellClass(SSNIT_COLUMNS[3])}>{gh(s.ssnitEmployee)}</td>
            <td className={cellClass(SSNIT_COLUMNS[4])}>{gh(s.ssnitEmployer)}</td>
            <td className={`${cellClass(SSNIT_COLUMNS[5])} font-semibold`}>{gh(s.ssnitEmployee + s.ssnitEmployer)}</td>
          </Row>
        ))}
        <Row>
          <td className={`${cellClass(SSNIT_COLUMNS[0])} font-extrabold text-slate-900`}>Total</td>
          <td className={cellClass(SSNIT_COLUMNS[1])} />
          <td className={cellClass(SSNIT_COLUMNS[2])} />
          <td className={`${cellClass(SSNIT_COLUMNS[3])} font-extrabold`}>{gh(totals.ssnitEmployee)}</td>
          <td className={`${cellClass(SSNIT_COLUMNS[4])} font-extrabold`}>{gh(totals.ssnitEmployer)}</td>
          <td className={`${cellClass(SSNIT_COLUMNS[5])} font-extrabold text-slate-900`}>{gh(split.total)}</td>
        </Row>
      </DataTable>
      <p className="text-sm text-slate-500">
        Of the {gh(split.total)}: {gh(split.tier1)} to SSNIT (Tier 1) and {gh(split.tier2)} to the Tier 2 trustee. The split uses the Tier 2 share
        on the rates in use ({run.rateSet.label}); check it with the school&rsquo;s accountant before remitting.
      </p>

      <h2 className="px-0.5 pt-2 font-heading text-lg text-slate-900">PAYE · {label}</h2>
      <DataTable columns={PAYE_COLUMNS} empty={{ icon: FileText, title: "Nobody is in this run." }}>
        {slips.map((s) => (
          <Row key={s.id}>
            <td className={`${cellClass(PAYE_COLUMNS[0])} font-semibold text-slate-900`}>{s.name}</td>
            <td className={`${cellClass(PAYE_COLUMNS[1])} font-mono text-xs text-slate-600`}>{s.tin ?? "not recorded"}</td>
            <td className={cellClass(PAYE_COLUMNS[2])}>{gh(s.gross)}</td>
            <td className={cellClass(PAYE_COLUMNS[3])}>{gh(s.taxableIncome)}</td>
            <td className={cellClass(PAYE_COLUMNS[4])}>{gh(s.chargeable)}</td>
            <td className={`${cellClass(PAYE_COLUMNS[5])} font-semibold`}>{gh(s.paye)}</td>
          </Row>
        ))}
        <Row>
          <td className={`${cellClass(PAYE_COLUMNS[0])} font-extrabold text-slate-900`}>Total</td>
          <td className={cellClass(PAYE_COLUMNS[1])} />
          <td className={`${cellClass(PAYE_COLUMNS[2])} font-extrabold`}>{gh(totals.gross)}</td>
          <td className={cellClass(PAYE_COLUMNS[3])} />
          <td className={cellClass(PAYE_COLUMNS[4])} />
          <td className={`${cellClass(PAYE_COLUMNS[5])} font-extrabold text-slate-900`}>{gh(totals.paye)}</td>
        </Row>
      </DataTable>
    </div>
  );
}
