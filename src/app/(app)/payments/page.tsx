import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { FINANCE } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { getPaymentList } from "@/lib/payment-data";
import { reversePayment } from "@/lib/payment-actions";
import { formatCedis } from "@/lib/money";
import {
  PageHeader,
  Stat,
  Card,
  StatusBadge,
  EmptyRow,
  Alert,
  inputClass,
  thClass,
  tableHeadClass,
} from "../ui";
import { SubmitButton } from "../submit-button";
import { RecordForm, type StudentOption } from "./record-form";

export const metadata: Metadata = { title: "Payments · School OS" };

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

export default async function PaymentsPage({ searchParams }: PageProps<"/payments">) {
  await requireRole(FINANCE);
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.trim() : undefined;
  const method = typeof params.method === "string" ? params.method : undefined;
  const receipt = typeof params.receipt === "string" ? params.receipt : undefined;

  const [data, students] = await Promise.all([
    getPaymentList({ q, method }),
    prisma.student.findMany({
      where: { status: "ACTIVE", deletedAt: null },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        admissionNo: true,
        currentClassGroup: { select: { name: true, level: { select: { name: true } } } },
        invoices: {
          where: { balance: { gt: 0 }, status: { not: "CANCELLED" } },
          select: { balance: true },
        },
      },
    }),
  ]);

  const options: StudentOption[] = students.map((student) => ({
    id: student.id,
    label: `${student.lastName}, ${student.firstName}`,
    admissionNo: student.admissionNo,
    className: student.currentClassGroup
      ? `${student.currentClassGroup.level.name} ${student.currentClassGroup.name}`
      : "Unassigned",
    balance: student.invoices.reduce((sum, invoice) => sum + Number(invoice.balance), 0),
  }));

  const owing = options.filter((option) => option.balance > 0).length;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader title="Payments" subtitle={`${data.count} recorded`} />

      {receipt ? (
        <Alert tone="success">
          Payment recorded. Receipt number <span className="font-mono font-semibold">{receipt}</span>{" "}
          — give this to the parent.
        </Alert>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total received" value={formatCedis(data.total)} tone="positive" />
        <Stat label="Payments" value={String(data.count)} />
        <Stat label="Students owing" value={String(owing)} tone={owing > 0 ? "negative" : "positive"} />
        <Stat label="Students on roll" value={String(options.length)} />
      </div>

      <RecordForm students={options} />

      <form className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-white p-3">
        <input
          type="search"
          name="q"
          defaultValue={q ?? ""}
          placeholder="Receipt no., reference or student"
          className={`${inputClass} w-64`}
        />
        <select name="method" defaultValue={method ?? ""} className={`${inputClass} w-auto`}>
          <option value="">Any method</option>
          <option value="CASH">Cash</option>
          <option value="MOBILE_MONEY">Mobile money</option>
          <option value="BANK_DEPOSIT">Bank deposit</option>
          <option value="BANK_TRANSFER">Bank transfer</option>
          <option value="CHEQUE">Cheque</option>
        </select>
        <button
          type="submit"
          className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white shadow-[0_6px_16px_rgba(18,128,92,0.22)] transition hover:bg-brand-700"
        >
          Filter
        </button>
        <Link
          href="/payments"
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 transition hover:bg-slate-50"
        >
          Reset
        </Link>
      </form>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className={tableHeadClass}>
              <tr>
                <th className={thClass}>Receipt</th>
                <th className={thClass}>Date</th>
                <th className={thClass}>Student</th>
                <th className={thClass}>Method</th>
                <th className={thClass}>Applied to</th>
                <th className={`${thClass} text-right`}>Amount</th>
                <th className={thClass}>Status</th>
                <th className={thClass} />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.payments.length === 0 ? (
                <EmptyRow colSpan={8}>No payments recorded yet.</EmptyRow>
              ) : (
                data.payments.map((payment) => (
                  <tr key={payment.id} className="hover:bg-slate-50">
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-slate-900">
                      {payment.receiptNo}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                      {dateFmt.format(payment.paidAt)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <span className="font-medium text-slate-900">
                        {payment.student.lastName}, {payment.student.firstName}
                      </span>
                      <span className="ml-2 font-mono text-xs text-slate-400">
                        {payment.student.admissionNo}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                      {payment.method.replace(/_/g, " ").toLowerCase()}
                      {payment.momoNetwork ? ` (${payment.momoNetwork})` : ""}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-slate-500">
                      {payment.allocations.length === 0
                        ? "unallocated"
                        : payment.allocations.map((a) => a.invoice.invoiceNo).join(", ")}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right font-medium tabular-nums text-slate-900">
                      {formatCedis(payment.amount)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <StatusBadge status={payment.status} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right">
                      {payment.status === "CONFIRMED" ? (
                        <form action={reversePayment}>
                          <input type="hidden" name="paymentId" value={payment.id} />
                          <input type="hidden" name="reason" value="Reversed by bursar" />
                          <SubmitButton variant="danger" pendingLabel="Reversing…">
                            Reverse
                          </SubmitButton>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
