import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { canAccess, CLASS_REGISTER, OFFICE } from "@/lib/permissions";
import { getClassSetup } from "@/lib/class-data";
import { Alert, PageHeader } from "../ui";
import { GraduationCap } from "lucide-react";
import { DataTable, Row, type Column } from "../primitives";
import { NewClassForm } from "./class-form";

export const metadata: Metadata = { title: "Classes · School OS" };

const COLUMNS: Column[] = [
  { label: "Class" },
  { label: "Level" },
  { label: "Form teacher" },
  { label: "Enrolled", numeric: true },
  { label: "Capacity", numeric: true },
];

export default async function ClassesPage() {
  const auth = await requireRole(CLASS_REGISTER);
  const canEdit = canAccess(auth.roles, OFFICE);
  // A teacher sees their own classes only; the office sees the school.
  const { year, levels, classGroups, teachers } = await getClassSetup({
    staffId: auth.staffId,
    teacherOnly: !canEdit,
  });

  const onRoll = classGroups.reduce((sum, group) => sum + group.enrolled, 0);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title={canEdit ? "Classes" : "My classes"}
        subtitle={
          year
            ? `${classGroups.length} classes · ${onRoll} enrolled in ${year.name}`
            : `${classGroups.length} classes`
        }
        action={canEdit ? <NewClassForm levels={levels} teachers={teachers} /> : undefined}
      />

      {!year ? (
        <Alert tone="error">
          No academic year is marked current, so rosters cannot be counted. Set one in Settings.
        </Alert>
      ) : null}
          <DataTable
            columns={COLUMNS}
            empty={{
              icon: GraduationCap,
              title: canEdit
                ? "No classes yet. A class is a level plus a stream — Basic 1 A, JHS 2 B."
                : "You are not form teacher of a class, and have no subject assigned this year.",
              action: undefined,
            }}
          >
            {classGroups.map((group) => {
                  const over = group.capacity !== null && group.enrolled > group.capacity;
                  return (
                    <Row key={group.id}>
                      <td className="whitespace-nowrap px-4 py-2.5 font-medium text-slate-900">
                        <Link href={`/classes/${group.id}`} className="hover:underline">
                          {group.level.name} {group.name}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                        {group.level.code}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                        {group.formTeacher
                          ? `${group.formTeacher.firstName} ${group.formTeacher.lastName}`
                          : "—"}
                      </td>
                      <td
                        className={`whitespace-nowrap px-4 py-2.5 tabular-nums ${
                          over ? "font-medium text-danger-ink" : "text-slate-600"
                        }`}
                      >
                        {group.enrolled}
                        {over ? " · over" : ""}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-slate-600">
                        {group.capacity ?? "—"}
                      </td>
                    </Row>
                  );
                })
              }
          </DataTable>
    </div>
  );
}
