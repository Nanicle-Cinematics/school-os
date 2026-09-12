import { notFound } from "next/navigation";
import { requireMyChild } from "@/lib/portal-auth";
import { paymentSource } from "@/lib/payment-labels";
import { getChildHeader, getChildFinance } from "@/lib/portal-data";
import { formatCedis } from "@/lib/money";
import { termLabel } from "@/lib/academic-year";
import { ChildHeader } from "../../child-header";

export const metadata = { title: "School fees · School OS" };

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export default async function ChildFeesPage({ params }: PageProps<"/portal/[studentId]/fees">) {
  const { studentId } = await params;
  await requireMyChild(studentId);

  const child = await getChildHeader(studentId);
  if (!child) notFound();

  const { invoices, payments, outstanding, paidTotal } = await getChildFinance(studentId);
  const owing = Number(outstanding) > 0;

  return (
    <div className="space-y-6">
      <ChildHeader child={child} />

      <div className="rounded-card border border-hairline bg-surface shadow-card p-5">
        <p className="text-sm font-semibold text-slate-600">Outstanding</p>
        <p
          className={`mt-1 text-3xl font-extrabold tabular-nums ${
            owing ? "text-accent-700" : "text-brand-ink"
          }`}
        >
          {owing ? formatCedis(outstanding) : "Paid up"}
        </p>
        <p className="mt-1 text-sm text-slate-500">
          {payments.length === 0
            ? "No payments received yet."
            : `${formatCedis(paidTotal)} received across ${payments.length} receipt${
                payments.length === 1 ? "" : "s"
              }`}
        </p>
      </div>

      <section>
        <h2 className="font-heading text-lg font-extrabold tracking-tight text-slate-900">Bills</h2>
        {invoices.length === 0 ? (
          <p className="mt-2 rounded-card border border-hairline bg-surface shadow-card p-5 text-sm text-slate-600">
            No bills have been issued yet.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {invoices.map((inv) => (
              <li key={inv.id} className="rounded-card border border-hairline bg-surface shadow-card p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="font-bold text-slate-900">
                    {termLabel(inv.term.name)} Term · {inv.term.academicYear.name}
                  </p>
                  <p
                    className={`shrink-0 font-bold tabular-nums ${
                      Number(inv.balance) > 0 ? "text-accent-700" : "text-brand-ink"
                    }`}
                  >
                    {Number(inv.balance) > 0 ? formatCedis(inv.balance) : "Settled"}
                  </p>
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-slate-600 sm:grid-cols-4">
                  <div>
                    <dt className="text-xs text-slate-400">Bill</dt>
                    <dd className="tabular-nums">{inv.invoiceNo}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-400">Total</dt>
                    <dd className="tabular-nums">{formatCedis(inv.total)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-400">Paid</dt>
                    <dd className="tabular-nums">{formatCedis(inv.amountPaid)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-400">Due</dt>
                    <dd>{inv.dueDate ? dateFmt.format(inv.dueDate) : "—"}</dd>
                  </div>
                </dl>
                {Number(inv.broughtForward) > 0 ? (
                  // Arrears are folded into one number on the bill, so saying so
                  // is what stops a parent reading the total as this term alone.
                  <p className="mt-2 text-xs text-slate-500">
                    Includes {formatCedis(inv.broughtForward)} brought forward from earlier terms.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="font-heading text-lg font-extrabold tracking-tight text-slate-900">
          Receipts
        </h2>
        {payments.length === 0 ? (
          <p className="mt-2 rounded-card border border-hairline bg-surface shadow-card p-5 text-sm text-slate-600">
            No payments recorded yet. Payments appear here once the school records them.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100 overflow-hidden rounded-card border border-hairline bg-surface shadow-card">
            {payments.map((p) => (
              <li key={p.id} className="flex items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-slate-900">
                    {paymentSource(p.method, p.momoNetwork)}
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    {dateFmt.format(p.paidAt)} · Receipt {p.receiptNo}
                    {p.reference ? ` · ${p.reference}` : ""}
                  </p>
                </div>
                <p className="shrink-0 font-bold tabular-nums text-slate-900">
                  {formatCedis(p.amount)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
