import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { FINANCE } from "@/lib/permissions";
import { getReceipt, getReceiptsForTerm } from "@/lib/payment-data";
import { getBillSchool } from "@/lib/invoice-data";
import { prisma } from "@/lib/prisma";
import { formatCedis } from "@/lib/money";
import { PaymentReceipt } from "../payment-receipt";

export const metadata: Metadata = { title: "Print receipts · School OS" };

const TERM_NAME: Record<string, string> = { FIRST: "First", SECOND: "Second", THIRD: "Third" };

/**
 * Receipts, printed.
 *
 * `one=<paymentId>` prints a single one; a term prints the lot. Same layout
 * either way, deliberately — the sheet a parent gets must not depend on which
 * route the office reached it by, which is the lesson the bill and the report
 * card both learnt first.
 *
 * `day=YYYY-MM-DD` is the one a bursar actually uses: the receipts written
 * today, printed at close of business against the cash in the drawer.
 */
export default async function PrintReceiptsPage({ searchParams }: PageProps<"/payments/receipt">) {
  const auth = await requireRole(FINANCE);
  const query = await searchParams;

  const onlyId = typeof query.one === "string" ? query.one : "";
  const termId = typeof query.term === "string" ? query.term : "";
  const dayRaw = typeof query.day === "string" ? query.day : "";

  if (!onlyId && !termId) {
    notFound();
  }

  const school = await getBillSchool(auth.schoolId);
  if (!school) {
    notFound();
  }

  const day = dayRaw && !Number.isNaN(Date.parse(dayRaw)) ? new Date(dayRaw) : undefined;

  const receipts = onlyId
    ? await getReceipt(onlyId).then((one) => (one ? [one] : []))
    : await getReceiptsForTerm(termId, { day });

  if (receipts.length === 0) {
    notFound();
  }

  const term = termId
    ? await prisma.term.findUnique({
        where: { id: termId },
        select: { name: true, academicYear: { select: { name: true } } },
      })
    : null;

  const taken = receipts.reduce((sum, receipt) => sum + Number(receipt.amount), 0);
  const heading = onlyId
    ? `Receipt ${receipts[0].receiptNo}`
    : `${receipts.length} receipt${receipts.length === 1 ? "" : "s"}`;
  const context = term ? `${TERM_NAME[term.name] ?? term.name} Term · ${term.academicYear.name}` : "";

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div>
          <Link href="/payments" className="text-sm text-slate-500 hover:text-slate-900">
            ← Payments
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">{heading}</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {[context, `${formatCedis(taken)} received`].filter(Boolean).join(" · ")}. Two to a
            sheet — use your browser&rsquo;s print dialog.
          </p>
        </div>
      </div>

      {/* Two to a sheet. A receipt is not a letter, and a school printing forty
          on a termly deadline should not spend forty sheets. */}
      <div className="space-y-4 print:space-y-0">
        {receipts.map((receipt) => (
          <PaymentReceipt
            key={receipt.id}
            school={school}
            payment={receipt}
            printedBy={auth.name}
            breakAfter={Boolean(onlyId)}
          />
        ))}
      </div>
    </div>
  );
}
