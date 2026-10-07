import Link from "next/link";
import type { getDeletedStudent } from "@/lib/student-data";
import { restoreStudent } from "@/lib/student-actions";
import { Alert, Card } from "../../ui";
import { SubmitButton } from "../../submit-button";

type Deleted = NonNullable<Awaited<ReturnType<typeof getDeletedStudent>>>;

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" });

/**
 * What a deleted pupil's link opens: who they were, when they were removed, and
 * a way back. Read-only otherwise — a deleted record is not edited, it is
 * either left alone or restored.
 */
export function DeletedStudent({ data }: { data: Deleted }) {
  const { student, deletedBy, enrolments, namesakes } = data;
  const deletedAt = student.deletedAt as Date;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <Link href="/students" className="text-sm text-slate-500 hover:text-slate-900">
          ← Students
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          {student.lastName}, {student.firstName} {student.middleName ?? ""}
        </h1>
        <p className="mt-0.5 text-sm text-slate-500">{student.admissionNo} · deleted</p>
      </div>

      <Alert tone="error">
        This pupil record was deleted on {dateFmt.format(deletedAt)}
        {deletedBy ? ` by ${deletedBy}` : ""}. It no longer appears on registers, mark sheets,
        results or bills. If it was the real pupil rather than a duplicate, restore it below.
      </Alert>

      {namesakes.length > 0 ? (
        <Card title="Other records with this name">
          <ul className="divide-y divide-hairline text-sm">
            {namesakes.map((other) => (
              <li key={other.id} className="flex items-center justify-between gap-4 px-4 py-2.5">
                <Link href={`/students/${other.id}`} className="font-mono text-slate-900 hover:underline">
                  {other.admissionNo}
                </Link>
                <span className="text-slate-500">
                  added {dateFmt.format(other.createdAt)} ·{" "}
                  {other.deletedAt ? "also deleted" : "on file"}
                </span>
              </li>
            ))}
          </ul>
          {namesakes.every((other) => other.deletedAt) ? (
            <p className="border-t border-hairline px-4 py-2.5 text-sm text-slate-600">
              Every record with this name is deleted, so the pupil is missing from the school
              altogether. Restore the one with the correct admission number — normally the
              earlier one — and leave the duplicate deleted.
            </p>
          ) : null}
        </Card>
      ) : null}

      <Card title="Restore this record">
        <div className="space-y-3 px-4 py-4 text-sm text-slate-700">
          {enrolments.length > 0 ? (
            <p>
              Restoring puts the pupil back in{" "}
              {enrolments
                .map((e) => `${e.classGroup.level.name} ${e.classGroup.name} (${e.academicYear.name})`)
                .join(", ")}
              , as they were before the delete.
            </p>
          ) : (
            <p>
              The pupil had no class when they were deleted, so they come back unplaced. Enrol
              them in a class from their page afterwards.
            </p>
          )}
          <form action={restoreStudent}>
            <input type="hidden" name="studentId" value={student.id} />
            <SubmitButton pendingLabel="Restoring…">Restore {student.firstName}</SubmitButton>
          </form>
        </div>
      </Card>
    </div>
  );
}
