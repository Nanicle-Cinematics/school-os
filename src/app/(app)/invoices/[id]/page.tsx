import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { paymentSource } from "@/lib/payment-labels";
import { requireRole } from "@/lib/auth";
import { FINANCE } from "@/lib/permissions";
import { getBillSchool, getInvoice } from "@/lib/invoice-data";
import { cancelInvoice } from "@/lib/invoice-actions";
import { formatCedis } from "@/lib/money";
import { Card } from "../../ui";
import { SubmitButton } from "../../submit-button";
import { InvoiceBill } from "../invoice-bill";

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

  const payments = invoice.allocations.filter((a) => a.payment.status === "CONFIRMED");
  const school = await getBillSchool(auth.schoolId);
  if (!school) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between print:hidden">
        <Link href="/invoices" className="text-sm text-slate-500 hover:text-slate-900">
          ← All invoices
        </Link>
        <div className="flex items-center gap-2">
          <Link
            href={`/invoices/print?term=${invoice.termId}&one=${invoice.id}`}
            className="rounded-xl border border-slate-200 bg-surface px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Print bill
          </Link>
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

      <InvoiceBill school={school} invoice={invoice} />

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
                    {paymentSource(allocation.payment.method, allocation.payment.momoNetwork)}
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
