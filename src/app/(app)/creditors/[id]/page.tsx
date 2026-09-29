import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { canAccess, FINANCE, LEADERSHIP } from "@/lib/permissions";
import { getVendorDetail, getActiveVendors, getBillCategories } from "@/lib/vendor-data";
import { formatCedis } from "@/lib/money";
import { paymentMethodLabel } from "@/lib/payment-labels";
import { approveVendorBill, cancelVendorBill, reverseVendorPayment } from "@/lib/vendor-actions";
import { PageHeader, Card, StatusBadge } from "../../ui";
import { SubmitButton } from "../../submit-button";
import { BillForm } from "../bill-form";
import { PaymentForm } from "../payment-form";

export const metadata: Metadata = { title: "Vendor · School OS" };

export default async function VendorDetailPage({
  params,
}: PageProps<"/creditors/[id]">) {
  const auth = await requireRole(FINANCE);
  const { id } = await params;
  const [vendor, activeVendors, categories] = await Promise.all([
    getVendorDetail(id),
    getActiveVendors(),
    getBillCategories(),
  ]);

  if (!vendor) {
    notFound();
  }

  const mayApprove = canAccess(auth.roles, LEADERSHIP);
  const owed = vendor.bills.reduce((sum, b) => sum + Number(b.balance), 0);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title={vendor.name}
        subtitle={[vendor.contactPerson, vendor.phone].filter(Boolean).join(" · ") || "No contact on file"}
        action={
          <div className="flex flex-wrap gap-2">
            <BillForm vendors={activeVendors} categories={categories} defaultVendorId={vendor.id} />
            <PaymentForm vendors={activeVendors} defaultVendorId={vendor.id} />
          </div>
        }
      />

      <Card title={`Owed: ${formatCedis(owed)}`}>
        <ul>
          {vendor.bills.length === 0 ? (
            <li className="px-4 py-6 text-center text-sm text-slate-500">No bills recorded yet.</li>
          ) : null}
          {vendor.bills.map((bill) => (
            <li key={bill.id} className="flex flex-wrap items-center gap-3 border-t border-slate-100 p-4">
              <div className="flex-1">
                <p className="font-mono text-xs text-slate-400">{bill.billNo}</p>
                <p className="font-medium text-slate-900">{bill.description}</p>
                <p className="text-xs text-slate-500">
                  {bill.category?.name ?? "Uncategorised"}
                  {bill.dueDate ? ` · due ${bill.dueDate.toLocaleDateString()}` : ""}
                </p>
              </div>
              <div className="text-right">
                <p className="font-medium tabular-nums text-slate-900">{formatCedis(bill.amount)}</p>
                {Number(bill.balance) > 0 ? (
                  <p className="text-xs font-medium tabular-nums text-danger-ink">
                    {formatCedis(bill.balance)} owed
                  </p>
                ) : null}
              </div>
              <StatusBadge status={bill.status} />
              {bill.status === "DRAFT" && mayApprove ? (
                <form action={approveVendorBill}>
                  <input type="hidden" name="vendorBillId" value={bill.id} />
                  <SubmitButton variant="secondary" pendingLabel="…">
                    Approve
                  </SubmitButton>
                </form>
              ) : null}
              {bill.status !== "CANCELLED" && Number(bill.amountPaid) === 0 ? (
                <form action={cancelVendorBill}>
                  <input type="hidden" name="vendorBillId" value={bill.id} />
                  <SubmitButton variant="danger" pendingLabel="…">
                    Cancel
                  </SubmitButton>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Payments">
        <ul>
          {vendor.payments.length === 0 ? (
            <li className="px-4 py-6 text-center text-sm text-slate-500">No payments recorded yet.</li>
          ) : null}
          {vendor.payments.map((payment) => (
            <li key={payment.id} className="flex flex-wrap items-center gap-3 border-t border-slate-100 p-4">
              <div className="flex-1">
                <p className="font-mono text-xs text-slate-400">{payment.paymentNo}</p>
                <p className="text-sm text-slate-700">
                  {paymentMethodLabel(payment.method)} · {payment.paidAt.toLocaleDateString()}
                </p>
                <p className="text-xs text-slate-500">
                  Against{" "}
                  {payment.allocations.map((a) => a.vendorBill.billNo).join(", ") || "no bill (unallocated)"}
                </p>
              </div>
              <p
                className={`font-medium tabular-nums ${
                  payment.reversedAt ? "text-slate-400 line-through" : "text-success-ink"
                }`}
              >
                {formatCedis(payment.amount)}
              </p>
              {payment.reversedAt ? (
                <StatusBadge status="REVERSED" />
              ) : (
                <form action={reverseVendorPayment}>
                  <input type="hidden" name="vendorPaymentId" value={payment.id} />
                  <SubmitButton variant="danger" pendingLabel="…">
                    Reverse
                  </SubmitButton>
                </form>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
