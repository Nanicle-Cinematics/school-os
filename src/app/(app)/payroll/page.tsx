import type { Metadata } from "next";
import Link from "next/link";
import { Check, Circle, Coins } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { PAYROLL, PAYROLL_APPROVE, canAccess } from "@/lib/permissions";
import { getPayrollOverview } from "@/lib/payroll-data";
import { periodKey, periodLabel } from "@/lib/payroll-rules";
import { Card, PageHeader, StatusBadge } from "../ui";
import { ButtonLink, DataTable, Row, cellClass, type Column } from "../primitives";
import { StartRunForm } from "./forms";
import { day, gh } from "./format";

export const metadata: Metadata = { title: "Payroll · School OS" };
export const dynamic = "force-dynamic";

const COLUMNS: Column[] = [
  { label: "Month" },
  { label: "People", numeric: true, hideBelow: "sm" },
  { label: "Gross pay", numeric: true, hideBelow: "md" },
  { label: "PAYE", numeric: true, hideBelow: "lg" },
  { label: "Net pay", numeric: true },
  { label: "Status" },
];

export default async function PayrollPage() {
  const auth = await requireRole(PAYROLL);
  const { runs, setup } = await getPayrollOverview(auth.schoolId);
  const canApprove = canAccess(auth.roles, PAYROLL_APPROVE);

  const now = new Date();
  const thisMonth = periodKey(now.getUTCFullYear(), now.getUTCMonth() + 1);

  const steps = [
    { done: setup.rateSets > 0, text: "Pay rates are set up", href: "/payroll/setup" },
    { done: setup.confirmedRateSets > 0, text: "Pay rates have been checked and confirmed", href: "/payroll/setup" },
    { done: setup.accountsMapped >= setup.accountsNeeded, text: "The accounts a run posts to are chosen", href: "/payroll/setup" },
    {
      done: setup.staffPaid > 0 && setup.staffPaid >= setup.staffActive,
      text: `Every member of staff has a pay record (${setup.staffPaid} of ${setup.staffActive})`,
      href: "/payroll/people",
    },
  ];
  const ready = steps.every((s) => s.done);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Payroll"
        subtitle="What each person is paid, with PAYE and SSNIT worked out, a payslip for each and the entry for the accounts."
        action={
          <div className="flex flex-wrap gap-2">
            <ButtonLink href="/payroll/people">Pay records</ButtonLink>
            <ButtonLink href="/payroll/setup">Set-up</ButtonLink>
          </div>
        }
      />

      {ready ? null : (
        <Card title="Before the first run">
          <ul className="divide-y divide-hairline">
            {steps.map((step) => (
              <li key={step.text} className="flex items-center gap-3 px-4.5 py-3 text-sm">
                {step.done ? (
                  <Check className="h-4 w-4 shrink-0 text-success-ink" aria-label="Done" />
                ) : (
                  <Circle className="h-4 w-4 shrink-0 text-slate-300" aria-label="Not done" />
                )}
                <span className={step.done ? "text-slate-500" : "text-slate-900"}>{step.text}</span>
                {step.done ? null : (
                  <Link href={step.href} className="ml-auto text-brand-ink hover:underline">
                    Go
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Work out a month">
        <StartRunForm defaultMonth={thisMonth} maxMonth={thisMonth} />
      </Card>

      <DataTable
        columns={COLUMNS}
        empty={{ icon: Coins, title: "No payroll has been run yet. Work out the first month above once the steps are done." }}
      >
        {runs.map((run) => (
          <Row key={run.id}>
            <td className={cellClass(COLUMNS[0])}>
              <Link href={`/payroll/${run.id}`} className="font-semibold text-slate-900 hover:underline">
                {periodLabel(run.periodYear, run.periodMonth)}
              </Link>
              <span className="block text-xs text-slate-400">
                {run.status === "PAID" ? `paid ${day(run.paidOn)}` : run.status === "APPROVED" ? `approved ${day(run.approvedAt)}` : run.rateSet.label}
              </span>
            </td>
            <td className={cellClass(COLUMNS[1])}>{run.people}</td>
            <td className={cellClass(COLUMNS[2])}>{gh(run.gross)}</td>
            <td className={cellClass(COLUMNS[3])}>{gh(run.paye)}</td>
            <td className={`${cellClass(COLUMNS[4])} font-semibold text-slate-900`}>{gh(run.net)}</td>
            <td className={cellClass(COLUMNS[5])}>
              <StatusBadge status={run.status} />
            </td>
          </Row>
        ))}
      </DataTable>

      {canApprove ? null : (
        <p className="text-sm text-slate-500">A head teacher or the proprietor approves a run and marks it paid.</p>
      )}
    </div>
  );
}
