import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { getClassGroup } from "@/lib/class-data";
import { deleteClassGroup } from "@/lib/class-actions";
import { Alert, Card, EmptyRow, tableHeadClass, thClass } from "../../ui";
import { SubmitButton } from "../../submit-button";
import { EditClassForm } from "../class-form";
import { AssignmentsForm } from "./assignments-form";

export const metadata: Metadata = { title: "Class · School OS" };

export default async function ClassDetailPage({
  params,
  searchParams,
}: PageProps<"/classes/[id]">) {
  await requireRole(OFFICE);
  const { id } = await params;
  const query = await searchParams;
  const result = await getClassGroup(id);

  if (!result) {
    notFound();
  }

  const {
    classGroup,
    year,
    levels,
    teachers,
    roster,
    subjectRows,
    classTeacherLevel,
    previousYear,
    totalEnrollments,
  } = result;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <Link href="/classes" className="text-sm text-slate-500 hover:text-slate-900">
          ← Classes
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          {classGroup.level.name} {classGroup.name}
        </h1>
        <p className="mt-0.5 text-sm text-slate-500">
          {year ? `${roster.length} enrolled in ${year.name}` : "No current academic year"}
          {classGroup.formTeacher
            ? ` · form teacher ${classGroup.formTeacher.firstName} ${classGroup.formTeacher.lastName}`
            : ""}
        </p>
      </div>

      {query.error === "has-roster" ? (
        <Alert tone="error">
          This class holds {totalEnrollments} enrolment
          {totalEnrollments === 1 ? "" : "s"}, so it cannot be deleted — deleting it would take
          those records with it. Move the students to another class first.
        </Alert>
      ) : null}

      <Card title="Details">
        <EditClassForm
          levels={levels}
          teachers={teachers}
          values={{
            id: classGroup.id,
            levelId: classGroup.levelId,
            name: classGroup.name,
            capacity: classGroup.capacity,
            formTeacherId: classGroup.formTeacherId,
          }}
        />
      </Card>

      <Card title={year ? `Roster · ${year.name}` : "Roster"}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className={tableHeadClass}>
              <tr>
                <th className={thClass}>Admission no.</th>
                <th className={thClass}>Name</th>
                <th className={thClass}>Gender</th>
                <th className={thClass}>Enrolment</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {roster.length === 0 ? (
                <EmptyRow colSpan={4}>
                  Nobody is enrolled in this class for the current year.
                </EmptyRow>
              ) : (
                roster.map((enrollment) => (
                  <tr key={enrollment.id}>
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-slate-500">
                      {enrollment.student.admissionNo}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 font-medium text-slate-900">
                      <Link href={`/students/${enrollment.student.id}`} className="hover:underline">
                        {enrollment.student.lastName}, {enrollment.student.firstName}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                      {enrollment.student.gender.toLowerCase()}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                      {enrollment.status.toLowerCase()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Who teaches what here">
        {year ? (
          <AssignmentsForm
            classGroupId={classGroup.id}
            rows={subjectRows}
            teachers={teachers}
            previousYearName={previousYear?.name ?? null}
            classTeacherLevel={classTeacherLevel}
            formTeacherName={
              classGroup.formTeacher
                ? `${classGroup.formTeacher.firstName} ${classGroup.formTeacher.lastName}`
                : null
            }
          />
        ) : (
          <p className="px-4 py-6 text-sm text-slate-500">
            No academic year is marked current, and an assignment belongs to one.{" "}
            <Link href="/settings/terms" className="font-medium text-slate-900 underline">
              Add an academic year
            </Link>{" "}
            first.
          </p>
        )}
      </Card>

      <Card title="Danger zone">
        <form action={deleteClassGroup} className="flex flex-wrap items-center gap-3 p-4">
          <input type="hidden" name="id" value={classGroup.id} />
          <SubmitButton variant="danger" pendingLabel="Deleting…">
            Delete class
          </SubmitButton>
          <p className="text-xs text-slate-500">
            {totalEnrollments > 0
              ? `Blocked — ${totalEnrollments} enrolment${totalEnrollments === 1 ? "" : "s"} across all years.`
              : "Only possible while no student has ever been enrolled here."}
          </p>
        </form>
      </Card>
    </div>
  );
}
