import type { Metadata } from "next";
import { ClipboardCheck } from "lucide-react";
import { buttonClass } from "../button-style";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { ACADEMIC } from "@/lib/permissions";
import { getTeachingScope, getAssessmentList, getTermsForPicker } from "@/lib/assessment-data";
import { getCurrentTerm } from "@/lib/fee-data";
import { PageHeader, Card, StatusBadge, filterClass } from "../ui";
import { DataTable, Row, type Column } from "../primitives";
import { NewAssessment } from "./new-assessment";

export const metadata: Metadata = { title: "Assessments · School OS" };

const COLUMNS: Column[] = [
  { label: "" },
  { label: "Title" },
  { label: "Class" },
  { label: "Subject" },
  { label: "Type" },
  { label: "Max", numeric: true },
  { label: "Weight", numeric: true },
  { label: "Scored", numeric: true },
];

const TYPE_LABEL: Record<string, string> = {
  CLASS_EXERCISE: "Exercise",
  CLASS_TEST: "Class test",
  HOMEWORK: "Homework",
  PROJECT: "Project",
  MIDTERM_EXAM: "Mid-term",
  END_OF_TERM_EXAM: "End of term",
};

export default async function AssessmentsPage({ searchParams }: PageProps<"/assessments">) {
  const auth = await requireRole(ACADEMIC);
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
          scope.seesWholeSchool
            ? `${assessments.length} across the school`
            : `${assessments.length} for your classes`
        }
        action={
          scope.canRecord ? (
            <NewAssessment
              classGroups={scope.classGroups}
              subjects={scope.subjects}
              terms={terms}
              currentTermId={currentTerm?.id}
              defaultOpen={params.new === "1"}
            />
          ) : (
            // Seeing every class's assessments is not permission to create
            // one: that needs MARK_ANY_CLASS. Said plainly rather than just
            // leaving the button off, which reads as "not loaded yet" more
            // than "not for you."
            <span className="rounded-full border border-hairline bg-surface px-3 py-1.5 text-xs font-semibold text-slate-500">
              View only
            </span>
          )
        }
      />

      <form className="flex flex-wrap items-end gap-2 rounded-card border border-hairline bg-surface p-3">
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
          className={buttonClass("secondary")}
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
          <DataTable
            columns={COLUMNS}
            empty={{ icon: ClipboardCheck, title: "No assessments for this term yet. The mark sheet creates the standard set when you open it.", action: undefined }}
          >
            {assessments.map((assessment) => (
                  <Row key={assessment.id}>
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
                  </Row>
                ))
              }
          </DataTable>
        </div>
      </Card>
    </div>
  );
}
