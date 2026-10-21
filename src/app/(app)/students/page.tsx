import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { MERGE_PUPILS, OFFICE, canAccess } from "@/lib/permissions";
import { getStudentFormOptions, getStudentList } from "@/lib/student-data";
import { Users } from "lucide-react";
import { Avatar, PageHeader, StatusBadge, filterClass } from "../ui";
import { DataTable, Row, cellClass, type Column } from "../primitives";
import { AdmitStudentForm } from "./student-form";

export const metadata: Metadata = { title: "Students · School OS" };

const COLUMNS: Column[] = [
  { label: "Pupil" },
  { label: "Class" },
  { label: "House", hideBelow: "md" },
  { label: "Primary guardian", hideBelow: "lg" },
  { label: "Status", hideBelow: "sm" },
];

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
  const auth = await requireRole(OFFICE);
  const params = await searchParams;

  const query = typeof params.q === "string" ? params.q.trim() : "";
  const classGroupId = typeof params.class === "string" ? params.class : "";
  const status = typeof params.status === "string" ? params.status : "";
  const placement = params.placement === "none" ? "none" : "";
  const page = Number(params.page) > 0 ? Number(params.page) : 1;

  const { students, matching, total, pageCount } = await getStudentList({
    q: query,
    classGroupId,
    status,
    placement,
    page,
  });
  const { classGroups, houses, programmes } = await getStudentFormOptions();
  const canEdit = canAccess(auth.roles, OFFICE);
  const canMerge = canAccess(auth.roles, MERGE_PUPILS);

  const filtered = Boolean(query || classGroupId || status || placement);
  // Carried into the paging links so a page change keeps the filters.
  const carry = new URLSearchParams();
  if (query) carry.set("q", query);
  if (classGroupId) carry.set("class", classGroupId);
  if (status) carry.set("status", status);
  if (placement) carry.set("placement", placement);

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
              {canMerge ? (
                <Link
                  href="/students/duplicates"
                  className="rounded-card border border-hairline bg-surface px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                >
                  Find duplicates
                </Link>
              ) : null}
              <Link
                href="/students/enrolment-form"
                className="rounded-card border border-hairline bg-surface px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Blank form
              </Link>
              <Link
                href="/students/import"
                className="rounded-card border border-hairline bg-surface px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
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

      {placement ? (
        <p className="rounded-card border border-hairline bg-surface px-4 py-3 text-sm text-slate-700">
          Showing pupils on the roll with <strong>no class this year</strong>. Open one and use “Place in class”.{" "}
          <Link href="/students" className="font-semibold text-brand-ink hover:underline">
            Show everyone
          </Link>
        </p>
      ) : null}

      <form className="flex flex-wrap items-center gap-2">
        {placement ? <input type="hidden" name="placement" value={placement} /> : null}
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Name or admission no."
          className={`${filterClass} w-56`}
        />
        <select name="class" defaultValue={classGroupId} className={`${filterClass} w-44`}>
          <option value="">All classes</option>
          {classGroups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.level.name} {group.name}
            </option>
          ))}
        </select>
        <select name="status" defaultValue={status} className={`${filterClass} w-36`}>
          <option value="">All statuses</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {value.toLowerCase()}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="whitespace-nowrap rounded-card border border-hairline bg-surface px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          Filter
        </button>
        {filtered ? (
          <Link href="/students" className="text-sm text-slate-500 hover:text-slate-900">
            Clear
          </Link>
        ) : null}
      </form>

  <DataTable
        columns={COLUMNS}
        empty={{
          icon: Users,
          title: query
            ? `No pupil matches “${query}”. Try a surname or an admission number.`
            : "No pupils on the roll yet. Admit one, or import a whole class from a spreadsheet.",
          action: query ? undefined : { label: "Import a class", href: "/students/import" },
        }}
      >
        {students.map((student) => {
          const guardian = student.guardians[0]?.guardian;
          return (
            <Row key={student.id}>
              <td className={cellClass(COLUMNS[0])}>
                <Link href={`/students/${student.id}`} className="group flex items-center gap-3">
                  <Avatar firstName={student.firstName} lastName={student.lastName} />
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-slate-900 group-hover:underline">
                      {student.lastName}, {student.firstName}
                    </span>
                    <span className="block font-mono text-[11px] text-slate-400">
                      {student.admissionNo}
                    </span>
                  </span>
                </Link>
              </td>
              <td className={`${cellClass(COLUMNS[1])} whitespace-nowrap text-slate-600`}>
                {student.currentClassGroup
                  ? `${student.currentClassGroup.level.name} ${student.currentClassGroup.name}`
                  : "—"}
              </td>
              <td className={`${cellClass(COLUMNS[2])} whitespace-nowrap text-slate-600`}>
                {student.house?.name ?? "—"}
              </td>
              <td className={`${cellClass(COLUMNS[3])} text-slate-600`}>
                {guardian ? (
                  <>
                    {guardian.firstName} {guardian.lastName}
                    <span className="ml-2 text-xs text-slate-400">{guardian.phone}</span>
                  </>
                ) : (
                  /* A pupil with no guardian cannot be texted, invoiced or
                     sent a report card — that is a gap in the record, so it
                     takes the severity that means "this blocks work". */
                  <span className="text-warning-ink">None on file</span>
                )}
              </td>
              <td className={cellClass(COLUMNS[4])}>
                <StatusBadge status={student.status} />
              </td>
            </Row>
          );
        })}
  </DataTable>

      {pageCount > 1 ? (
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500">
            Page {page} of {pageCount}
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Link
                href={pageHref(page - 1)}
                className="rounded-lg border border-slate-200 bg-surface px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
              >
                Previous
              </Link>
            ) : null}
            {page < pageCount ? (
              <Link
                href={pageHref(page + 1)}
                className="rounded-lg border border-slate-200 bg-surface px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
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
