import type { Metadata } from "next";
import { buttonClass } from "../button-style";
import { Banknote, CircleAlert, Users } from "lucide-react";
import Link from "next/link";
import { paymentSource } from "@/lib/payment-labels";
import { requireRole } from "@/lib/auth";
import { FINANCE } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { getPaymentList } from "@/lib/payment-data";
import { reversePayment } from "@/lib/payment-actions";
import { formatCedis } from "@/lib/money";
import { netOutstanding } from "@/lib/invoice-engine";
import { PageHeader, Card, StatusBadge, Alert, filterClass } from "../ui";
import { DataTable, Row, StatCard, type Column } from "../primitives";
import { SubmitButton } from "../submit-button";
import { RecordForm, type StudentOption } from "./record-form";

export const metadata: Metadata = { title: "Payments · School OS" };

/**
 * What became of the receipt text, said under the receipt number.
 *
 * The outcome arrives in the redirect from recordPayment (`&sms=`). Every value
 * but "sent" is a reason the parent heard nothing, and each one names where it
 * is put right — before this line existed the office could not tell a receipt
 * that went from one that never did.
 */
function receiptTextLine(
  outcome: string | undefined,
  guardian: { name: string; phone: string | null } | null,
): { tone: "ok" | "warn"; text: React.ReactNode } | null {
  const who = guardian?.name ?? "the guardian";
  const settings = (
    <Link href="/settings/sms" className="font-medium underline">
      Settings → SMS
    </Link>
  );
  const log = (
    <Link href="/messages" className="font-medium underline">
      Messages
    </Link>
  );
  switch (outcome) {
    case "sent":
      return { tone: "ok", text: <>Receipt texted to {who}{guardian?.phone ? ` on ${guardian.phone}` : ""}.</> };
    case "dryRun":
      return { tone: "warn", text: <>Not texted: no SMS gateway is set up, so the receipt was only recorded in {log}. The parent received nothing.</> };
    case "failed":
      return { tone: "warn", text: <>The receipt text to {who} failed. The gateway&apos;s reason is in {log}.</> };
    case "smsOff":
      return { tone: "warn", text: <>Not texted: SMS is switched off in {settings}.</> };
    case "gateOff":
      return { tone: "warn", text: <>Not texted: receipt texts are switched off in {settings}.</> };
    case "noGuardian":
      return { tone: "warn", text: <>Not texted: this pupil has no primary guardian to send the receipt to.</> };
    case "noPhone":
      return { tone: "warn", text: <>Not texted: {who} has no valid phone number on record.</> };
    case "error":
      return { tone: "warn", text: <>The receipt text could not be sent. The payment itself is recorded.</> };
    default:
      return null;
  }
}

const COLUMNS: Column[] = [
  { label: "Receipt" },
  { label: "Date" },
  { label: "Student" },
  { label: "Amount", numeric: true },
  { label: "Method" },
  { label: "Applied to" },
  { label: "Status" },
  { label: "" },
];

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export default async function PaymentsPage({
  searchParams,
}: PageProps<"/payments">) {
  await requireRole(FINANCE);
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.trim() : undefined;
  const method = typeof params.method === "string" ? params.method : undefined;
  const receipt =
    typeof params.receipt === "string" ? params.receipt : undefined;
  const sms = typeof params.sms === "string" ? params.sms : undefined;

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
        currentClassGroup: {
          select: { name: true, level: { select: { name: true } } },
        },
        invoices: {
          where: { status: { not: "CANCELLED" } },
          select: { total: true, broughtForward: true },
        },
        payments: {
          where: { reversedAt: null, status: "CONFIRMED" },
          select: { amount: true },
        },
      },
    }),
  ]);

  // Only after a payment was just recorded: who its receipt was addressed to.
  const receiptGuardian = receipt
    ? await prisma.payment.findFirst({
        where: { receiptNo: receipt },
        select: { guardian: { select: { firstName: true, lastName: true, phone: true } } },
      })
    : null;
  const textLine = receipt
    ? receiptTextLine(
        sms,
        receiptGuardian?.guardian
          ? {
              name: `${receiptGuardian.guardian.firstName} ${receiptGuardian.guardian.lastName}`,
              phone: receiptGuardian.guardian.phone,
            }
          : null,
      )
    : null;

  const options: StudentOption[] = students.map((student) => ({
    id: student.id,
    label: `${student.lastName}, ${student.firstName}`,
    admissionNo: student.admissionNo,
    className: student.currentClassGroup
      ? `${student.currentClassGroup.level.name} ${student.currentClassGroup.name}`
      : "Unassigned",
    // Across terms, so NOT a sum of invoice balances: each term's invoice
    // carries the last one's arrears forward, and summing counted them twice.
    // The same figure the receipt text now quotes.
    balance: Number(netOutstanding(student.invoices, student.payments)),
  }));

  const owing = options.filter((option) => option.balance > 0).length;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader title="Payments" subtitle={`${data.count} recorded`} />

      {/* Reconciliation and the weekly breakdown live one click from the
          payments list, because they are the same person's job on the same
          afternoon. */}
      <div className="flex flex-wrap justify-end gap-x-4 gap-y-1 print:hidden">
        <Link href="/payments/collections" className="text-sm text-slate-500 hover:text-slate-900">
          Weekly collections →
        </Link>
        <Link href="/payments/reconcile" className="text-sm text-slate-500 hover:text-slate-900">
          Reconcile a statement →
        </Link>
      </div>

      {receipt ? (
        <Alert tone="success">
          Payment recorded. Receipt number{" "}
          <span className="font-mono font-semibold">{receipt}</span> — give this
          to the parent.
          {textLine?.tone === "ok" ? <> {textLine.text}</> : null}
        </Alert>
      ) : null}
      {textLine?.tone === "warn" ? (
        <p className="rounded-control border border-hairline bg-warning-tint px-3.5 py-2.5 text-sm text-warning-ink">
          {textLine.text}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Total received"
          value={formatCedis(data.total)}
          icon={Banknote}
          severity="done"
        />
        <StatCard label="Payments" value={String(data.count)} icon={Banknote} />
        <StatCard
          label="Students owing"
          value={String(owing)}
          icon={CircleAlert}
          severity={owing > 0 ? "blocking" : "done"}
        />
        <StatCard
          label="Students on roll"
          value={String(options.length)}
          icon={Users}
        />
      </div>

      <RecordForm students={options} />

      <form className="flex flex-wrap items-end gap-2 rounded-card border border-hairline bg-surface p-3">
        <input
          type="search"
          name="q"
          defaultValue={q ?? ""}
          placeholder="Receipt no., reference or student"
          className={`${filterClass} w-64`}
        />
        <select
          name="method"
          defaultValue={method ?? ""}
          className={`${filterClass} w-auto`}
        >
          <option value="">Any method</option>
          <option value="CASH">Cash</option>
          <option value="MOBILE_MONEY">Mobile money</option>
          <option value="BANK_DEPOSIT">Bank deposit</option>
          <option value="BANK_TRANSFER">Bank transfer</option>
          <option value="CHEQUE">Cheque</option>
        </select>
        <button
          type="submit"
          className={buttonClass("secondary")}
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
          <DataTable
            columns={COLUMNS}
            empty={{
              icon: Banknote,
              title: "No payments recorded for these filters yet.",
              action: undefined,
            }}
          >
            {data.payments.map((payment) => (
              <Row key={payment.id}>
                <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-slate-900">
                  {/* The receipt number IS the link to the receipt. It was
                      printed here as plain text while there was no document to
                      open — the number existed, the paper did not. */}
                  <Link
                    href={`/payments/receipt?one=${payment.id}`}
                    className="hover:underline"
                    title="Print this receipt"
                  >
                    {payment.receiptNo}
                  </Link>
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
                  {paymentSource(payment.method, payment.momoNetwork)}
                  {payment.momoNetwork ? ` (${payment.momoNetwork})` : ""}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-slate-500">
                  {payment.allocations.length === 0
                    ? "unallocated"
                    : payment.allocations
                        .map((a) => a.invoice.invoiceNo)
                        .join(", ")}
                  {payment.bankSlipUrl ? (
                    <a
                      href={payment.bankSlipUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-2 hover:underline"
                      title="View the attached slip"
                    >
                      📎
                    </a>
                  ) : null}
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
                      <input
                        type="hidden"
                        name="paymentId"
                        value={payment.id}
                      />
                      <input
                        type="hidden"
                        name="reason"
                        value="Reversed by bursar"
                      />
                      <SubmitButton variant="danger" pendingLabel="Reversing…">
                        Reverse
                      </SubmitButton>
                    </form>
                  ) : null}
                </td>
              </Row>
            ))}
          </DataTable>
        </div>
      </Card>
    </div>
  );
}
