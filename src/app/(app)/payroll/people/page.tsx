import type { Metadata } from "next";
import Link from "next/link";
import { Users } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { PAYROLL } from "@/lib/permissions";
import { getPayRecords } from "@/lib/payroll-data";
import { Avatar, PageHeader } from "../../ui";
import { ButtonLink, DataTable, Row, cellClass, type Column } from "../../primitives";
import { gh } from "../format";

export const metadata: Metadata = { title: "Pay records · School OS" };
export const dynamic = "force-dynamic";

const COLUMNS: Column[] = [
  { label: "Staff" },
  { label: "Role", hideBelow: "md" },
  { label: "Basic salary", numeric: true },
  { label: "Allowances and deductions", numeric: true, hideBelow: "sm" },
  { label: "SSNIT", hideBelow: "lg" },
];

export default async function PayRecordsPage() {
  const auth = await requireRole(PAYROLL);
  const people = await getPayRecords(auth.schoolId);
  const missing = people.filter((p) => p.basic === null).length;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Pay records"
        subtitle={missing ? `${missing} of ${people.length} have no basic salary yet, so they are left out of a run.` : "Each person's basic salary, allowances and deductions."}
        action={<ButtonLink href="/payroll">Payroll</ButtonLink>}
      />
      <DataTable columns={COLUMNS} empty={{ icon: Users, title: "There are no active staff yet. Add them under Staff first." }}>
        {people.map((p) => (
          <Row key={p.id}>
            <td className={cellClass(COLUMNS[0])}>
              <Link href={`/payroll/people/${p.id}`} className="group flex items-center gap-3">
                <Avatar firstName={p.name.split(" ")[0] ?? ""} lastName={p.name.split(" ").slice(1).join(" ")} />
                <span className="min-w-0">
                  <span className="block truncate font-semibold text-slate-900 group-hover:underline">{p.name}</span>
                  <span className="block font-mono text-[11px] text-slate-400">{p.staffNo}</span>
                </span>
              </Link>
            </td>
            <td className={`${cellClass(COLUMNS[1])} text-slate-600`}>{p.designation ?? "—"}</td>
            <td className={`${cellClass(COLUMNS[2])} font-semibold ${p.basic === null ? "text-warning-ink" : "text-slate-900"}`}>
              {p.basic === null ? "Not set" : gh(p.basic)}
            </td>
            <td className={`${cellClass(COLUMNS[3])} text-slate-600`}>{p.items}</td>
            <td className={`${cellClass(COLUMNS[4])} text-slate-600`}>{p.basic === null ? "—" : p.ssnitApplies ? "Contributes" : "Not enrolled"}</td>
          </Row>
        ))}
      </DataTable>
    </div>
  );
}
