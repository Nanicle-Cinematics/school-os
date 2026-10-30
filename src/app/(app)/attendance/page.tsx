import type { Metadata } from "next";
import Link from "next/link";
import { CalendarCheck } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { ATTENDANCE, LEADERSHIP, OFFICE, canAccess } from "@/lib/permissions";
import {
  getAttendanceSummary,
  getRegister,
  getRegisterSetup,
  parseDay,
  termForDate,
  today,
} from "@/lib/attendance-data";
import { deleteRegister } from "@/lib/attendance-actions";
import { PageHeader, Card, filterClass } from "../ui";
import { DataTable, Row, type Column } from "../primitives";
import { RegisterForm } from "./register-form";

export const metadata: Metadata = { title: "Attendance · School OS" };

const TERM_NAME: Record<string, string> = { FIRST: "First", SECOND: "Second", THIRD: "Third" };

/** Sheds the three breakdown columns on a phone rather than scrolling sideways:
 *  a form teacher checking one child wants the name and the percentage. */
const SUMMARY_COLUMNS: Column[] = [
  { label: "Student" },
  { label: "Present", numeric: true },
  { label: "Late", numeric: true, hideBelow: "sm" },
  { label: "Excused", numeric: true, hideBelow: "sm" },
  { label: "Absent", numeric: true, hideBelow: "sm" },
  { label: "Attendance", numeric: true },
];

/**
 * A standing note about the state of the page, not the result of an action.
 *
 * `Alert` carries error and success because it reports what a form just did,
 * and it has `role="alert"` to say so. These three say what is true before
 * anybody presses anything — announcing them as alerts would make a screen
 * reader interrupt itself on load.
 */
function Notice({ tone, children }: { tone: "info" | "warning"; children: React.ReactNode }) {
  return (
    <p
      className={`rounded-control px-3.5 py-2.5 text-sm ${
        tone === "warning" ? "bg-warning-tint text-warning-ink" : "bg-info-tint text-info-ink"
      }`}
    >
      {children}
    </p>
  );
}

export default async function AttendancePage({ searchParams }: PageProps<"/attendance">) {
  const auth = await requireRole(ATTENDANCE);
  const query = await searchParams;
  const isOffice = canAccess(auth.roles, OFFICE);
  const isLeadership = canAccess(auth.roles, LEADERSHIP);

  const { year, classGroups } = await getRegisterSetup({
    staffId: auth.staffId,
    teacherOnly: !isOffice,
  });

  const dateValue = typeof query.date === "string" && parseDay(query.date) ? query.date : today();
  const date = parseDay(dateValue)!;

  // A teacher with exactly one class should not have to choose it every
  // morning — the commonest case is a form teacher and their own class.
  const requested = typeof query.class === "string" ? query.class : "";
  const classGroupId =
    classGroups.find((group) => group.id === requested)?.id ??
    (classGroups.length === 1 ? classGroups[0].id : "");

  const term = await termForDate(date);
  const register =
    classGroupId && year ? await getRegister(classGroupId, date, year.id) : null;
  const summary =
    classGroupId && term ? await getAttendanceSummary(term.id, classGroupId) : null;

  const heading = register
    ? `${register.classGroup.level.name} ${register.classGroup.name}`
    : "Attendance";

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title="Attendance"
        subtitle={
          term
            ? `${TERM_NAME[term.name] ?? term.name} Term, ${term.academicYear.name}`
            : "The daily register, one class at a time."
        }
      />

      <Card title="Which register?">
        <form method="get" className="flex flex-wrap items-end gap-3 p-4">
          <label className="text-sm">
            <span className="mb-1 block font-semibold text-slate-700">Class</span>
            <select name="class" defaultValue={classGroupId} className={`${filterClass} w-52`}>
              <option value="">Choose a class</option>
              {classGroups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.level.name} {group.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-semibold text-slate-700">Day</span>
            <input type="date" name="date" defaultValue={dateValue} className={`${filterClass} w-44`} />
          </label>
          <button
            type="submit"
            className="rounded-full border border-hairline bg-surface px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-card transition hover:bg-slate-50"
          >
            Open
          </button>
        </form>
      </Card>

      {classGroups.length === 0 ? (
        <Notice tone="info">
          {isOffice ? (
            <>
              There are no classes yet, so there is no register to take.{" "}
              <Link href="/classes" className="font-semibold underline underline-offset-2">
                Create a class
              </Link>{" "}
              first.
            </>
          ) : (
            <>
              You are not the form teacher of any class, so there is no register for you to take.
              A register is taken by its class&rsquo;s form teacher; the office sets the form
              teacher on the class&rsquo;s page under Classes.
            </>
          )}
        </Notice>
      ) : null}

      {!term && classGroupId ? (
        <Notice tone="warning">
          {dateValue} is not inside any term, so a register taken then would have nowhere to be
          counted. Check the date, or set the term dates under Settings → Terms.
        </Notice>
      ) : null}

      {register && term ? (
        <>
          <Card
            title={`${heading} · ${new Date(dateValue).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}`}
            action={
              register.taken && isLeadership ? (
                <form action={deleteRegister}>
                  <input type="hidden" name="classGroupId" value={classGroupId} />
                  <input type="hidden" name="date" value={dateValue} />
                  <button
                    type="submit"
                    className="text-sm font-semibold text-danger-ink underline-offset-2 hover:underline"
                  >
                    Remove this day
                  </button>
                </form>
              ) : undefined
            }
          >
            {register.rows.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">Nobody is enrolled in this class this year.</p>
            ) : (
              <>
                {register.taken ? (
                  <p className="border-b border-hairline bg-slate-50 px-4 py-2 text-xs text-slate-500">
                    Taken
                    {register.takenBy
                      ? ` by ${register.takenBy.firstName} ${register.takenBy.lastName}`
                      : ""}
                    {register.takenAt ? ` · last changed ${register.takenAt.toLocaleString("en-GB")}` : ""}
                  </p>
                ) : null}
                <RegisterForm
                  classGroupId={classGroupId}
                  classLabel={heading}
                  who={{ userId: auth.userId, schoolId: auth.schoolId }}
                  date={dateValue}
                  taken={register.taken}
                  boys={register.boys.map((row) => ({
                    studentId: row.studentId,
                    admissionNo: row.admissionNo,
                    name: `${row.lastName}, ${row.firstName}`,
                    mark: row.mark,
                    note: row.note,
                  }))}
                  girls={register.girls.map((row) => ({
                    studentId: row.studentId,
                    admissionNo: row.admissionNo,
                    name: `${row.lastName}, ${row.firstName}`,
                    mark: row.mark,
                    note: row.note,
                  }))}
                />
              </>
            )}
          </Card>

          <Card
            title={`This term so far · ${summary?.days.length ?? 0} day${
              summary?.days.length === 1 ? "" : "s"
            } taken`}
          >
            <DataTable
              columns={SUMMARY_COLUMNS}
              empty={{
                icon: CalendarCheck,
                title: "No register has been taken for this class this term yet.",
                action: undefined,
              }}
            >
              {(summary?.rows ?? []).map((row) => (
                <Row key={row.studentId}>
                  <td className="whitespace-nowrap px-4 py-2.5 font-medium text-slate-900">
                    {row.name}
                    <span className="ml-2 font-mono text-caption text-slate-400">
                      {row.admissionNo}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">
                    {row.present}
                  </td>
                  <td className="hidden px-4 py-2.5 text-right tabular-nums text-slate-600 sm:table-cell">
                    {row.late}
                  </td>
                  <td className="hidden px-4 py-2.5 text-right tabular-nums text-slate-600 sm:table-cell">
                    {row.excused}
                  </td>
                  <td className="hidden px-4 py-2.5 text-right tabular-nums text-slate-600 sm:table-cell">
                    {row.absent}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right font-semibold tabular-nums text-slate-900">
                    {row.percent === null ? "—" : `${row.percent.toFixed(0)}%`}
                    <span className="ml-1 text-caption font-normal text-slate-400">
                      {row.present + row.late}/{row.days}
                    </span>
                  </td>
                </Row>
              ))}
            </DataTable>
            <p className="border-t border-hairline px-4 py-3 text-xs text-slate-400">
              These totals go onto the report card as “{register.rows.length > 0 ? "days present" : "attendance"} of
              days taken”. A day nobody marked is not counted against anybody — the denominator is
              the days the register was actually taken, per child.
            </p>
          </Card>
        </>
      ) : null}

      {!classGroupId && classGroups.length > 0 ? (
        <Notice tone="info">Choose a class above to take its register.</Notice>
      ) : null}
    </div>
  );
}

export const dynamic = "force-dynamic";
