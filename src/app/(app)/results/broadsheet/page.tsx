import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { ACADEMIC } from "@/lib/permissions";
import { getBroadsheet } from "@/lib/results-data";
import { ordinal } from "@/lib/results-engine";
import { Card, StatusBadge, thClass, tableHeadClass } from "../../ui";

export const metadata: Metadata = { title: "Broadsheet · School OS" };

export default async function BroadsheetPage({ searchParams }: PageProps<"/results/broadsheet">) {
  await requireRole(ACADEMIC);
  const params = await searchParams;
  const termId = typeof params.term === "string" ? params.term : "";
  const classGroupId = typeof params.class === "string" ? params.class : "";

  if (!termId || !classGroupId) {
    notFound();
  }

  const { classGroup, term, columns, rows } = await getBroadsheet(termId, classGroupId);

  if (!classGroup || !term) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-full space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/results" className="text-sm text-slate-500 hover:text-slate-900">
            ← Results
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">
            {classGroup.level.name} {classGroup.name} broadsheet
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Term {term.sequence} · {term.academicYear.name}
            {classGroup.formTeacher
              ? ` · Form teacher: ${classGroup.formTeacher.firstName} ${classGroup.formTeacher.lastName}`
              : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {rows[0] ? <StatusBadge status={rows[0].termResult.status} /> : null}
          {rows.length > 0 ? (
            <Link
              href={`/results/print?term=${termId}&class=${classGroup.id}`}
              className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
            >
              Print all report cards
            </Link>
          ) : null}
        </div>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className={tableHeadClass}>
              <tr>
                <th className={`${thClass} sticky left-0 bg-slate-50`}>Student</th>
                {columns.map((subject) => (
                  <th key={subject.id} className={`${thClass} text-right`} title={subject.name}>
                    {subject.code}
                  </th>
                ))}
                <th className={`${thClass} text-right`}>Total</th>
                <th className={`${thClass} text-right`}>Avg</th>
                <th className={`${thClass} text-right`}>Agg</th>
                <th className={`${thClass} text-right`}>Pos</th>
                <th className={thClass} />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={columns.length + 6}
                    className="px-4 py-10 text-center text-sm text-slate-500"
                  >
                    Nothing computed for this class yet.
                  </td>
                </tr>
              ) : (
                rows.map(({ termResult, scores }) => (
                  <tr key={termResult.id} className="hover:bg-slate-50">
                    <td className="sticky left-0 whitespace-nowrap bg-white px-4 py-2 font-medium text-slate-900">
                      {termResult.student.lastName}, {termResult.student.firstName}
                      <span className="ml-2 font-mono text-xs text-slate-400">
                        {termResult.student.admissionNo}
                      </span>
                    </td>
                    {columns.map((subject) => {
                      const result = scores.get(subject.id);
                      return (
                        <td
                          key={subject.id}
                          className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-slate-700"
                        >
                          {result?.totalScore ? (
                            <>
                              {Number(result.totalScore).toFixed(0)}
                              <span className="ml-1 text-xs text-slate-400">{result.grade}</span>
                            </>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>
                      );
                    })}
                    <td className="whitespace-nowrap px-4 py-2 text-right font-medium tabular-nums text-slate-900">
                      {termResult.totalMarks ? Number(termResult.totalMarks).toFixed(0) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-slate-700">
                      {termResult.average ? Number(termResult.average).toFixed(1) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-slate-700">
                      {termResult.aggregate ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right font-medium tabular-nums text-slate-900">
                      {ordinal(termResult.classPosition)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right">
                      <Link
                        href={`/results/${termResult.studentId}?term=${termId}`}
                        className="text-sm text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline"
                      >
                        Report
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
