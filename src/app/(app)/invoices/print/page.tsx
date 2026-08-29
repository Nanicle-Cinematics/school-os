import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { FINANCE } from "@/lib/permissions";
import { getBill, getBillSchool, getBillsForTerm } from "@/lib/invoice-data";
import { prisma } from "@/lib/prisma";
import { formatCedis } from "@/lib/money";
import { Alert } from "../../ui";
import { InvoiceBill } from "../invoice-bill";

export const metadata: Metadata = { title: "Print invoices · School OS" };

const TERM_NAME: Record<string, string> = { FIRST: "First", SECOND: "Second", THIRD: "Third" };

export default async function PrintInvoicesPage({ searchParams }: PageProps<"/invoices/print">) {
  const auth = await requireRole(FINANCE);
  const query = await searchParams;

  const termId = typeof query.term === "string" ? query.term : "";
  const classGroupId = typeof query.class === "string" ? query.class : "";
  const unpaidOnly = query.unpaid === "1";

  if (!termId) {
    notFound();
  }

  const term = await prisma.term.findUnique({
    where: { id: termId },
    select: { name: true, academicYear: { select: { name: true } } },
  });
  if (!term) {
    notFound();
  }

  const classGroup = classGroupId
    ? await prisma.classGroup.findUnique({
        where: { id: classGroupId },
        select: { name: true, level: { select: { name: true } } },
      })
    : null;
  if (classGroupId && !classGroup) {
    notFound();
  }

  const school = await getBillSchool(auth.schoolId);
  if (!school) {
    notFound();
  }

  // `one` prints a single bill through the same layout as the batch, so the
  // sheet a parent gets is identical whichever way the office reached it.
  const onlyId = typeof query.one === "string" ? query.one : "";
  const bills = onlyId
    ? await getBill(onlyId).then((bill) => (bill ? [bill] : []))
    : await getBillsForTerm(termId, {
        classGroupId: classGroupId || undefined,
        unpaidOnly,
      });

  const owed = bills.reduce((sum, bill) => sum + Number(bill.balance), 0);
  const label = onlyId
    ? (bills[0]
        ? `${bills[0].student.firstName} ${bills[0].student.lastName}`
        : "That invoice")
    : classGroup
      ? `${classGroup.level.name} ${classGroup.name}`
      : "Every class";
  const termLabel = `${TERM_NAME[term.name] ?? term.name} Term · ${term.academicYear.name}`;
  const back = `/invoices?term=${termId}${classGroupId ? `&class=${classGroupId}` : ""}`;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div>
          <Link href={back} className="text-sm text-slate-500 hover:text-slate-900">
            ← Invoices
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">
            {onlyId ? label : `${label} · ${bills.length} bill${bills.length === 1 ? "" : "s"}`}
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {termLabel} · one sheet each, {formatCedis(owed)} outstanding. Use your browser&rsquo;s
            print dialog.
          </p>
        </div>

        {onlyId ? null : (
          <Link
            href={`/invoices/print?term=${termId}${classGroupId ? `&class=${classGroupId}` : ""}${
              unpaidOnly ? "" : "&unpaid=1"
            }`}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            {unpaidOnly ? "Include settled bills" : "Only those still owing"}
          </Link>
        )}
      </div>

      {!school.settings?.paymentInstructions ? (
        <div className="print:hidden">
          <Alert tone="error">
            These bills say nothing about how to pay. Add momo or bank details under Settings →
            Fees policy and they will print on every invoice.
          </Alert>
        </div>
      ) : null}

      {bills.length === 0 ? (
        <div className="print:hidden">
          <Alert tone="error">
            Nothing to print for {label} this term
            {unpaidOnly ? " — every bill is settled" : ". Generate invoices first"}.
          </Alert>
        </div>
      ) : null}

      {bills.map((invoice, index) => (
        <InvoiceBill
          key={invoice.id}
          school={school}
          invoice={invoice}
          breakAfter={index < bills.length - 1}
        />
      ))}
    </div>
  );
}
