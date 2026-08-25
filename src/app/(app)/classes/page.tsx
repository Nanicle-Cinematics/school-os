import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { getClassSetup } from "@/lib/class-data";
import { Alert, EmptyRow, PageHeader, tableHeadClass, thClass } from "../ui";
import { NewClassForm } from "./class-form";

export const metadata: Metadata = { title: "Classes · School OS" };

export default async function ClassesPage() {
  const auth = await requireRole([...OFFICE, "TEACHER"]);
  const { year, levels, classGroups, teachers } = await getClassSetup();
  const canEdit = OFFICE.some((role) => auth.roles.includes(role));

  const onRoll = classGroups.reduce((sum, group) => sum + group.enrolled, 0);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Classes"
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

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className={tableHeadClass}>
              <tr>
                <th className={thClass}>Class</th>
                <th className={thClass}>Level</th>
                <th className={thClass}>Form teacher</th>
                <th className={thClass}>Enrolled</th>
                <th className={thClass}>Capacity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {classGroups.length === 0 ? (
                <EmptyRow colSpan={5}>
                  No classes yet. Add one per stream — &ldquo;Basic 5 Gold&rdquo; is a level plus a
                  stream name.
                </EmptyRow>
              ) : (
                classGroups.map((group) => {
                  const over = group.capacity !== null && group.enrolled > group.capacity;
                  return (
                    <tr key={group.id} className="hover:bg-slate-50">
                      <td className="whitespace-nowrap px-4 py-2.5 font-medium text-slate-900">
                        {canEdit ? (
                          <Link href={`/classes/${group.id}`} className="hover:underline">
                            {group.level.name} {group.name}
                          </Link>
                        ) : (
                          `${group.level.name} ${group.name}`
                        )}
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
                          over ? "font-medium text-red-600" : "text-slate-600"
                        }`}
                      >
                        {group.enrolled}
                        {over ? " · over" : ""}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-slate-600">
                        {group.capacity ?? "—"}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
