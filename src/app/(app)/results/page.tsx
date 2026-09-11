import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { LEADERSHIP, canAccess } from "@/lib/permissions";
import { getResultsOverview } from "@/lib/results-data";
import { getTermsForPicker } from "@/lib/assessment-data";
import { getCurrentTerm } from "@/lib/fee-data";
import { setResultsStatus } from "@/lib/results-actions";
import { PageHeader, Card, EmptyRow, filterClass, thClass, tableHeadClass } from "../ui";
import { SubmitButton } from "../submit-button";
import { ComputeForm } from "./compute-form";

export const metadata: Metadata = { title: "Results · School OS" };

export default async function ResultsPage({ searchParams }: PageProps<"/results">) {
  const auth = await requireRole(LEADERSHIP);
  const params = await searchParams;

  const [terms, currentTerm] = await Promise.all([getTermsForPicker(), getCurrentTerm()]);
  const termId = typeof params.term === "string" ? params.term : currentTerm?.id;

  if (!termId) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card>
          <p className="px-4 py-10 text-center text-sm text-slate-500">
            No term is marked as current, and results are computed per term.{" "}
            <Link href="/settings/terms" className="font-medium text-brand-ink hover:underline">
              Set up the year and its terms
            </Link>{" "}
            first.
          </p>
        </Card>
      </div>
    );
  }

  const overview = await getResultsOverview(termId);
  const isLeadership = canAccess(auth.roles, LEADERSHIP);
  const term = terms.find((t) => t.id === termId);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Results"
        subtitle={
          term ? `Term ${term.sequence} · ${term.academicYear.name}` : "Compute and publish results"
        }
      />

      <form className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-surface p-3">
        <select name="term" defaultValue={termId} className={`${filterClass} w-auto`}>
          {terms.map((option) => (
            <option key={option.id} value={option.id}>
              Term {option.sequence} · {option.academicYear.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white shadow-[0_6px_16px_rgba(18,128,92,0.22)] transition hover:bg-brand-700"
        >
          Show
        </button>
      </form>

      <div className="rounded-xl border border-slate-200 bg-surface px-4 py-3 text-sm text-slate-600">
        <span className="font-medium text-slate-900">How this works: </span>
        enter scores against assessments, compute a class to turn them into subject and term
        results, then submit → approve → publish. Publishing freezes positions and makes report
        cards final.
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className={tableHeadClass}>
              <tr>
                <th className={thClass}>Class</th>
                <th className={thClass}>Form teacher</th>
                <th className={`${thClass} text-right`}>Enrolled</th>
                <th className={`${thClass} text-right`}>Assessments</th>
                <th className={`${thClass} text-right`}>Computed</th>
                <th className={`${thClass} text-right`}>Published</th>
                <th className={thClass}>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {overview.length === 0 ? (
                <EmptyRow colSpan={7}>No classes set up yet.</EmptyRow>
              ) : (
                overview.map((row) => (
                  <tr key={row.classGroup.id} className="hover:bg-slate-50">
                    <td className="whitespace-nowrap px-4 py-2.5 font-medium text-slate-900">
                      {row.classGroup.level.name} {row.classGroup.name}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                      {row.classGroup.formTeacher
                        ? `${row.classGroup.formTeacher.firstName} ${row.classGroup.formTeacher.lastName}`
                        : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">
                      {row.enrolled}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">
                      {row.assessments}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">
                      {row.computed}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {row.published > 0 ? (
                        <span className="font-medium text-green-700">{row.published}</span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <ComputeForm termId={termId} classGroupId={row.classGroup.id} />

                        {row.computed > 0 ? (
                          <Link
                            href={`/results/broadsheet?term=${termId}&class=${row.classGroup.id}`}
                            className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50"
                          >
                            Broadsheet
                          </Link>
                        ) : null}

                        {row.computed > 0 && isLeadership && row.published < row.computed ? (
                          <form action={setResultsStatus}>
                            <input type="hidden" name="termId" value={termId} />
                            <input type="hidden" name="classGroupId" value={row.classGroup.id} />
                            <input type="hidden" name="status" value="PUBLISHED" />
                            <SubmitButton pendingLabel="Publishing…">Publish</SubmitButton>
                          </form>
                        ) : null}

                        {row.published > 0 && isLeadership ? (
                          <form action={setResultsStatus}>
                            <input type="hidden" name="termId" value={termId} />
                            <input type="hidden" name="classGroupId" value={row.classGroup.id} />
                            <input type="hidden" name="status" value="APPROVED" />
                            <SubmitButton variant="danger" pendingLabel="Unpublishing…">
                              Unpublish
                            </SubmitButton>
                          </form>
                        ) : null}
                      </div>
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
