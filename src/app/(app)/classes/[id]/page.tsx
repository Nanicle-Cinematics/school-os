import type { Metadata } from "next";
import { Users } from "lucide-react";
import { DataTable, Row, type Column } from "../../primitives";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { getClassGroup } from "@/lib/class-data";
import { deleteClassGroup } from "@/lib/class-actions";
import { Alert, Card } from "../../ui";
import { SubmitButton } from "../../submit-button";
import { EditClassForm } from "../class-form";
import { AssignmentsForm } from "./assignments-form";

const COLUMNS: Column[] = [
  { label: "Admission no." },
  { label: "Name" },
  { label: "Gender" },
  { label: "Enrolment" },
];

// The register view drops the gender column: the section already says it, and
// a running number in its place matches how a paper class register is ruled.
const REGISTER_COLUMNS: Column[] = [
  { label: "No." },
  { label: "Admission no." },
  { label: "Name" },
  { label: "Enrolment" },
];

type RosterEntry = Awaited<ReturnType<typeof getClassGroup>> extends infer R
  ? R extends { roster: (infer E)[] }
    ? E
    : never
  : never;

function RosterCells({ enrollment }: { enrollment: RosterEntry }) {
  return (
    <>
      <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-slate-500">
        {enrollment.student.admissionNo}
      </td>
      <td className="whitespace-nowrap px-4 py-2 font-medium text-slate-900">
        <Link href={`/students/${enrollment.student.id}`} className="hover:underline">
          {enrollment.student.lastName}, {enrollment.student.firstName}
        </Link>
      </td>
    </>
  );
}

function EnrolmentCell({ enrollment }: { enrollment: RosterEntry }) {
  return (
    <td className="whitespace-nowrap px-4 py-2 text-slate-600">
      {enrollment.status.toLowerCase()}
    </td>
  );
}

/** A "Boys (12)" band across the table, then the section's rows numbered from 1. */
function RegisterSection({
  label,
  rows,
}: {
  label: string;
  rows: RosterEntry[];
}) {
  return (
    <>
      <tr className="border-y border-hairline bg-slate-50">
        <th
          scope="rowgroup"
          colSpan={REGISTER_COLUMNS.length}
          className="px-4 py-2 text-left text-xs font-bold uppercase tracking-wide text-slate-600"
        >
          {label} ({rows.length})
        </th>
      </tr>
      {rows.length === 0 ? (
        <tr>
          <td colSpan={REGISTER_COLUMNS.length} className="px-4 py-3 text-sm text-slate-400">
            None
          </td>
        </tr>
      ) : (
        rows.map((enrollment, index) => (
          <Row key={enrollment.id}>
            <td className="whitespace-nowrap px-4 py-2 tabular-nums text-slate-500">
              {index + 1}
            </td>
            <RosterCells enrollment={enrollment} />
            <EnrolmentCell enrollment={enrollment} />
          </Row>
        ))
      )}
    </>
  );
}

const VIEWS = [
  { key: "list", label: "A–Z" },
  { key: "register", label: "Boys / Girls" },
] as const;

function ViewToggle({ classId, view }: { classId: string; view: string }) {
  return (
    <div
      role="group"
      aria-label="Roster layout"
      className="flex overflow-hidden rounded-card border border-hairline text-xs font-semibold"
    >
      {VIEWS.map((option) => {
        const active = option.key === view;
        return (
          <Link
            key={option.key}
            href={option.key === "list" ? `/classes/${classId}` : `/classes/${classId}?view=${option.key}`}
            aria-current={active ? "true" : undefined}
            className={`px-3 py-1.5 transition ${
              active ? "bg-slate-900 text-white" : "bg-surface text-slate-600 hover:bg-slate-50"
            }`}
          >
            {option.label}
          </Link>
        );
      })}
    </div>
  );
}

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

  const view = query.view === "register" ? "register" : "list";
  // Roster arrives sorted by surname, so each section keeps that order.
  const boys = roster.filter((e) => e.student.gender === "MALE");
  const girls = roster.filter((e) => e.student.gender === "FEMALE");

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

      <Card
        title={year ? `Roster · ${year.name}` : "Roster"}
        action={<ViewToggle classId={classGroup.id} view={view} />}
      >
        <div className="overflow-x-auto">
          {view === "register" ? (
            <DataTable
              columns={REGISTER_COLUMNS}
              empty={{ icon: Users, title: "No pupils placed in this class yet.", action: undefined }}
            >
              {roster.length > 0 ? (
                <>
                  <RegisterSection label="Boys" rows={boys} />
                  <RegisterSection label="Girls" rows={girls} />
                  <tr className="border-t border-hairline bg-slate-50">
                    <td
                      colSpan={REGISTER_COLUMNS.length}
                      className="px-4 py-2 text-xs font-semibold text-slate-600"
                    >
                      Total {roster.length} · {boys.length} boys · {girls.length} girls
                    </td>
                  </tr>
                </>
              ) : null}
            </DataTable>
          ) : (
            <DataTable
              columns={COLUMNS}
              empty={{ icon: Users, title: "No pupils placed in this class yet.", action: undefined }}
            >
              {roster.map((enrollment) => (
                <Row key={enrollment.id}>
                  <RosterCells enrollment={enrollment} />
                  <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                    {enrollment.student.gender.toLowerCase()}
                  </td>
                  <EnrolmentCell enrollment={enrollment} />
                </Row>
              ))}
            </DataTable>
          )}
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
