import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Banknote, Coins, Landmark, ReceiptText, Users } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { PAYROLL, PAYROLL_APPROVE, canAccess } from "@/lib/permissions";
import { getRun } from "@/lib/payroll-data";
import { periodLabel } from "@/lib/payroll-rules";
import { Alert, Card, PageHeader, StatusBadge } from "../../ui";
import { ButtonLink, DataTable, Row, StatCard, cellClass, type Column } from "../../primitives";
import { ApproveButton, DeleteRunButton, MarkPaidForm, RecalculateButton, ReopenButton } from "../forms";
import { day, gh } from "../format";

export const metadata: Metadata = { title: "Payroll run · School OS" };
export const dynamic = "force-dynamic";

const COLUMNS: Column[] = [
  { label: "Employee" },
  { label: "Basic", numeric: true, hideBelow: "md" },
  { label: "Allowances", numeric: true, hideBelow: "lg" },
  { label: "SSNIT", numeric: true, hideBelow: "sm" },
  { label: "PAYE", numeric: true, hideBelow: "sm" },
  { label: "Deductions", numeric: true, hideBelow: "lg" },
  { label: "Net pay", numeric: true },
];

export default async function PayrollRunPage({ params }: PageProps<"/payroll/[runId]">) {
  const auth = await requireRole(PAYROLL);
  const { runId } = await params;
  const data = await getRun(auth.schoolId, runId);
  if (!data) notFound();

  const { run, rows, totals, stale, missing } = data;
  const canApprove = canAccess(auth.roles, PAYROLL_APPROVE);
  const label = periodLabel(run.periodYear, run.periodMonth);
  const today = new Date().toISOString().slice(0, 10);
  const unpaid = missing.filter((m) => !m.hasPay);
  const flagged = rows.filter((r) => r.warnings);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title={label}
        subtitle={`${run.rateSet.label}${run.note ? ` · ${run.note}` : ""}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={run.status} />
            <ButtonLink href={`/payroll/${run.id}/slips`} icon={ReceiptText}>Payslips</ButtonLink>
            <ButtonLink href={`/payroll/${run.id}/schedule`} icon={Landmark}>SSNIT and PAYE</ButtonLink>
          </div>
        }
      />

      {run.status === "DRAFT" && stale ? (
        <Alert tone="error">
          Pay records or rates have changed since this run was worked out, so what it shows is out of date. Work it out again before approving.
        </Alert>
      ) : null}
      {run.status === "DRAFT" && !run.rateSet.confirmedAt ? (
        <Alert tone="error">
          The rates for this run have not been confirmed. Check them against GRA and SSNIT under{" "}
          <Link href="/payroll/setup" className="underline">Set-up</Link>; a run cannot be approved until they are.
        </Alert>
      ) : null}
      {unpaid.length > 0 ? (
        <Alert tone="error">
          {unpaid.length} active {unpaid.length === 1 ? "member of staff has" : "members of staff have"} no pay record and {unpaid.length === 1 ? "is" : "are"} not in this run:{" "}
          {unpaid.slice(0, 6).map((m) => m.name).join(", ")}
          {unpaid.length > 6 ? ` and ${unpaid.length - 6} more` : ""}. <Link href="/payroll/people" className="underline">Pay records</Link>
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="People" value={String(totals.people)} icon={Users} />
        <StatCard label="Gross pay" value={gh(totals.gross)} icon={Coins} />
        <StatCard label="PAYE and SSNIT to remit" value={gh(totals.paye + totals.ssnitEmployee + totals.ssnitEmployer)} caption={`PAYE ${gh(totals.paye)}`} icon={Landmark} />
        <StatCard label="Net pay" value={gh(totals.net)} icon={Banknote} hero />
      </div>

      <DataTable columns={COLUMNS} empty={{ icon: Users, title: "Nobody is in this run. Set each person's basic salary under Pay records, then work it out again." }}>
        {rows.map((r) => (
          <Row key={r.id}>
            <td className={cellClass(COLUMNS[0])}>
              <Link href={`/payroll/${run.id}/slips?staff=${r.staffId}`} className="font-semibold text-slate-900 hover:underline">
                {r.name}
              </Link>
              <span className="block text-xs text-slate-400">{[r.staffNo, r.designation].filter(Boolean).join(" · ")}</span>
              {r.warnings ? <span className="block whitespace-pre-line text-xs text-warning-ink">{r.warnings}</span> : null}
            </td>
            <td className={cellClass(COLUMNS[1])}>{gh(r.basic)}</td>
            <td className={cellClass(COLUMNS[2])}>{gh(r.allowances)}</td>
            <td className={cellClass(COLUMNS[3])}>{gh(r.ssnitEmployee)}</td>
            <td className={cellClass(COLUMNS[4])}>{gh(r.paye)}</td>
            <td className={cellClass(COLUMNS[5])}>{gh(r.deductions)}</td>
            <td className={`${cellClass(COLUMNS[6])} font-semibold text-slate-900`}>{gh(r.net)}</td>
          </Row>
        ))}
      </DataTable>
      {flagged.length > 0 ? <p className="text-sm text-warning-ink">{flagged.length} {flagged.length === 1 ? "payslip has" : "payslips have"} a note above. Read it before approving.</p> : null}

      {run.status === "DRAFT" ? (
        <Card title="This draft">
          <div className="grid gap-4 px-4.5 py-4 sm:grid-cols-3">
            <RecalculateButton runId={run.id} />
            {canApprove ? <ApproveButton runId={run.id} /> : <p className="text-sm text-slate-500">A head teacher or the proprietor approves the run.</p>}
            <DeleteRunButton runId={run.id} />
          </div>
        </Card>
      ) : null}

      {run.status === "APPROVED" ? (
        <Card title="Approved">
          <div className="grid gap-5 px-4.5 py-4 sm:grid-cols-2">
            <p className="text-sm text-slate-600">
              Approved {day(run.approvedAt)}. When the salaries have been paid out, mark the run paid so the accounts show it. A mistake
              found before then is corrected by reopening the run.
            </p>
            {canApprove ? (
              <div className="space-y-5">
                <MarkPaidForm runId={run.id} today={today} />
                <ReopenButton runId={run.id} />
              </div>
            ) : (
              <p className="text-sm text-slate-500">A head teacher or the proprietor marks it paid or reopens it.</p>
            )}
          </div>
        </Card>
      ) : null}

      {run.status === "PAID" ? <p className="text-sm text-slate-500">Paid {day(run.paidOn)}. A paid run is final.</p> : null}
    </div>
  );
}
