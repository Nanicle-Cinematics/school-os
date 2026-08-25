import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { FINANCE } from "@/lib/permissions";
import { getInvoice } from "@/lib/invoice-data";
import { cancelInvoice } from "@/lib/invoice-actions";
import { formatCedis } from "@/lib/money";
import { Card, StatusBadge } from "../../ui";
import { SubmitButton } from "../../submit-button";

export const metadata: Metadata = { title: "Invoice · School OS" };

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export default async function InvoiceDetailPage({ params }: PageProps<"/invoices/[id]">) {
  const auth = await requireRole(FINANCE);
  const { id } = await params;
  const invoice = await getInvoice(id);

  if (!invoice) {
    notFound();
  }

  const guardian = invoice.student.guardians[0]?.guardian;
  const payments = invoice.allocations.filter((a) => a.payment.status === "CONFIRMED");

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between print:hidden">
        <Link href="/invoices" className="text-sm text-slate-500 hover:text-slate-900">
          ← All invoices
        </Link>
        <div className="flex items-center gap-2">
          {invoice.allocations.length === 0 && invoice.status !== "CANCELLED" ? (
            <form action={cancelInvoice}>
              <input type="hidden" name="invoiceId" value={invoice.id} />
              <SubmitButton variant="danger" pendingLabel="Cancelling…">
                Cancel invoice
              </SubmitButton>
            </form>
          ) : null}
        </div>
      </div>

      <Card>
        <div className="p-6">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-5">
            <div>
              <h1 className="text-lg font-semibold text-slate-900">{auth.schoolName}</h1>
              <p className="mt-0.5 text-sm text-slate-500">
                Fee invoice · Term {invoice.term.sequence} · {invoice.term.academicYear.name}
              </p>
            </div>
            <div className="text-right">
              <p className="font-mono text-sm font-semibold text-slate-900">{invoice.invoiceNo}</p>
              <p className="mt-0.5 text-xs text-slate-500">
                Issued {dateFmt.format(invoice.issueDate)}
              </p>
              {invoice.dueDate ? (
                <p className="text-xs text-slate-500">Due {dateFmt.format(invoice.dueDate)}</p>
              ) : null}
              <div className="mt-1.5">
                <StatusBadge status={invoice.status} />
              </div>
            </div>
          </div>

          <div className="grid gap-4 border-b border-slate-100 py-5 sm:grid-cols-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Student</p>
              <p className="mt-1 text-sm font-medium text-slate-900">
                {invoice.student.firstName} {invoice.student.lastName}
              </p>
              <p className="text-xs text-slate-500">
                {invoice.student.admissionNo}
                {invoice.student.currentClassGroup
                  ? ` · ${invoice.student.currentClassGroup.level.name} ${invoice.student.currentClassGroup.name}`
                  : ""}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Bill to</p>
              {guardian ? (
                <>
                  <p className="mt-1 text-sm font-medium text-slate-900">
                    {guardian.firstName} {guardian.lastName}
                  </p>
                  <p className="text-xs text-slate-500">{guardian.phone}</p>
                </>
              ) : (
                <p className="mt-1 text-sm text-amber-600">No guardian marked to receive bills</p>
              )}
            </div>
          </div>

          <table className="mt-5 w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-500">
                <th className="pb-2 text-left font-medium">Item</th>
                <th className="pb-2 text-right font-medium">Amount</th>
                <th className="pb-2 text-right font-medium">Discount</th>
                <th className="pb-2 text-right font-medium">Payable</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {invoice.items.map((item) => (
                <tr key={item.id}>
                  <td className="py-2 text-slate-700">{item.description}</td>
                  <td className="py-2 text-right tabular-nums text-slate-600">
                    {formatCedis(item.amount)}
                  </td>
                  <td className="py-2 text-right tabular-nums text-slate-400">
                    {Number(item.discount) > 0 ? `−${formatCedis(item.discount)}` : "—"}
                  </td>
                  <td className="py-2 text-right font-medium tabular-nums text-slate-900">
                    {formatCedis(Number(item.amount) - Number(item.discount))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <dl className="mt-5 space-y-1.5 border-t border-slate-100 pt-4 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">Subtotal</dt>
              <dd className="tabular-nums text-slate-700">{formatCedis(invoice.subtotal)}</dd>
            </div>
            {Number(invoice.discountTotal) > 0 ? (
              <div className="flex justify-between">
                <dt className="text-slate-500">Discounts</dt>
                <dd className="tabular-nums text-slate-700">
                  −{formatCedis(invoice.discountTotal)}
                </dd>
              </div>
            ) : null}
            {Number(invoice.broughtForward) > 0 ? (
              <div className="flex justify-between">
                <dt className="text-slate-500">Arrears brought forward</dt>
                <dd className="tabular-nums text-amber-700">
                  {formatCedis(invoice.broughtForward)}
                </dd>
              </div>
            ) : null}
            <div className="flex justify-between border-t border-slate-100 pt-1.5">
              <dt className="font-medium text-slate-900">Total payable</dt>
              <dd className="font-semibold tabular-nums text-slate-900">
                {formatCedis(invoice.total)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Paid</dt>
              <dd className="tabular-nums text-green-700">{formatCedis(invoice.amountPaid)}</dd>
            </div>
            <div className="flex justify-between border-t border-slate-100 pt-1.5">
              <dt className="font-medium text-slate-900">Balance</dt>
              <dd
                className={`text-base font-semibold tabular-nums ${
                  Number(invoice.balance) > 0 ? "text-red-600" : "text-green-700"
                }`}
              >
                {formatCedis(invoice.balance)}
              </dd>
            </div>
          </dl>
        </div>
      </Card>

      <Card title={`Payments (${payments.length})`}>
        {payments.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">
            Nothing received against this invoice yet.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {payments.map((allocation) => (
              <li key={allocation.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="font-mono text-xs text-slate-900">{allocation.payment.receiptNo}</p>
                  <p className="text-xs text-slate-500">
                    {dateFmt.format(allocation.payment.paidAt)} ·{" "}
                    {allocation.payment.method.replace(/_/g, " ").toLowerCase()}
                    {allocation.payment.reference ? ` · ${allocation.payment.reference}` : ""}
                  </p>
                </div>
                <span className="text-sm font-semibold tabular-nums text-green-700">
                  {formatCedis(allocation.amount)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
