import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { FINANCE } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { getCollections, formatCedis } from "@/lib/dashboard-data";
import { PageHeader, Card, filterClass } from "../../ui";
import { buttonClass } from "../../button-style";
import { DataTable, Row, StatCard, type Column } from "../../primitives";
import { CalendarRange } from "lucide-react";

export const metadata: Metadata = { title: "Weekly collections · School OS" };

const COLUMNS: Column[] = [
  { label: "Week" },
  { label: "Dates" },
  { label: "Received", numeric: true },
  { label: "Running total", numeric: true, hideBelow: "sm" },
];

/**
 * The full-term version of the dashboard's collections chart — every week the
 * term has had, not just the last dozen, because an accountant closing a week
 * (or asked "how much came in in week 3?") needs the whole run, not a chart
 * trimmed to fit a card. Same source (`getCollections`), just unbounded — see
 * the note on `limit` there.
 */
export default async function WeeklyCollectionsPage({
  searchParams,
}: PageProps<"/payments/collections">) {
  const auth = await requireRole(FINANCE);
  const params = await searchParams;

  const currentTerm = await prisma.term.findFirst({
    where: { isCurrent: true },
    include: { academicYear: true },
  });

  const terms = await prisma.term.findMany({
    where: { academicYear: { schoolId: auth.schoolId } },
    orderBy: [{ academicYear: { name: "desc" } }, { sequence: "asc" }],
    include: { academicYear: { select: { name: true } } },
    take: 12,
  });

  const termId = typeof params.term === "string" ? params.term : currentTerm?.id;
  const term = terms.find((t) => t.id === termId) ?? currentTerm;

  const collections = term
    ? await getCollections(
        auth.schoolId,
        { id: term.id, startDate: term.startDate, endDate: term.endDate },
        new Date(),
        { limit: Infinity },
      )
    : null;

  const rows = collections
    ? collections.weeks.reduce<{ week: (typeof collections.weeks)[number]; running: number }[]>(
        (acc, week) => {
          const prevRunning = acc.length > 0 ? acc[acc.length - 1].running : 0;
          acc.push({ week, running: prevRunning + week.amount });
          return acc;
        },
        [],
      )
    : [];

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <Link href="/payments" className="text-sm text-slate-500 hover:text-slate-900">
          ← Payments
        </Link>
      </div>

      <PageHeader
        title="Weekly collections"
        subtitle={
          term
            ? `Fees received, week by week — Term ${term.sequence} · ${term.academicYear.name}`
            : "Choose a term to see what came in, week by week"
        }
      />

      {terms.length > 0 ? (
        <form className="flex flex-wrap items-center gap-2">
          <label className="text-sm text-slate-600" htmlFor="term">
            Term
          </label>
          <select id="term" name="term" defaultValue={term?.id ?? ""} className={`${filterClass} w-auto`}>
            {terms.map((t) => (
              <option key={t.id} value={t.id}>
                Term {t.sequence} · {t.academicYear.name}
              </option>
            ))}
          </select>
          <button type="submit" className={buttonClass("secondary")}>
            Show
          </button>
        </form>
      ) : null}

      {!term ? (
        <Card>
          <p className="px-4 py-6 text-sm text-slate-500">
            No terms set up yet — add one under Settings → Terms first.
          </p>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <StatCard
              label="Collected this term"
              value={formatCedis(collections!.total)}
              icon={CalendarRange}
              severity="done"
            />
            <StatCard label="Best week" value={formatCedis(collections!.best)} icon={CalendarRange} />
            <StatCard
              label="Week"
              value={
                collections!.currentWeek > 0
                  ? `${collections!.currentWeek} of ${collections!.termWeeks}`
                  : `${collections!.termWeeks} total`
              }
              icon={CalendarRange}
            />
          </div>

          <DataTable
            columns={COLUMNS}
            empty={{
              icon: CalendarRange,
              title: "Nothing collected yet this term.",
            }}
          >
            {rows.map(({ week, running }) => (
              <Row key={week.index}>
                <td className="px-card py-2.5 text-left font-medium text-slate-900">
                  {week.label}
                  {week.isCurrent ? (
                    <span className="ml-2 rounded-full bg-accent-50 px-1.5 py-0.5 text-[10px] font-semibold text-accent-600">
                      Current
                    </span>
                  ) : null}
                </td>
                <td className="px-card py-2.5 text-left text-slate-500">{week.range}</td>
                <td className="px-card py-2.5 text-right tabular-nums text-slate-900">
                  {formatCedis(week.amount)}
                </td>
                <td className="hidden px-card py-2.5 text-right tabular-nums text-slate-500 sm:table-cell">
                  {formatCedis(running)}
                </td>
              </Row>
            ))}
          </DataTable>
        </>
      )}

      <p className="text-xs text-slate-400">
        Buckets money by when it was allocated to this term&rsquo;s invoices, not by payment
        date — the same figures the Dashboard&rsquo;s chart and the Collected stat card use, so
        this always agrees with them.
      </p>
    </div>
  );
}
