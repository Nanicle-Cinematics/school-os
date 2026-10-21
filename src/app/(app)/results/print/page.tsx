import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth, requireRole } from "@/lib/auth";
import { ACADEMIC, FINANCE, canAccess } from "@/lib/permissions";
import { getNextTermId } from "@/lib/invoice-data";
import { getClassReportCards, getReportCard } from "@/lib/results-data";
import { reportHoldsForClass, reportHold } from "@/lib/report-access";
import { formatCedis } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { Alert } from "../../ui";
import { ReportCard } from "../report-card";
import { PrintButton } from "../../print-button";

export const metadata: Metadata = { title: "Print report cards · School OS" };

const TERM_NAME: Record<string, string> = { FIRST: "First", SECOND: "Second", THIRD: "Third" };

export default async function PrintReportCardsPage({
  searchParams,
}: PageProps<"/results/print">) {
  await requireRole(ACADEMIC);
  const auth = await requireAuth();
  const query = await searchParams;

  const termId = typeof query.term === "string" ? query.term : "";
  const classGroupId = typeof query.class === "string" ? query.class : "";
  const studentId = typeof query.student === "string" ? query.student : "";
  // Published-only by default: an unpublished card is a draft the office has not
  // signed off, and handing forty of those to parents cannot be undone.
  const includeDrafts = query.drafts === "1";

  if (!termId || (!classGroupId && !studentId)) {
    notFound();
  }

  /**
   * ONE child, printed on purpose.
   *
   * This is the release valve the class run deliberately lacks. The batch drops
   * a card held for arrears and names it, because forty sheets come out of a
   * printer and nobody checks the other thirty-eight — but a head who must hand
   * over one card has to be able to. So the single print does NOT silently drop
   * a held card; it prints it and says, on the paper, that it was released and
   * what is owed. One deliberate act on one child is a decision. A missing sheet
   * in a stack of forty is an accident waiting to be blamed on the software.
   */
  if (studentId) {
    const single = await getReportCard(termId, studentId);
    if (!single) {
      notFound();
    }
    const held = await reportHold(studentId, termId, single.settings);
    const student = single.termResult.student;
    const unpublishedCard = single.termResult.status !== "PUBLISHED";

    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
          <div>
            <Link
              href={`/results/${studentId}?term=${termId}`}
              className="text-sm text-slate-500 hover:text-slate-900"
            >
              ← Report card
            </Link>
            <h1 className="mt-1 text-xl font-semibold text-slate-900">
              {student.firstName} {student.lastName}
            </h1>
            <p className="mt-0.5 text-sm text-slate-500">
              One sheet · {student.admissionNo}
            </p>
          </div>
          <PrintButton label="Print this card" />
        </div>

        {unpublishedCard ? (
          <Alert tone="error">
            This card is not published. The parent cannot see it in the portal, and what
            you are about to print is a draft.
          </Alert>
        ) : null}

        {held ? (
          <Alert tone="error">
            Released deliberately. {formatCedis(held.balance)} is outstanding on invoice{" "}
            {held.invoiceNo}, and the school withholds cards in arrears — this one is left
            out of the class run and hidden from the parent portal. Printing it here is a
            decision to hand it over anyway.
          </Alert>
        ) : null}

        <ReportCard
          schoolName={auth.schoolName}
          schoolMotto={auth.schoolMotto}
          schoolCrestUrl={auth.schoolCrestUrl}
          headSignatureUrl={auth.headSignatureUrl}
          headName={auth.headName}
          termResult={single.termResult}
          subjectResults={single.subjectResults}
          settings={single.settings}
          skills={single.skills}
        />
      </div>
    );
  }

  const classGroup = await prisma.classGroup.findUnique({
    where: { id: classGroupId },
    select: { name: true, level: { select: { name: true } } },
  });
  const term = await prisma.term.findUnique({
    where: { id: termId },
    select: { name: true, academicYear: { select: { name: true } } },
  });

  if (!classGroup || !term) {
    notFound();
  }

  const { cards, settings, skills } = await getClassReportCards(termId, classGroupId);
  const published = includeDrafts
    ? cards
    : cards.filter((card) => card.termResult.status === "PUBLISHED");
  const unpublished = cards.length - published.length;

  /**
   * Arrears holds, applied to the batch.
   *
   * ⚠️ This is the loophole the setting exists to close: a form teacher prints a
   * class, forty sheets come out, and the two that were supposed to be held went
   * home in the middle of the stack because nobody checks the other thirty-eight.
   * They are removed from the run and NAMED above it, so the office knows what it
   * is holding and can go and ask for the money.
   *
   * There is deliberately no "print them anyway" button here. A head who really
   * must release one card opens that child's page and prints it — one deliberate
   * act on one child, which is a decision, rather than a click that quietly undoes
   * the policy for a whole class.
   */
  const holds = await reportHoldsForClass(
    published.map((card) => card.termResult.studentId),
    termId,
    settings,
  );
  const printable = published.filter((card) => !holds.has(card.termResult.studentId));
  const heldCards = published.filter((card) => holds.has(card.termResult.studentId));

  // Next term's bill, with whatever is still owing on the same sheet, is what goes home beside the
  // report card. It prices money, so only someone who may read money is offered it.
  const nextTermId = canAccess(auth.roles, FINANCE) ? await getNextTermId(termId) : null;

  const label = `${classGroup.level.name} ${classGroup.name}`;
  const termLabel = `${TERM_NAME[term.name] ?? term.name} Term · ${term.academicYear.name}`;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div>
          <Link
            href={skills ? "/results" : `/results/broadsheet?term=${termId}&class=${classGroupId}`}
            className="text-sm text-slate-500 hover:text-slate-900"
          >
            {skills ? "← Results" : "← Broadsheet"}
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">
            {label} · {printable.length} report card{printable.length === 1 ? "" : "s"}
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {termLabel} · one sheet each. Use your browser&rsquo;s print dialog.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <PrintButton label={`Print ${printable.length} card${printable.length === 1 ? "" : "s"}`} />
          {nextTermId ? (
            <Link
              href={`/invoices/proforma?term=${nextTermId}&class=${classGroupId}`}
              className="rounded-card border border-hairline bg-surface px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
            >
              Next term&rsquo;s bills for this class
            </Link>
          ) : null}
        {unpublished > 0 && !includeDrafts ? (
          <Link
            href={`/results/print?term=${termId}&class=${classGroupId}&drafts=1`}
            className="rounded-card border border-hairline bg-surface px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Include {unpublished} unpublished
          </Link>
        ) : null}
        </div>
      </div>

      {unpublished > 0 && !includeDrafts ? (
        <Alert tone="error">
          {unpublished} of {cards.length} cards are not published yet and have been left out. Publish
          them from the results screen, or include them deliberately.
        </Alert>
      ) : null}

      {/* Printed with the batch, not just shown on screen: this list is the
          record of what the school is holding and why, and the person at the
          printer is rarely the person who read the screen. */}
      {heldCards.length > 0 ? (
        <div className="rounded-xl border border-hairline bg-warning-tint p-4 print:break-after-page">
          <h2 className="text-sm font-semibold text-warning-ink">
            {heldCards.length} card{heldCards.length === 1 ? "" : "s"} held for arrears
          </h2>
          <p className="mt-1 text-xs text-warning-ink">
            Left out of this run and hidden from the parent portal. Each appears as soon as
            its payment is recorded.
          </p>
          <ul className="mt-3 space-y-1 text-sm text-warning-ink">
            {heldCards.map((card) => {
              const hold = holds.get(card.termResult.studentId)!;
              const student = card.termResult.student;
              return (
                <li key={card.termResult.id} className="flex justify-between gap-4">
                  <span>
                    {student.firstName} {student.lastName}{" "}
                    <span className="font-mono text-xs text-warning-ink">
                      {student.admissionNo}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums font-semibold">
                    {formatCedis(hold.balance)} · {hold.invoiceNo}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {printable.length === 0 ? (
        <Alert tone="error">
          {heldCards.length > 0 && heldCards.length === published.length
            ? `Nothing to print for ${label} — every card this term is held for arrears.`
            : `Nothing to print for ${label} this term. Results have to be computed and published first.`}
        </Alert>
      ) : null}

      {printable.map((card, index) => (
        <ReportCard
          key={card.termResult.id}
          schoolName={auth.schoolName}
          schoolMotto={auth.schoolMotto}
          schoolCrestUrl={auth.schoolCrestUrl}
          headSignatureUrl={auth.headSignatureUrl}
          headName={auth.headName}
          termResult={card.termResult}
          subjectResults={card.subjectResults}
          settings={settings}
          skills={skills}
          breakAfter={index < printable.length - 1}
        />
      ))}
    </div>
  );
}
