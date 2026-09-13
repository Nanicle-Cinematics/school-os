import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { getStaffList } from "@/lib/staff-data";
import { PageHeader, filterClass } from "../ui";
import { Briefcase } from "lucide-react";
import { DataTable, Row, type Column } from "../primitives";
import { NewStaffForm } from "./staff-form";

export const metadata: Metadata = { title: "Staff · School OS" };

const COLUMNS: Column[] = [
  { label: "Staff no." },
  { label: "Name" },
  { label: "Designation" },
  { label: "Form class" },
  { label: "Subjects taught" },
  { label: "Status" },
];

const STATUS_TONE: Record<string, string> = {
  ACTIVE: "bg-green-50 text-green-700",
  ON_LEAVE: "bg-amber-50 text-amber-700",
  SUSPENDED: "bg-red-50 text-red-700",
  RESIGNED: "bg-slate-100 text-slate-500",
  RETIRED: "bg-slate-100 text-slate-500",
};

export default async function StaffPage({ searchParams }: PageProps<"/staff">) {
  await requireRole(OFFICE);
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q.trim() : "";
  const includeFormer = params.former === "1";
  const { staff, total } = await getStaffList(query, includeFormer);

  const teaching = staff.filter((person) => person.isTeaching).length;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Staff"
        subtitle={`${total} on the books · ${teaching} teaching`}
        action={<NewStaffForm />}
      />

      <form className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Name, staff no. or designation"
          className={`${filterClass} w-64`}
        />
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            name="former"
            value="1"
            defaultChecked={includeFormer}
            className="h-4 w-4"
          />
          Include former staff
        </label>
        <button
          type="submit"
          className="whitespace-nowrap rounded-card border border-hairline bg-surface px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          Apply
        </button>
      </form>
          <DataTable
            columns={COLUMNS}
            empty={{ icon: Briefcase, title: "No staff on file yet. Add a teacher or an administrator to get started.", action: { label: "Add staff", href: "/staff" } }}
          >
            {staff.map((person) => (
                  <Row key={person.id}>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-slate-500">
                      {person.staffNo}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-medium text-slate-900">
                      <Link href={`/staff/${person.id}`} className="hover:underline">
                        {person.lastName}, {person.firstName}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                      {person.designation ?? (person.isTeaching ? "Teacher" : "—")}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                      {person.formClasses.length === 0
                        ? "—"
                        : person.formClasses
                            .map((group) => `${group.level.name} ${group.name}`)
                            .join(", ")}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-slate-600">
                      {person._count.teachingAssignments}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                          STATUS_TONE[person.status] ?? "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {person.status.replace(/_/g, " ").toLowerCase()}
                      </span>
                    </td>
                  </Row>
                ))
              }
          </DataTable>
    </div>
  );
}
