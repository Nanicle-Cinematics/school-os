import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Plus } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { PAYROLL } from "@/lib/permissions";
import { getStaffPay } from "@/lib/payroll-data";
import { fromPesewas } from "@/lib/payroll-rules";
import { Card, PageHeader } from "../../../ui";
import { ButtonLink, DataTable, Row, cellClass, type Column } from "../../../primitives";
import { AddItemForm, ItemControls, StaffPayForm } from "../../forms";
import { gh } from "../../format";

export const metadata: Metadata = { title: "Pay · School OS" };
export const dynamic = "force-dynamic";

const COLUMNS: Column[] = [
  { label: "Item" },
  { label: "Amount a month", numeric: true },
  { label: "Still owed", numeric: true, hideBelow: "sm" },
  { label: "" },
];

export default async function StaffPayPage({ params }: PageProps<"/payroll/people/[staffId]">) {
  const auth = await requireRole(PAYROLL);
  const { staffId } = await params;
  const data = await getStaffPay(auth.schoolId, staffId);
  if (!data) notFound();

  const { staff, pay, items } = data;
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title={staff.name}
        subtitle={[staff.staffNo, staff.designation].filter(Boolean).join(" · ")}
        action={<ButtonLink href="/payroll/people">All pay records</ButtonLink>}
      />

      <Card title="Basic salary">
        <StaffPayForm staffId={staff.id} basic={pay ? fromPesewas(pay.basic) : ""} ssnitApplies={pay?.ssnitApplies ?? true} />
        <p className="border-t border-hairline px-4.5 py-3 text-xs text-slate-500">
          SSNIT number {staff.ssnitNumber ?? "not recorded"} · TIN {staff.tin ?? "not recorded"}. Both print on the payslip; edit them on{" "}
          <Link href={`/staff/${staff.id}`} className="text-brand-ink hover:underline">
            the staff page
          </Link>
          .
        </p>
      </Card>

      {pay ? (
        <>
          <DataTable columns={COLUMNS} empty={{ icon: Plus, title: "No allowances or deductions yet." }}>
            {items.map((item) => (
              <Row key={item.id}>
                <td className={cellClass(COLUMNS[0])}>
                  <span className={`block font-semibold ${item.active ? "text-slate-900" : "text-slate-400 line-through"}`}>{item.name}</span>
                  <span className="block text-xs text-slate-400">
                    {item.kind === "ALLOWANCE" ? (item.taxable ? "Allowance, taxable" : "Allowance, not taxed") : item.principal === null ? "Deduction until stopped" : `Deduction, loan of ${gh(item.principal)}`}
                    {item.active ? "" : " · stopped"}
                  </span>
                </td>
                <td className={cellClass(COLUMNS[1])}>
                  {item.kind === "DEDUCTION" ? "− " : ""}
                  {gh(item.amount)}
                </td>
                <td className={cellClass(COLUMNS[2])}>{item.owed === null ? "—" : item.owed === 0 ? "Cleared" : gh(item.owed)}</td>
                <td className={`${cellClass(COLUMNS[3])} text-right`}>
                  <ItemControls staffId={staff.id} itemId={item.id} active={item.active} />
                </td>
              </Row>
            ))}
          </DataTable>
          <Card title="Add an allowance or a deduction">
            <AddItemForm staffId={staff.id} />
          </Card>
        </>
      ) : (
        <p className="text-sm text-slate-500">Set the basic salary first. Allowances and deductions come after.</p>
      )}
    </div>
  );
}
