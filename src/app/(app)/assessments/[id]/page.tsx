import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { ACADEMIC, LEADERSHIP, MARK_ANY_CLASS, canAccess } from "@/lib/permissions";
import { getAssessmentForEntry } from "@/lib/assessment-data";
import { setAssessmentStatus, deleteAssessment } from "@/lib/assessment-actions";
import { StatusBadge } from "../../ui";
import { SubmitButton } from "../../submit-button";
import { ScoreGrid, type Row } from "./score-grid";

export const metadata: Metadata = { title: "Score entry · School OS" };

export default async function ScoreEntryPage({ params }: PageProps<"/assessments/[id]">) {
  const auth = await requireRole(ACADEMIC);
  const { id } = await params;
  const data = await getAssessmentForEntry(id);

  if (!data) {
    notFound();
  }

  const { assessment, rows } = data;
  // ⚠️ TWO questions, answered separately. `canRecord` (MARK_ANY_CLASS) is whether the
  // marks grid is editable: leadership and the IT admin, who keys in what teachers hand
  // over on paper. `isLeadership` is whether the buttons that CHANGE THE ASSESSMENT show:
  // submit, approve, send back, unlock and delete all require LEADERSHIP server-side, so
  // an IT admin who is shown one would only be redirected away on click. Hide what a role
  // cannot use, and read-only the grid for a role that cannot enter, rather than leaving
  // either to fail silently.
  const isLeadership = canAccess(auth.roles, LEADERSHIP);
  const canRecord = canAccess(auth.roles, MARK_ANY_CLASS);
  const readOnly = assessment.status === "APPROVED" || !canRecord;

  const gridRows: Row[] = rows.map((row) => ({
    studentId: row.student.id,
    admissionNo: row.student.admissionNo,
    name: `${row.student.lastName}, ${row.student.firstName}`,
    score: row.score?.rawScore ? String(Number(row.score.rawScore)) : "",
    isAbsent: row.score?.isAbsent ?? false,
  }));

  const marked = gridRows.filter((row) => row.score !== "" || row.isAbsent).length;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Link href="/assessments" className="text-sm text-slate-500 hover:text-slate-900">
        ← All assessments
      </Link>

      <div className="rounded-card border border-hairline bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">{assessment.title}</h1>
            <p className="mt-0.5 text-sm text-slate-500">
              {assessment.classGroup.level.name} {assessment.classGroup.name} ·{" "}
              {assessment.subject.name} · Term {assessment.term.sequence} ·{" "}
              {assessment.term.academicYear.name}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Out of {Number(assessment.maxScore)}
              {Number(assessment.weight) > 0 ? ` · weight ${Number(assessment.weight)}` : ""} ·{" "}
              {marked} of {gridRows.length} marked
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={assessment.status} />

            {assessment.status === "OPEN" && isLeadership ? (
              <form action={setAssessmentStatus}>
                <input type="hidden" name="assessmentId" value={assessment.id} />
                <input type="hidden" name="status" value="SUBMITTED" />
                <SubmitButton variant="secondary" pendingLabel="Submitting…">
                  Submit for review
                </SubmitButton>
              </form>
            ) : null}

            {assessment.status === "SUBMITTED" && isLeadership ? (
              <>
                <form action={setAssessmentStatus}>
                  <input type="hidden" name="assessmentId" value={assessment.id} />
                  <input type="hidden" name="status" value="APPROVED" />
                  <SubmitButton pendingLabel="Approving…">Approve</SubmitButton>
                </form>
                <form action={setAssessmentStatus}>
                  <input type="hidden" name="assessmentId" value={assessment.id} />
                  <input type="hidden" name="status" value="OPEN" />
                  <SubmitButton variant="secondary" pendingLabel="Reopening…">
                    Send back
                  </SubmitButton>
                </form>
              </>
            ) : null}

            {assessment.status === "APPROVED" && isLeadership ? (
              <form action={setAssessmentStatus}>
                <input type="hidden" name="assessmentId" value={assessment.id} />
                <input type="hidden" name="status" value="OPEN" />
                <SubmitButton variant="secondary" pendingLabel="Unlocking…">
                  Unlock for edits
                </SubmitButton>
              </form>
            ) : null}

            {assessment.status !== "APPROVED" && isLeadership ? (
              <form action={deleteAssessment}>
                <input type="hidden" name="assessmentId" value={assessment.id} />
                <SubmitButton variant="danger" pendingLabel="Deleting…">
                  Delete
                </SubmitButton>
              </form>
            ) : null}
          </div>
        </div>

        {readOnly ? (
          <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
            {assessment.status === "APPROVED"
              ? "These scores are approved and locked. A head or proprietor can unlock them for edits."
              : "You can view this sheet, but you cannot enter marks on it."}
          </p>
        ) : !isLeadership ? (
          <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
            You can enter and correct marks here. A head or proprietor submits, approves and
            deletes the assessment.
          </p>
        ) : null}
      </div>

      {gridRows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-surface p-8 text-center text-sm text-slate-500">
          No active enrolments in this class for the current academic year.
        </div>
      ) : (
        <ScoreGrid
          assessmentId={assessment.id}
          maxScore={Number(assessment.maxScore)}
          rows={gridRows}
          readOnly={readOnly}
        />
      )}
    </div>
  );
}
