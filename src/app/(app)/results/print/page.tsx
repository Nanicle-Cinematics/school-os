import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth, requireRole } from "@/lib/auth";
import { LEADERSHIP } from "@/lib/permissions";
import { getClassReportCards } from "@/lib/results-data";
import { prisma } from "@/lib/prisma";
import { Alert } from "../../ui";
import { ReportCard } from "../report-card";

export const metadata: Metadata = { title: "Print report cards · School OS" };

const TERM_NAME: Record<string, string> = { FIRST: "First", SECOND: "Second", THIRD: "Third" };

export default async function PrintReportCardsPage({
  searchParams,
}: PageProps<"/results/print">) {
  await requireRole(LEADERSHIP);
  const auth = await requireAuth();
  const query = await searchParams;

  const termId = typeof query.term === "string" ? query.term : "";
  const classGroupId = typeof query.class === "string" ? query.class : "";
  // Published-only by default: an unpublished card is a draft the office has not
  // signed off, and handing forty of those to parents cannot be undone.
  const includeDrafts = query.drafts === "1";

  if (!termId || !classGroupId) {
    notFound();
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

  const { cards, settings } = await getClassReportCards(termId, classGroupId);
  const printable = includeDrafts
    ? cards
    : cards.filter((card) => card.termResult.status === "PUBLISHED");
  const withheld = cards.length - printable.length;

  const label = `${classGroup.level.name} ${classGroup.name}`;
  const termLabel = `${TERM_NAME[term.name] ?? term.name} Term · ${term.academicYear.name}`;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div>
          <Link
            href={`/results/broadsheet?term=${termId}&class=${classGroupId}`}
            className="text-sm text-slate-500 hover:text-slate-900"
          >
            ← Broadsheet
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">
            {label} · {printable.length} report card{printable.length === 1 ? "" : "s"}
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {termLabel} · one sheet each. Use your browser&rsquo;s print dialog.
          </p>
        </div>

        {withheld > 0 && !includeDrafts ? (
          <Link
            href={`/results/print?term=${termId}&class=${classGroupId}&drafts=1`}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Include {withheld} unpublished
          </Link>
        ) : null}
      </div>

      {withheld > 0 && !includeDrafts ? (
        <Alert tone="error">
          {withheld} of {cards.length} cards are not published yet and have been left out. Publish
          them from the results screen, or include them deliberately.
        </Alert>
      ) : null}

      {printable.length === 0 ? (
        <Alert tone="error">
          Nothing to print for {label} this term. Results have to be computed and published first.
        </Alert>
      ) : null}

      {printable.map((card, index) => (
        <ReportCard
          key={card.termResult.id}
          schoolName={auth.schoolName}
          termResult={card.termResult}
          subjectResults={card.subjectResults}
          settings={settings}
          breakAfter={index < printable.length - 1}
        />
      ))}
    </div>
  );
}
