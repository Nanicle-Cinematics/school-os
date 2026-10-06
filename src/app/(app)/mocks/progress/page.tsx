import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TrendingUp } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { ACADEMIC } from "@/lib/permissions";
import { getMockProgress } from "@/lib/mock-data";
import { buttonClass } from "../../button-style";
import { PageHeader, Avatar, filterClass } from "../../ui";
import { DataTable, Row, type Column } from "../../primitives";

export const metadata: Metadata = { title: "Mock progress · School OS" };

/**
 * Each candidate's aggregate in every mock of the year, side by side, and the
 * change from their first to their latest. The list a head reads to decide who
 * needs extra classes before the BECE — sorted so the candidates slipping the
 * most come first.
 */
export default async function MockProgressPage({ searchParams }: PageProps<"/mocks/progress">) {
  await requireRole(ACADEMIC);
  const query = await searchParams;
  const classGroupId = typeof query.class === "string" && query.class ? query.class : undefined;

  const data = await getMockProgress(classGroupId);
  if (!data) notFound();
  const { level, year, mocks, rows, classGroups } = data;

  const columns: Column[] = [
    { label: "Candidate" },
    ...mocks.map((mock) => ({ label: mock.title, numeric: true })),
    { label: "Change", numeric: true },
  ];

  // Biggest rise in aggregate (getting worse) first; no trend last.
  const sorted = [...rows].sort((a, b) => {
    if (a.change === null && b.change === null) return a.student.lastName.localeCompare(b.student.lastName);
    if (a.change === null) return 1;
    if (b.change === null) return -1;
    return b.change - a.change;
  });

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader title="Progress across mocks" subtitle={`${level.name} · ${year.name} · aggregate, lower is better`} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/mocks" className="text-sm text-slate-500 hover:text-slate-900">
          ← Mock exams
        </Link>
        <form method="get" className="flex items-center gap-2">
          <select name="class" defaultValue={classGroupId ?? ""} className={filterClass}>
            <option value="">All classes</option>
            {classGroups.map((c) => (
              <option key={c.id} value={c.id}>
                {level.name} {c.name}
              </option>
            ))}
          </select>
          <button type="submit" className={buttonClass("secondary")}>
            Show
          </button>
        </form>
      </div>

      <DataTable columns={columns} empty={{ icon: TrendingUp, title: "No candidates to show." }}>
        {sorted.map(({ student, results, change }) => (
          <Row key={student.id}>
            <td className="px-4 py-2.5">
              <div className="flex items-center gap-3">
                <Avatar firstName={student.firstName} lastName={student.lastName} />
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-900">
                    {student.lastName}, {student.firstName}
                  </p>
                  <p className="text-xs text-slate-400">
                    {level.name} {student.classGroup.name}
                  </p>
                </div>
              </div>
            </td>
            {results.map((result, index) => (
              <td key={mocks[index].id} className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                {result.aggregate ?? <span className="text-slate-300">—</span>}
              </td>
            ))}
            <td
              className={`px-4 py-2.5 text-right font-semibold tabular-nums ${
                change === null ? "text-slate-300" : change > 0 ? "text-danger-ink" : change < 0 ? "text-success-ink" : "text-slate-500"
              }`}
            >
              {change === null ? "—" : change > 0 ? `+${change} worse` : change < 0 ? `${-change} better` : "no change"}
            </td>
          </Row>
        ))}
      </DataTable>

      <p className="text-xs text-slate-500">
        Change is from each candidate&rsquo;s first mock with a full aggregate to their latest. A mock they
        missed or that is not fully marked shows a dash and is skipped, so it does not read as a collapse.
      </p>
    </div>
  );
}
