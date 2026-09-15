import type { Metadata } from "next";
import { LineChart } from "lucide-react";
import { buttonClass } from "../button-style";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { ACADEMIC, canAccess } from "@/lib/permissions";
import { getResultsOverview } from "@/lib/results-data";
import { getTermsForPicker } from "@/lib/assessment-data";
import { getCurrentTerm } from "@/lib/fee-data";
import { setResultsStatus } from "@/lib/results-actions";
import { PageHeader, Card, filterClass } from "../ui";
import { DataTable, Row, type Column } from "../primitives";
import { SubmitButton } from "../submit-button";
import { ComputeForm } from "./compute-form";

export const metadata: Metadata = { title: "Results · School OS" };

const COLUMNS: Column[] = [
  { label: "Class" },
  { label: "Form teacher" },
  { label: "Enrolled", numeric: true },
  { label: "Assessments", numeric: true },
  { label: "Computed", numeric: true },
  { label: "Published", numeric: true },
  { label: "Actions" },
];

export default async function ResultsPage({ searchParams }: PageProps<"/results">) {
  const auth = await requireRole(ACADEMIC);
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
  const isLeadership = canAccess(auth.roles, ACADEMIC);
  const term = terms.find((t) => t.id === termId);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Results"
        subtitle={
          term ? `Term ${term.sequence} · ${term.academicYear.name}` : "Compute and publish results"
        }
      />

      <form className="flex flex-wrap items-end gap-2 rounded-card border border-hairline bg-surface p-3">
        <select name="term" defaultValue={termId} className={`${filterClass} w-auto`}>
          {terms.map((option) => (
            <option key={option.id} value={option.id}>
              Term {option.sequence} · {option.academicYear.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className={buttonClass("primary")}
        >
          Show
        </button>
      </form>

      <div className="rounded-card border border-hairline bg-surface px-4 py-3 text-sm text-slate-600">
        <span className="font-medium text-slate-900">How this works: </span>
        enter scores against assessments, compute a class to turn them into subject and term
        results, then submit → approve → publish. Publishing freezes positions and makes report
        cards final.
      </div>

      <Card>
        <div className="overflow-x-auto">
          <DataTable
            columns={COLUMNS}
            empty={{ icon: LineChart, title: "No classes to compute results for yet.", action: undefined }}
          >
            {overview.map((row) => (
                  <Row key={row.classGroup.id}>
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
                        <span className="font-medium text-success-ink">{row.published}</span>
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
                  </Row>
                ))
              }
          </DataTable>
        </div>
      </Card>
    </div>
  );
}
