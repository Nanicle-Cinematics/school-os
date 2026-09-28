import { Prisma } from "@prisma/client";
import { formatCedis } from "@/lib/money";
import type { BillSchool } from "@/lib/invoice-data";
import { paperWatermark, printedByLine } from "@/lib/paper";
import { BillLetterhead } from "../bill-letterhead";

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

const TERM_NAME: Record<string, string> = { FIRST: "First", SECOND: "Second", THIRD: "Third" };

export type ProformaLine = {
  description: string;
  amount: Prisma.Decimal;
  discount: Prisma.Decimal;
};

export type Proforma = {
  student: {
    firstName: string;
    lastName: string;
    admissionNo: string;
    className: string | null;
  };
  guardian: { firstName: string; lastName: string; phone: string } | null;
  lines: ProformaLine[];
  subtotal: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  broughtForward: Prisma.Decimal;
  total: Prisma.Decimal;
};

/**
 * An ADVANCE bill for a term that has not been invoiced yet.
 *
 * ⚠️ It is deliberately not dressed as an invoice, and the differences are the
 * point. It carries no invoice number, because none has been issued and a
 * number on a document is what an office files and chases. It shows no amount
 * paid, because nothing can have been paid against a bill that does not exist.
 * It says PRO-FORMA across the heading and repeats, in words, that the figures
 * are what the fees currently are rather than a demand.
 *
 * A parent who pays against this is paying in advance, which is exactly what a
 * Ghanaian school wants in the holidays — and the money lands as an unallocated
 * payment that FIFOs onto the real invoice the moment it is generated.
 *
 * The arithmetic comes from `priceFromStructure`, the same function the real
 * generator uses, so this can never quote a figure the invoice will contradict.
 */
export function ProformaBill({
  school,
  term,
  proforma,
  printedBy,
  breakAfter = false,
}: {
  school: BillSchool;
  term: { name: string; academicYear: { name: string }; startDate: Date };
  proforma: Proforma;
  printedBy: string;
  breakAfter?: boolean;
}) {
  const { student, guardian } = proforma;
  const payable = proforma.subtotal.sub(proforma.discountTotal);

  return (
    <article
      className={`paper rounded-xl border border-slate-200 bg-white p-6 text-slate-900 print:rounded-none print:border-0 print:p-0 ${
        breakAfter ? "print:break-after-page" : ""
      }`}
      style={paperWatermark(school.crestUrl)}
    >
      <BillLetterhead school={school} />

      <div className="mt-3 flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.14em] text-brand-800">
            Pro-forma · Advance Bill
          </p>
          <p className="text-xs text-slate-600">
            {TERM_NAME[term.name] ?? term.name} Term · {term.academicYear.name}
          </p>
        </div>
        <div className="text-right text-xs">
          <p className="font-semibold uppercase tracking-wide text-accent-700">Not yet invoiced</p>
          <p className="text-slate-600">Term begins {dateFmt.format(term.startDate)}</p>
        </div>
      </div>

      <dl className="grid gap-x-6 gap-y-1 border-b border-slate-200 py-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Student</dt>
          <dd className="font-medium">
            {student.firstName} {student.lastName}
          </dd>
          <dd className="text-xs text-slate-600">
            {student.admissionNo}
            {student.className ? ` · ${student.className}` : ""}
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
          {proforma.lines.map((line) => (
            <tr key={line.description}>
              <td className="py-1.5">{line.description}</td>
              <td className="py-1.5 text-right tabular-nums text-slate-600">
                {formatCedis(line.amount)}
              </td>
              <td className="py-1.5 text-right tabular-nums text-slate-600">
                {Number(line.discount) > 0 ? `−${formatCedis(line.discount)}` : "—"}
              </td>
              <td className="py-1.5 text-right tabular-nums font-medium">
                {formatCedis(line.amount.sub(line.discount))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-3 space-y-1 border-t border-slate-300 pt-3 text-sm">
        <Row label="Term fees" value={formatCedis(payable)} />
        {Number(proforma.broughtForward) > 0 ? (
          <Row
            label="Arrears brought forward"
            value={formatCedis(proforma.broughtForward)}
            hint="Still owing from the term just ended"
          />
        ) : null}
        <div className="flex items-baseline justify-between border-t border-slate-300 pt-2">
          <span className="text-sm font-semibold uppercase tracking-wide">Expected total</span>
          <span className="tabular-nums text-lg font-bold text-accent-700">
            {formatCedis(proforma.total)}
          </span>
        </div>
      </div>

      <p className="mt-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
        This is an estimate of what will be due, at the fees the school currently charges.
        It is not an invoice and no payment is overdue. Fees set or changed before the term
        begins will be reflected on the invoice itself.
      </p>

      {school.settings?.paymentInstructions ? (
        <div className="mt-3 border-t border-slate-200 pt-3">
          <p className="text-xs uppercase tracking-wide text-slate-500">How to pay</p>
          <p className="mt-1 whitespace-pre-line text-sm text-slate-700">
            {school.settings.paymentInstructions}
          </p>
        </div>
      ) : null}

      <p className="mt-3 text-[10px] text-slate-400">{printedByLine(printedBy)}</p>
    </article>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-slate-600">
        {label}
        {hint ? <span className="ml-2 text-xs text-slate-500">{hint}</span> : null}
      </span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
