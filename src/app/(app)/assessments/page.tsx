import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { LEADERSHIP } from "@/lib/permissions";
import { getTeachingScope, getAssessmentList, getTermsForPicker } from "@/lib/assessment-data";
import { getCurrentTerm } from "@/lib/fee-data";
import {
  PageHeader,
  Card,
  StatusBadge,
  EmptyRow,
  filterClass,
  thClass,
  tableHeadClass,
} from "../ui";
import { NewAssessment } from "./new-assessment";

export const metadata: Metadata = { title: "Assessments · School OS" };

const TYPE_LABEL: Record<string, string> = {
  CLASS_EXERCISE: "Exercise",
  CLASS_TEST: "Class test",
  HOMEWORK: "Homework",
  PROJECT: "Project",
  MIDTERM_EXAM: "Mid-term",
  END_OF_TERM_EXAM: "End of term",
};

export default async function AssessmentsPage({ searchParams }: PageProps<"/assessments">) {
  const auth = await requireRole(LEADERSHIP);
  const params = await searchParams;

  const [scope, terms, currentTerm] = await Promise.all([
    getTeachingScope(auth),
    getTermsForPicker(),
    getCurrentTerm(),
  ]);

  const termId = typeof params.term === "string" ? params.term : (currentTerm?.id ?? undefined);
  const classGroupId = typeof params.class === "string" ? params.class : undefined;
  const subjectId = typeof params.subject === "string" ? params.subject : undefined;

  const assessments = await getAssessmentList({
    termId,
    classGroupId,
    subjectId,
    allowedPairs: scope.pairs,
  });

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Assessments"
        subtitle={
          scope.isLeadership
            ? `${assessments.length} across the school`
            : `${assessments.length} for your classes`
        }
        action={
          <NewAssessment
            classGroups={scope.classGroups}
            subjects={scope.subjects}
            terms={terms}
            currentTermId={currentTerm?.id}
          />
        }
      />

      <form className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-white p-3">
        <select name="term" defaultValue={termId ?? ""} className={`${filterClass} w-auto`}>
          <option value="">All terms</option>
          {terms.map((term) => (
            <option key={term.id} value={term.id}>
              Term {term.sequence} · {term.academicYear.name}
            </option>
          ))}
        </select>
        <select name="class" defaultValue={classGroupId ?? ""} className={`${filterClass} w-auto`}>
          <option value="">All classes</option>
          {scope.classGroups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.level.name} {group.name}
            </option>
          ))}
        </select>
        <select name="subject" defaultValue={subjectId ?? ""} className={`${filterClass} w-auto`}>
          <option value="">All subjects</option>
          {scope.subjects.map((subject) => (
            <option key={subject.id} value={subject.id}>
              {subject.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white shadow-[0_6px_16px_rgba(18,128,92,0.22)] transition hover:bg-brand-700"
        >
          Filter
        </button>
        <Link
          href="/assessments"
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 transition hover:bg-slate-50"
        >
          Reset
        </Link>
      </form>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className={tableHeadClass}>
              <tr>
                <th className={thClass}>Title</th>
                <th className={thClass}>Class</th>
                <th className={thClass}>Subject</th>
                <th className={thClass}>Type</th>
                <th className={`${thClass} text-right`}>Max</th>
                <th className={`${thClass} text-right`}>Weight</th>
                <th className={`${thClass} text-right`}>Scored</th>
                <th className={thClass}>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {assessments.length === 0 ? (
                <EmptyRow colSpan={8}>
                  No assessments yet. Create one to start entering scores.
                </EmptyRow>
              ) : (
                assessments.map((assessment) => (
                  <tr key={assessment.id} className="hover:bg-slate-50">
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <Link
                        href={`/assessments/${assessment.id}`}
                        className="font-medium text-slate-900 underline-offset-2 hover:underline"
                      >
                        {assessment.title}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                      {assessment.classGroup.level.name} {assessment.classGroup.name}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                      {assessment.subject.name}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                      {TYPE_LABEL[assessment.type] ?? assessment.type}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-slate-600">
                      {Number(assessment.maxScore)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-slate-500">
                      {Number(assessment.weight) > 0 ? Number(assessment.weight) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-slate-600">
                      {assessment._count.scores}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <StatusBadge status={assessment.status} />
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
