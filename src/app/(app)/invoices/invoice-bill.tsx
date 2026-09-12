import { formatCedis } from "@/lib/money";
import { isOverdue } from "@/lib/invoice-engine";
import type { BillInvoice, BillSchool } from "@/lib/invoice-data";

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

const TERM_NAME: Record<string, string> = { FIRST: "First", SECOND: "Second", THIRD: "Third" };

/** The school's address as one line, skipping whatever it has not filled in. */
function addressLine(school: BillSchool) {
  return [school.address, school.town, school.district, school.region]
    .filter(Boolean)
    .join(", ");
}

function contactLine(school: BillSchool) {
  return [school.phone, school.altPhone, school.email, school.website].filter(Boolean).join(" · ");
}

/**
 * One fee invoice, laid out to fill a single A4 sheet and to survive being
 * handed to a parent.
 *
 * Shared by the invoice's own page and the whole-class print run, from the same
 * data — the report card learnt this lesson first. `breakAfter` puts each bill
 * on its own sheet when a class is printed together.
 *
 * What is on it beyond the screen version: the school's address and contact
 * details, how to pay, and a tear-off stub the parent brings back. A bill a
 * parent cannot act on is a letter, not a bill.
 */
export function InvoiceBill({
  school,
  invoice,
  breakAfter = false,
}: {
  school: BillSchool;
  invoice: BillInvoice;
  breakAfter?: boolean;
}) {
  const guardian = invoice.student.guardians[0]?.guardian;
  const address = addressLine(school);
  const contact = contactLine(school);
  const balance = Number(invoice.balance);
  // The bill was already deriving this correctly at read time while the status
  // column beside it went stale. Same expression, now the one shared rule.
  const overdue = isOverdue(invoice);

  return (
    <article
      className={`paper rounded-xl border border-slate-200 bg-white p-6 text-slate-900 print:rounded-none print:border-0 print:p-0 ${
        breakAfter ? "print:break-after-page" : ""
      }`}
    >
      <header className="flex items-center gap-4 border-b-2 border-brand-800 pb-3 text-center">
        {school.crestUrl ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={school.crestUrl} alt="" className="h-14 w-14 shrink-0 object-contain" />
          </>
        ) : null}
        <div className="min-w-0 flex-1">
        <h1 className="font-display text-2xl">{school.name}</h1>
        {school.motto ? (
          <p className="font-display text-xs italic text-accent-600">{school.motto}</p>
        ) : null}
        {address ? <p className="mt-1 text-xs text-slate-600">{address}</p> : null}
        {contact ? <p className="text-xs text-slate-600">{contact}</p> : null}
        {school.gpsAddress ? (
          <p className="text-xs text-slate-500">GPS: {school.gpsAddress}</p>
        ) : null}
        </div>
        {school.crestUrl ? <div className="h-14 w-14 shrink-0" /> : null}
      </header>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.14em] text-brand-800">Fee Invoice</p>
          <p className="text-xs text-slate-600">
            {TERM_NAME[invoice.term.name] ?? invoice.term.name} Term ·{" "}
            {invoice.term.academicYear.name}
          </p>
        </div>
        <div className="text-right text-xs">
          <p className="font-mono text-sm font-semibold">{invoice.invoiceNo}</p>
          <p className="text-slate-600">Issued {dateFmt.format(invoice.issueDate)}</p>
          {invoice.dueDate ? (
            <p className={overdue ? "font-semibold text-red-700" : "text-slate-600"}>
              Due {dateFmt.format(invoice.dueDate)}
              {overdue ? " — overdue" : ""}
            </p>
          ) : null}
          {invoice.status === "CANCELLED" ? (
            <p className="mt-0.5 font-semibold uppercase text-red-700">Cancelled</p>
          ) : null}
        </div>
      </div>

      <dl className="grid gap-x-6 gap-y-1 border-b border-slate-200 py-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Student</dt>
          <dd className="font-medium">
            {invoice.student.firstName} {invoice.student.lastName}
          </dd>
          <dd className="text-xs text-slate-600">
            {invoice.student.admissionNo}
            {invoice.student.currentClassGroup
              ? ` · ${invoice.student.currentClassGroup.level.name} ${invoice.student.currentClassGroup.name}`
              : ""}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Bill to</dt>
          {guardian ? (
            <>
              <dd className="font-medium">
                {guardian.firstName} {guardian.lastName}
              </dd>
              <dd className="text-xs text-slate-600">{guardian.phone}</dd>
            </>
          ) : (
            <dd className="text-xs text-slate-500">
              No guardian is marked to receive bills for this student.
            </dd>
          )}
        </div>
      </dl>

      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="border-b border-slate-300 text-xs uppercase tracking-wide text-slate-600">
            <th className="pb-1.5 text-left font-medium">Item</th>
            <th className="pb-1.5 text-right font-medium">Amount</th>
            <th className="pb-1.5 text-right font-medium">Discount</th>
            <th className="pb-1.5 text-right font-medium">Payable</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {invoice.items.map((item) => (
            <tr key={item.id}>
              <td className="py-1.5">{item.description}</td>
              <td className="py-1.5 text-right tabular-nums text-slate-600">
                {formatCedis(item.amount)}
              </td>
              <td className="py-1.5 text-right tabular-nums text-slate-500">
                {Number(item.discount) > 0 ? `−${formatCedis(item.discount)}` : "—"}
              </td>
              <td className="py-1.5 text-right font-medium tabular-nums">
                {formatCedis(Number(item.amount) - Number(item.discount))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="mt-3 ml-auto max-w-xs space-y-1 border-t-2 border-brand-800 pt-2 text-sm">
        <div className="flex justify-between">
          <dt className="text-slate-600">Subtotal</dt>
          <dd className="tabular-nums">{formatCedis(invoice.subtotal)}</dd>
        </div>
        {Number(invoice.discountTotal) > 0 ? (
          <div className="flex justify-between">
            <dt className="text-slate-600">Less discounts</dt>
            <dd className="tabular-nums">−{formatCedis(invoice.discountTotal)}</dd>
          </div>
        ) : null}
        {Number(invoice.broughtForward) > 0 ? (
          <div className="flex justify-between">
            <dt className="text-slate-600">Arrears brought forward</dt>
            <dd className="tabular-nums">{formatCedis(invoice.broughtForward)}</dd>
          </div>
        ) : null}
        <div className="flex justify-between border-t border-slate-300 pt-1">
          <dt className="font-medium">Total payable</dt>
          <dd className="font-semibold tabular-nums">{formatCedis(invoice.total)}</dd>
        </div>
        {Number(invoice.amountPaid) > 0 ? (
          <div className="flex justify-between">
            <dt className="text-slate-600">Paid to date</dt>
            <dd className="tabular-nums">−{formatCedis(invoice.amountPaid)}</dd>
          </div>
        ) : null}
        <div className="flex justify-between border-t-2 border-brand-800 pt-1">
          <dt className="text-base font-semibold">Balance due</dt>
          <dd className="text-base font-bold tabular-nums">{formatCedis(invoice.balance)}</dd>
        </div>
      </dl>

      {balance <= 0 && invoice.status !== "CANCELLED" ? (
        <p className="mt-2 text-right text-sm font-semibold uppercase tracking-wide text-green-700">
          Paid in full — thank you
        </p>
      ) : null}

      {school.settings?.paymentInstructions ? (
        <section className="mt-4 rounded-lg border border-slate-300 p-3 print:rounded-none">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
            How to pay
          </h2>
          <p className="mt-1 whitespace-pre-line text-sm">
            {school.settings.paymentInstructions}
          </p>
        </section>
      ) : null}

      {school.settings?.invoiceNote ? (
        <p className="mt-3 text-xs text-slate-600">{school.settings.invoiceNote}</p>
      ) : null}

      <div className="mt-5 flex items-end justify-between gap-6 text-xs text-slate-600">
        <div>
          <div className="h-8 w-44 border-b border-slate-400" />
          <p className="mt-1">{school.headName ?? "Headteacher"}</p>
        </div>
        <div className="text-right">
          <div className="h-8 w-44 border-b border-slate-400" />
          <p className="mt-1">Bursar / Accounts</p>
        </div>
      </div>

      {/* The counterfoil: a parent paying at the school window hands this back,
          so the bursar has the invoice number without hunting for the child. */}
      <div className="mt-5 border-t border-dashed border-slate-400 pt-3 text-xs">
        <p className="text-[10px] uppercase tracking-wide text-slate-500">
          Detach and return with payment
        </p>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <p>
            <span className="font-semibold">{invoice.invoiceNo}</span> ·{" "}
            {invoice.student.firstName} {invoice.student.lastName} ·{" "}
            {invoice.student.admissionNo}
            {invoice.student.currentClassGroup
              ? ` · ${invoice.student.currentClassGroup.level.name} ${invoice.student.currentClassGroup.name}`
              : ""}
          </p>
          <p>
            Balance due{" "}
            <span className="font-semibold tabular-nums">{formatCedis(invoice.balance)}</span>
          </p>
          <p className="text-slate-500">Amount paid: ………………… Date: …………………</p>
        </div>
      </div>
    </article>
  );
}
