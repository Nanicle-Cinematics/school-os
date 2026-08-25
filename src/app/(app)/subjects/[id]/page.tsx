import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { getSubject } from "@/lib/subject-data";
import { deleteSubject } from "@/lib/subject-actions";
import { Alert, Card } from "../../ui";
import { SubmitButton } from "../../submit-button";
import { EditSubjectForm } from "./edit-subject";
import { LevelsForm } from "./levels-form";

export const metadata: Metadata = { title: "Subject · School OS" };

export default async function SubjectDetailPage({
  params,
  searchParams,
}: PageProps<"/subjects/[id]">) {
  await requireRole(OFFICE);
  const { id } = await params;
  const query = await searchParams;
  const result = await getSubject(id);

  if (!result) {
    notFound();
  }

  const { subject, rows } = result;
  const inUse = subject._count.assessments > 0 || subject._count.subjectResults > 0;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <Link href="/subjects" className="text-sm text-slate-500 hover:text-slate-900">
          ← Subjects
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">{subject.name}</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          {subject.code} · {subject._count.assessments} assessments ·{" "}
          {subject._count.teachingAssignments} teaching assignments
        </p>
      </div>

      {query.error === "in-use" ? (
        <Alert tone="error">
          {subject.name} already has assessments or published results, so it cannot be deleted.
          Remove it from every level instead — it then disappears from score entry while the old
          report cards stay intact.
        </Alert>
      ) : null}

      <Card title="Details">
        <EditSubjectForm subject={subject} />
      </Card>

      <Card title="Levels offering this subject">
        <LevelsForm subjectId={subject.id} rows={rows} />
      </Card>

      <Card title="Danger zone">
        <form action={deleteSubject} className="flex flex-wrap items-center gap-3 p-4">
          <input type="hidden" name="id" value={subject.id} />
          <SubmitButton variant="danger" pendingLabel="Deleting…">
            Delete subject
          </SubmitButton>
          <p className="text-xs text-slate-500">
            {inUse
              ? "Blocked — this subject has been assessed. Untick every level instead."
              : "Only possible while nothing has been assessed."}
          </p>
        </form>
      </Card>
    </div>
  );
}
