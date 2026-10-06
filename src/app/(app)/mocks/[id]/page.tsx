import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { ACADEMIC } from "@/lib/permissions";
import { getMockBroadsheet } from "@/lib/mock-data";
import { ordinal } from "@/lib/results-engine";
import { buttonClass } from "../../button-style";
import { Card, StatusBadge, Alert, thClass, tableHeadClass, filterClass } from "../../ui";
import { PrintButton } from "../../print-button";

export const metadata: Metadata = { title: "Mock broadsheet · School OS" };

/**
 * Every candidate, every subject: the mark and its grade, the BECE aggregate
 * and the year-group position. A wide grid, not a list — named in
 * verify:design's NOT_LISTS like the term broadsheet it mirrors.
 */
export default async function MockBroadsheetPage({ params, searchParams }: PageProps<"/mocks/[id]">) {
  await requireRole(ACADEMIC);
  const { id } = await params;
  const query = await searchParams;
  const classGroupId = typeof query.class === "string" && query.class ? query.class : undefined;

  const data = await getMockBroadsheet(id, classGroupId);
  if (!data) notFound();
  const { mock, subjects, rows, classGroups, candidates, hasScale } = data;

  const placed = rows.filter((r) => r.aggregate !== null);
  const averageOf = (subjectId: string) => {
    const scores = rows.map((r) => r.cells.get(subjectId)?.score).filter((s): s is number => s != null);
    return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  };
  const meanAggregate = placed.length
    ? placed.reduce((sum, r) => sum + (r.aggregate as number), 0) / placed.length
    : null;

  return (
    <div className="mx-auto max-w-full space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/mocks" className="text-sm text-slate-500 hover:text-slate-900 print:hidden">
            ← Mock exams
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">
            {mock.level.name} {mock.title} broadsheet
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {mock.academicYear.name} · {candidates} candidates · {placed.length} with a full aggregate
            {meanAggregate !== null ? ` · mean aggregate ${meanAggregate.toFixed(1)}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 print:hidden">
          <StatusBadge status={mock.isClosed ? "CLOSED" : "OPEN"} />
          <form method="get">
            <select name="class" defaultValue={classGroupId ?? ""} className={filterClass}>
              <option value="">All classes</option>
              {classGroups.map((c) => (
                <option key={c.id} value={c.id}>
                  {mock.level.name} {c.name}
                </option>
              ))}
            </select>{" "}
            <button type="submit" className={buttonClass("secondary")}>
              Show
            </button>
          </form>
          <Link
            href={`/mocks/${mock.id}/slips${classGroupId ? `?class=${classGroupId}` : ""}`}
            className={buttonClass("primary")}
          >
            Print result slips
          </Link>
          <PrintButton label="Print broadsheet" />
        </div>
      </div>

      {!hasScale ? (
        <Alert tone="error">
          No grading scale is set up, so marks cannot be graded or aggregated. Set one in Settings →
          Grading.
        </Alert>
      ) : null}

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className={tableHeadClass}>
              <tr>
                <th className={`${thClass} text-right`}>Pos</th>
                <th className={`${thClass} sticky left-0 bg-slate-50`}>Candidate</th>
                <th className={`${thClass} text-right`}>Agg</th>
                {subjects.map((subject) => (
                  <th key={subject.id} className={`${thClass} text-right`} title={subject.name}>
                    {subject.code}
                    {subject.core ? <span className="text-accent-700">*</span> : null}
                  </th>
                ))}
                <th className={`${thClass} text-right`}>Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={subjects.length + 4} className="px-4 py-10 text-center text-sm text-slate-500">
                    Nobody is enrolled in {mock.level.name} this year.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.studentId} className="hover:bg-slate-50">
                    <td className="whitespace-nowrap px-4 py-2 text-right font-medium tabular-nums text-slate-900">
                      {ordinal(row.position)}
                    </td>
                    <td className="sticky left-0 whitespace-nowrap bg-surface px-4 py-2 font-medium text-slate-900">
                      {row.student.lastName}, {row.student.firstName}
                      <span className="ml-2 text-xs font-normal text-slate-400">{row.student.classGroup.name}</span>
                    </td>
                    <td
                      className="whitespace-nowrap px-4 py-2 text-right font-semibold tabular-nums text-slate-900"
                      title={row.missing ?? undefined}
                    >
                      {row.aggregate ?? <span className="font-normal text-slate-300">—</span>}
                    </td>
                    {subjects.map((subject) => {
                      const cell = row.cells.get(subject.id);
                      return (
                        <td key={subject.id} className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-slate-700">
                          {cell?.score == null ? (
                            <span className="text-slate-300">—</span>
                          ) : (
                            <>
                              {cell.isAbsent ? "abs" : cell.score.toFixed(0)}
                              <span
                                className={`ml-1 text-xs ${row.counted.includes(subject.id) ? "font-bold text-slate-700" : "text-slate-400"}`}
                              >
                                {cell.grade}
                              </span>
                            </>
                          )}
                        </td>
                      );
                    })}
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-slate-700">
                      {row.marked > 0 ? row.total.toFixed(0) : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            {rows.length > 0 ? (
              <tfoot className="border-t border-hairline bg-slate-50 text-xs text-slate-500">
                <tr>
                  <td className="px-4 py-2" />
                  <td className="sticky left-0 bg-slate-50 px-4 py-2 font-semibold">Subject average</td>
                  <td className="px-4 py-2" />
                  {subjects.map((subject) => {
                    const avg = averageOf(subject.id);
                    return (
                      <td key={subject.id} className="px-4 py-2 text-right tabular-nums">
                        {avg === null ? "—" : avg.toFixed(1)}
                      </td>
                    );
                  })}
                  <td className="px-4 py-2" />
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      </Card>

      <p className="text-xs text-slate-500">
        * Core subject. The aggregate is the grade points of the four core subjects plus the best two of
        the rest; the grades that count are shown in bold. A candidate missing a core subject, or with
        fewer than two other subjects marked, has no aggregate and no position yet — hover over the dash
        to see why. Positions are across all {mock.level.name} classes.
      </p>
    </div>
  );
}
