import { formatCedis, cedisInWords } from "@/lib/money";
import { paymentSource } from "@/lib/payment-labels";
import type { ReceiptPayment } from "@/lib/payment-data";
import type { BillSchool } from "@/lib/invoice-data";

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

const TERM_NAME: Record<string, string> = { FIRST: "First", SECOND: "Second", THIRD: "Third" };

function addressLine(school: BillSchool) {
  return [school.address, school.town, school.district, school.region].filter(Boolean).join(", ");
}

function contactLine(school: BillSchool) {
  return [school.phone, school.altPhone, school.email].filter(Boolean).join(" · ");
}

/**
 * The paper a parent walks away with.
 *
 * This is the document the system was missing: receipt numbers were minted,
 * listed and texted, and there was nothing to hand across the counter. A parent
 * paying ₵500 in cash at the bursar's window expects paper, and the carbon book
 * it replaces gives them one.
 *
 * Deliberately half an A4 sheet, two to a page. A receipt is not a letter, and
 * a school printing forty of them on a termly deadline should not spend forty
 * sheets. `breakAfter` puts each on its own sheet only when printed alone.
 */
export function PaymentReceipt({
  school,
  payment,
  breakAfter = false,
}: {
  school: BillSchool;
  payment: ReceiptPayment;
  breakAfter?: boolean;
}) {
  const address = addressLine(school);
  const contact = contactLine(school);
  const payer = payment.guardian ?? payment.student.guardians[0]?.guardian ?? null;
  const klass = payment.student.currentClassGroup;

  // What this money settled, and what is still owed on those bills afterwards.
  // Read back rather than recomputed — recalcInvoice has already settled them,
  // and a receipt disagreeing with the ledger is worse than one saying nothing.
  const settled = payment.allocations;
  const stillOwing = settled.reduce((total, row) => total + Number(row.invoice.balance), 0);
  const unallocated = Number(payment.amount) - settled.reduce((t, r) => t + Number(r.amount), 0);

  return (
    <article
      className={`paper rounded-xl border border-slate-200 bg-white p-6 text-slate-900 print:rounded-none print:border-0 print:p-0 ${
        breakAfter ? "print:break-after-page" : ""
      }`}
    >
      <header className="flex items-center gap-4 border-b-2 border-brand-800 pb-3">
        {school.crestUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={school.crestUrl} alt="" className="h-14 w-14 shrink-0 object-contain" />
        ) : null}
        <div className="min-w-0 flex-1 text-center">
          <h1 className="font-display text-xl font-bold leading-tight text-brand-800">
            {school.name}
          </h1>
          {address ? <p className="text-[11px] text-slate-600">{address}</p> : null}
          {contact ? <p className="text-[11px] text-slate-600">{contact}</p> : null}
        </div>
      </header>

      <div className="mt-3 flex items-baseline justify-between">
        <h2 className="font-display text-base font-bold uppercase tracking-wide">
          Payment receipt
        </h2>
        <dl className="text-right text-xs">
          <div className="flex gap-2">
            <dt className="text-slate-500">No.</dt>
            <dd className="font-mono font-semibold">{payment.receiptNo}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-slate-500">Date</dt>
            <dd>{dateFmt.format(payment.paidAt)}</dd>
          </div>
        </dl>
      </div>

      {payment.status === "REVERSED" ? (
        /* A reversed payment must never read as valid paper. It is printed at
           all only because a school reconciling its book needs to see what was
           voided and why. */
        <p className="mt-2 rounded border border-danger-ink/30 bg-danger-tint px-2 py-1 text-xs font-semibold text-danger-ink">
          REVERSED{payment.reversalReason ? ` — ${payment.reversalReason}` : ""}. This receipt is
          void.
        </p>
      ) : null}

      <dl className="mt-3 space-y-1.5 text-sm">
        <div className="flex gap-2">
          <dt className="w-28 shrink-0 text-slate-500">Received from</dt>
          <dd className="font-medium">
            {payer ? `${payer.firstName} ${payer.lastName}` : "—"}
            {payer?.phone ? <span className="text-slate-500"> · {payer.phone}</span> : null}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-28 shrink-0 text-slate-500">On behalf of</dt>
          <dd className="font-medium">
            {payment.student.firstName} {payment.student.lastName}
            <span className="text-slate-500">
              {" · "}
              {klass ? `${klass.level.name} ${klass.name}` : "no class"}
              {" · "}
              {payment.student.admissionNo}
            </span>
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-28 shrink-0 text-slate-500">Being payment of</dt>
          <dd>
            {settled.length > 0
              ? settled
                  .map(
                    (row) =>
                      `${TERM_NAME[row.invoice.term.name] ?? row.invoice.term.name} Term ` +
                      `${row.invoice.term.academicYear.name} (${row.invoice.invoiceNo})`,
                  )
                  .join(", ")
              : "school fees"}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-28 shrink-0 text-slate-500">Method</dt>
          <dd>
            {/* paymentSource, not method + network by hand — that is the drift
                payment-labels.ts exists to stop, and doing it here printed the
                raw enum TELECEL on the first render of this receipt. */}
            {paymentSource(payment.method, payment.momoNetwork)}
            {payment.reference ? ` · ${payment.reference}` : ""}
          </dd>
        </div>
      </dl>

      <div className="mt-3 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs uppercase tracking-wide text-slate-500">Amount paid</span>
          <span className="font-display text-xl font-bold tabular-nums">
            {formatCedis(payment.amount)}
          </span>
        </div>
        {/* The figure in words, which is the half a carbon book has and a
            database print-out usually forgets. See cedisInWords. */}
        <p className="mt-0.5 border-t border-slate-200 pt-1 text-[11px] italic text-slate-600">
          {cedisInWords(payment.amount)}
        </p>
      </div>

      <dl className="mt-2 space-y-0.5 text-xs">
        {unallocated > 0.005 ? (
          /* An overpayment is a credit the school owes back in service. Saying
             so on the paper is what stops it being quietly absorbed. */
          <div className="flex justify-between">
            <dt className="text-slate-500">Carried as credit</dt>
            <dd className="font-semibold tabular-nums">{formatCedis(unallocated)}</dd>
          </div>
        ) : null}
        <div className="flex justify-between">
          <dt className="text-slate-500">Balance still owing on these bills</dt>
          <dd className="font-semibold tabular-nums">{formatCedis(stillOwing)}</dd>
        </div>
      </dl>

      <footer className="mt-5 flex items-end justify-between gap-6">
        <div className="text-[11px] text-slate-500">
          <p>Received by {payment.recordedBy?.name ?? "the school office"}</p>
          <p className="mt-0.5">Keep this receipt. It is your proof of payment.</p>
        </div>
        <div className="w-40 shrink-0 text-center">
          <div className="h-8 border-b border-slate-400" />
          <p className="mt-1 text-[11px] text-slate-500">Signature &amp; school stamp</p>
        </div>
      </footer>
    </article>
  );
}
