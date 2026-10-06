import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { ACADEMIC } from "@/lib/permissions";
import { getMockBroadsheet } from "@/lib/mock-data";
import { ordinal } from "@/lib/results-engine";
import { paperWatermark } from "@/lib/paper";
import { PrintButton } from "../../../print-button";

export const metadata: Metadata = { title: "Mock result slips · School OS" };

/**
 * One slip per candidate, for parents: each subject's mark, grade and remark,
 * the aggregate and the year-group position. `.paper`, so it prints light in
 * dark mode, and a page break after each slip.
 *
 * Not a report card and must not read as one: it says "mock" in its heading
 * and carries no term, no attendance and no promotion.
 */
export default async function MockSlipsPage({ params, searchParams }: PageProps<"/mocks/[id]/slips">) {
  const auth = await requireRole(ACADEMIC);
  const { id } = await params;
  const query = await searchParams;
  const classGroupId = typeof query.class === "string" && query.class ? query.class : undefined;

  const data = await getMockBroadsheet(id, classGroupId);
  if (!data) notFound();
  const { mock, subjects, rows, candidates } = data;
  const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={`/mocks/${mock.id}`} className="text-sm text-slate-500 hover:text-slate-900">
          ← {mock.title} broadsheet
        </Link>
        <PrintButton label={`Print ${rows.length} slip${rows.length === 1 ? "" : "s"}`} />
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">Nobody is enrolled in {mock.level.name} this year.</p>
      ) : null}

      {rows.map((row, index) => (
        <article
          key={row.studentId}
          className={`paper rounded-xl border border-slate-200 bg-white p-6 print:border-0 ${
            index < rows.length - 1 ? "print:break-after-page" : ""
          }`}
          style={paperWatermark(auth.schoolCrestUrl)}
        >
          <header className="flex items-center gap-4 border-b-2 border-brand-800 pb-4">
            {auth.schoolCrestUrl ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={auth.schoolCrestUrl} alt="" className="h-14 w-14 shrink-0 object-contain" />
              </>
            ) : null}
            <div className="min-w-0 flex-1 text-center">
              <h1 className="font-display text-2xl text-slate-900">{auth.schoolName}</h1>
              <p className="mt-2 text-sm font-semibold tracking-wide text-brand-800">
                {mock.title} examination · result slip
              </p>
              <p className="text-xs text-slate-500">
                {mock.level.name} · {mock.academicYear.name}
                {mock.sittingDate ? ` · sat ${dateFmt.format(mock.sittingDate)}` : ""}
              </p>
            </div>
            {auth.schoolCrestUrl ? <div className="h-14 w-14 shrink-0" /> : null}
          </header>

          <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 border-b border-slate-200 py-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-slate-500">Candidate</dt>
              <dd className="font-medium text-slate-900">
                {row.student.firstName} {row.student.lastName}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Admission no.</dt>
              <dd className="font-mono text-slate-900">{row.student.admissionNo}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Class</dt>
              <dd className="text-slate-900">
                {mock.level.name} {row.student.classGroup.name}
              </dd>
            </div>
          </dl>

          <table className="mt-4 w-full text-left text-sm">
            <thead className="border-b border-slate-300 text-xs text-slate-500">
              <tr>
                <th className="py-2 font-semibold">Subject</th>
                <th className="py-2 text-right font-semibold">Mark</th>
                <th className="py-2 text-right font-semibold">Grade</th>
                <th className="py-2 pl-4 font-semibold">Remark</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {subjects.map((subject) => {
                const cell = row.cells.get(subject.id);
                const counted = row.counted.includes(subject.id);
                return (
                  <tr key={subject.id}>
                    <td className="py-1.5 text-slate-900">
                      {subject.name}
                      {subject.core ? <span className="ml-1 text-xs text-slate-400">(core)</span> : null}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-slate-700">
                      {cell?.score == null ? "—" : cell.isAbsent ? "Absent" : cell.score.toFixed(0)}
                    </td>
                    <td className={`py-1.5 text-right tabular-nums ${counted ? "font-bold text-slate-900" : "text-slate-700"}`}>
                      {cell?.grade ?? "—"}
                    </td>
                    <td className="py-1.5 pl-4 text-slate-600">{cell?.remark ?? ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="mt-5 grid grid-cols-2 gap-4 border-t border-slate-200 pt-4 text-sm">
            <div>
              <p className="text-xs text-slate-500">Aggregate (best 6, BECE rule)</p>
              <p className="text-2xl font-semibold tabular-nums text-accent-700">{row.aggregate ?? "—"}</p>
              {row.missing ? <p className="text-xs text-slate-500">{row.missing}</p> : null}
            </div>
            <div>
              <p className="text-xs text-slate-500">Position in {mock.level.name}</p>
              <p className="text-2xl font-semibold tabular-nums text-slate-900">
                {ordinal(row.position)}
                {row.position !== null ? (
                  <span className="text-sm font-normal text-slate-500"> of {candidates}</span>
                ) : null}
              </p>
            </div>
          </div>

          <p className="mt-4 text-xs text-slate-500">
            The aggregate adds the grade points of the four core subjects and the best two others; the
            grades that count are in bold. Lower is better: 6 is the best possible. This is a mock
            examination and does not form part of the terminal report.
          </p>
        </article>
      ))}
    </div>
  );
}
