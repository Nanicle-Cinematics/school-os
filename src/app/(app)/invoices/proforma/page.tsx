import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { FINANCE } from "@/lib/permissions";
import { getBillSchool, getProformaForTerm } from "@/lib/invoice-data";
import { groupSkipped } from "@/lib/invoice-engine";
import { formatCedis } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { Alert } from "../../ui";
import { PrintButton } from "../../print-button";
import { ProformaBill } from "../proforma-bill";

export const metadata: Metadata = { title: "Advance bills · School OS" };

const TERM_NAME: Record<string, string> = { FIRST: "First", SECOND: "Second", THIRD: "Third" };

/**
 * Bills for a term that has not started.
 *
 * School money arrives in the first weeks of term and thins out after, so a
 * parent who knows the figure in July can pay some of it in August. Until now
 * the office could only tell them what the term would cost by raising the
 * invoices early — which fixes the fees before they are decided and leaves
 * real, numbered, chaseable documents to cancel if anything changes.
 *
 * Nothing here writes. See `getProformaForTerm`.
 */
export default async function ProformaPage({ searchParams }: PageProps<"/invoices/proforma">) {
  const auth = await requireRole(FINANCE);
  const query = await searchParams;

  const termId = typeof query.term === "string" ? query.term : "";
  const classGroupId = typeof query.class === "string" ? query.class : "";
  if (!termId) {
    notFound();
  }

  const school = await getBillSchool(auth.schoolId);
  const data = await getProformaForTerm(termId, { classGroupId: classGroupId || undefined });
  if (!school || !data) {
    notFound();
  }

  const classGroup = classGroupId
    ? await prisma.classGroup.findUnique({
        where: { id: classGroupId },
        select: { name: true, level: { select: { name: true } } },
      })
    : null;

  /**
   * ⚠️ If the term HAS been invoiced, an advance bill is the wrong document —
   * it quotes an estimate beside a real invoice the parent may already hold,
   * with a different heading and no invoice number. Say so and point at the
   * real thing rather than printing a confusing duplicate.
   */
  const alreadyInvoiced = await prisma.invoice.count({
    where: { schoolId: auth.schoolId, termId, status: { not: "CANCELLED" } },
  });

  const { term, priced, skipped } = data;
  const expected = priced.reduce((sum, row) => sum + Number(row.total), 0);
  const arrears = priced.reduce((sum, row) => sum + Number(row.broughtForward), 0);
  const label = classGroup ? `${classGroup.level.name} ${classGroup.name}` : "Every class";
  const termLabel = `${TERM_NAME[term.name] ?? term.name} Term · ${term.academicYear.name}`;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div>
          <Link href="/invoices" className="text-sm text-slate-500 hover:text-slate-900">
            ← Invoices
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">
            {label} · {priced.length} advance bill{priced.length === 1 ? "" : "s"}
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {termLabel} · {formatCedis(expected)} expected
            {arrears > 0 ? `, including ${formatCedis(arrears)} brought forward` : ""}
          </p>
        </div>
        {priced.length > 0 ? (
          <PrintButton label={`Print ${priced.length} bill${priced.length === 1 ? "" : "s"}`} />
        ) : null}
      </div>

      {alreadyInvoiced > 0 ? (
        <div className="print:hidden">
          <Alert tone="error">
            {alreadyInvoiced} invoice{alreadyInvoiced === 1 ? " has" : "s have"} already been
            raised for {termLabel}. Print the real bills instead — an advance bill beside a
            real invoice is two different figures for the same term.{" "}
            <Link href={`/invoices/print?term=${termId}`} className="font-semibold underline">
              Print invoices
            </Link>
          </Alert>
        </div>
      ) : null}

      {!school.settings?.paymentInstructions ? (
        <div className="print:hidden">
          <Alert tone="error">
            These bills say nothing about how to pay, which is most of the point of sending
            one home early. Add momo or bank details under Settings → Fees policy.
          </Alert>
        </div>
      ) : null}

      {/* Printed WITH the run, like the arrears holds on the report cards: the
          person at the printer is rarely the person who read the screen. */}
      {skipped.length > 0 ? (
        <div className="rounded-xl border border-hairline bg-warning-tint p-4 print:break-after-page">
          <h2 className="text-sm font-semibold text-warning-ink">
            {skipped.length} pupil{skipped.length === 1 ? "" : "s"} could not be priced
          </h2>
          <ul className="mt-3 space-y-2 text-sm text-warning-ink">
            {groupSkipped(skipped).map((group) => (
              <li key={group.problem}>
                <p className="font-semibold">{group.problem}</p>
                <p className="text-xs">{group.fix}</p>
                <p className="mt-0.5 text-xs">
                  {group.students.map((s) => `${s.name} (${s.admissionNo})`).join(", ")}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {priced.length === 0 ? (
        <div className="print:hidden">
          <Alert tone="error">
            Nothing to price for {label}. A fee structure has to exist for the level before a
            term can be costed.
          </Alert>
        </div>
      ) : null}

      {priced.map((row, index) => (
        <ProformaBill
          key={row.student.admissionNo}
          school={school}
          term={term}
          proforma={row}
          printedBy={auth.name}
          breakAfter={index < priced.length - 1}
        />
      ))}
    </div>
  );
}
