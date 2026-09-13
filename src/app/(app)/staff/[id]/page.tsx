import type { Metadata } from "next";
import { BookOpen } from "lucide-react";
import { DataTable, Row, type Column } from "../../primitives";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { OFFICE, roleLabel } from "@/lib/permissions";
import { getStaffMember } from "@/lib/staff-data";
import { removeStaff, removeTeachingAssignment } from "@/lib/staff-actions";
import { Alert, Card } from "../../ui";
import { SubmitButton } from "../../submit-button";
import { EditStaffForm } from "../staff-form";
import { AssignmentForm } from "./assignment-form";

const COLUMNS: Column[] = [
  { label: "" },
  { label: "Subject" },
  { label: "Class" },
  { label: "" },
];

export const metadata: Metadata = { title: "Staff member · School OS" };

export default async function StaffDetailPage({ params, searchParams }: PageProps<"/staff/[id]">) {
  await requireRole(OFFICE);
  const { id } = await params;
  const query = await searchParams;
  const result = await getStaffMember(id);

  if (!result) {
    notFound();
  }

  const { staff, year, assignments, subjects, classGroups } = result;
  const blocked = staff._count.enteredScores > 0 || staff.formClasses.length > 0;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <Link href="/staff" className="text-sm text-slate-500 hover:text-slate-900">
          ← Staff
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          {staff.firstName} {staff.lastName}
        </h1>
        <p className="mt-0.5 text-sm text-slate-500">
          {staff.staffNo} · {staff.designation ?? (staff.isTeaching ? "Teacher" : "Non-teaching")}
          {staff.memberships.length > 0 ? (
            ` · ${staff.memberships.map((m) => roleLabel(m.role)).join(", ")}`
          ) : (
            <>
              {" · "}
              <Link href="/users" className="underline hover:text-slate-700">
                no login
              </Link>
            </>
          )}
        </p>
      </div>

      {query.error === "in-use" ? (
        <Alert tone="error">
          This member has entered scores or is a form teacher, so the record stays — a mark sheet
          has to keep naming who entered it. Set their status to Resigned or Retired instead.
        </Alert>
      ) : null}

      <Card title={year ? `Teaching assignments · ${year.name}` : "Teaching assignments"}>
        <div className="overflow-x-auto">
          <DataTable
            columns={COLUMNS}
            empty={{ icon: BookOpen, title: "Nothing assigned to this member of staff this year.", action: undefined }}
          >
            {assignments.map((assignment) => (
                  <Row key={assignment.id}>
                    <td className="whitespace-nowrap px-4 py-2 font-medium text-slate-900">
                      {assignment.subject.name}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                      {assignment.classGroup.level.name} {assignment.classGroup.name}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right">
                      <form action={removeTeachingAssignment}>
                        <input type="hidden" name="staffId" value={staff.id} />
                        <input type="hidden" name="assignmentId" value={assignment.id} />
                        <SubmitButton variant="secondary" pendingLabel="…">
                          Remove
                        </SubmitButton>
                      </form>
                    </td>
                  </Row>
                ))
              }
          </DataTable>
        </div>
        {year ? (
          <div className="border-t border-slate-100">
            <AssignmentForm staffId={staff.id} subjects={subjects} classGroups={classGroups} />
          </div>
        ) : null}
      </Card>

      <Card title="Details">
        <EditStaffForm
          values={{
            id: staff.id,
            firstName: staff.firstName,
            middleName: staff.middleName,
            lastName: staff.lastName,
            gender: staff.gender,
            phone: staff.phone,
            email: staff.email,
            address: staff.address,
            designation: staff.designation,
            qualification: staff.qualification,
            employmentType: staff.employmentType,
            isTeaching: staff.isTeaching,
            status: staff.status,
            dateOfBirth: staff.dateOfBirth,
            dateHired: staff.dateHired,
            ssnitNumber: staff.ssnitNumber,
            tin: staff.tin,
          }}
        />
      </Card>

      <Card title="Danger zone">
        <form action={removeStaff} className="flex flex-wrap items-center gap-3 p-4">
          <input type="hidden" name="id" value={staff.id} />
          <SubmitButton variant="danger" pendingLabel="Removing…">
            Remove from staff list
          </SubmitButton>
          <p className="text-xs text-slate-500">
            {blocked
              ? "Blocked — they have entered scores or hold a form class."
              : "Hides them from lists. Nothing is erased."}
          </p>
        </form>
      </Card>
    </div>
  );
}
