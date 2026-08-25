import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { OFFICE, canAccess } from "@/lib/permissions";
import { getStudentFormOptions, getStudentList } from "@/lib/student-data";
import { EmptyRow, PageHeader, inputClass, tableHeadClass, thClass } from "../ui";
import { AdmitStudentForm } from "./student-form";

export const metadata: Metadata = { title: "Students · School OS" };

const STATUS_TONE: Record<string, string> = {
  ACTIVE: "bg-green-50 text-green-700",
  APPLICANT: "bg-blue-50 text-blue-700",
  ADMITTED: "bg-blue-50 text-blue-700",
  SUSPENDED: "bg-amber-50 text-amber-700",
  WITHDRAWN: "bg-slate-100 text-slate-500",
  TRANSFERRED: "bg-slate-100 text-slate-500",
  GRADUATED: "bg-slate-100 text-slate-500",
};

const STATUSES = [
  "ACTIVE",
  "APPLICANT",
  "ADMITTED",
  "SUSPENDED",
  "WITHDRAWN",
  "TRANSFERRED",
  "GRADUATED",
];

export default async function StudentsPage({ searchParams }: PageProps<"/students">) {
  const auth = await requireRole([...OFFICE, "TEACHER"]);
  const params = await searchParams;

  const query = typeof params.q === "string" ? params.q.trim() : "";
  const classGroupId = typeof params.class === "string" ? params.class : "";
  const status = typeof params.status === "string" ? params.status : "";
  const page = Number(params.page) > 0 ? Number(params.page) : 1;

  const { students, matching, total, pageCount } = await getStudentList({
    q: query,
    classGroupId,
    status,
    page,
  });
  const { classGroups, houses, programmes } = await getStudentFormOptions();
  const canEdit = canAccess(auth.roles, OFFICE);

  const filtered = Boolean(query || classGroupId || status);
  // Carried into the paging links so a page change keeps the filters.
  const carry = new URLSearchParams();
  if (query) carry.set("q", query);
  if (classGroupId) carry.set("class", classGroupId);
  if (status) carry.set("status", status);

  const pageHref = (target: number) => {
    const next = new URLSearchParams(carry);
    next.set("page", String(target));
    return `/students?${next.toString()}`;
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Students"
        subtitle={filtered ? `${matching} of ${total} on roll` : `${total} on roll`}
        action={
          canEdit ? (
            <div className="flex items-center gap-2">
              <Link
                href="/students/import"
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              >
                Import
              </Link>
              <AdmitStudentForm
                classGroups={classGroups}
                houses={houses}
                programmes={programmes}
              />
            </div>
          ) : undefined
        }
      />

      <form className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Name or admission no."
          className={`${inputClass} w-56`}
        />
        <select name="class" defaultValue={classGroupId} className={`${inputClass} w-44`}>
          <option value="">All classes</option>
          {classGroups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.level.name} {group.name}
            </option>
          ))}
        </select>
        <select name="status" defaultValue={status} className={`${inputClass} w-36`}>
          <option value="">All statuses</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {value.toLowerCase()}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="whitespace-nowrap rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
        >
          Filter
        </button>
        {filtered ? (
          <Link href="/students" className="text-sm text-slate-500 hover:text-slate-900">
            Clear
          </Link>
        ) : null}
      </form>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className={tableHeadClass}>
              <tr>
                <th className={thClass}>Admission no.</th>
                <th className={thClass}>Name</th>
                <th className={thClass}>Class</th>
                <th className={thClass}>House</th>
                <th className={thClass}>Primary guardian</th>
                <th className={thClass}>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {students.length === 0 ? (
                <EmptyRow colSpan={6}>No students found.</EmptyRow>
              ) : (
                students.map((student) => {
                  const guardian = student.guardians[0]?.guardian;
                  return (
                    <tr key={student.id} className="hover:bg-slate-50">
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-slate-500">
                        {student.admissionNo}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 font-medium text-slate-900">
                        <Link href={`/students/${student.id}`} className="hover:underline">
                          {student.lastName}, {student.firstName}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                        {student.currentClassGroup
                          ? `${student.currentClassGroup.level.name} ${student.currentClassGroup.name}`
                          : "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                        {student.house?.name ?? "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                        {guardian ? (
                          <>
                            {guardian.firstName} {guardian.lastName}
                            <span className="ml-2 text-xs text-slate-400">{guardian.phone}</span>
                          </>
                        ) : (
                          <span className="text-amber-600">none</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        <span
                          className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                            STATUS_TONE[student.status] ?? "bg-slate-100 text-slate-500"
                          }`}
                        >
                          {student.status.toLowerCase()}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {pageCount > 1 ? (
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500">
            Page {page} of {pageCount}
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Link
                href={pageHref(page - 1)}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
              >
                Previous
              </Link>
            ) : null}
            {page < pageCount ? (
              <Link
                href={pageHref(page + 1)}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
              >
                Next
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
