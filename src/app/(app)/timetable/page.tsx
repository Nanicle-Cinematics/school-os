import type { Metadata } from "next";
import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { TIMETABLE_EDIT, TIMETABLE_VIEW, canAccess, isTeacherOnly } from "@/lib/permissions";
import {
  getClassOptions,
  getClassTimetable,
  getPeriods,
  getSchoolClashes,
  getTeacherOptions,
  getTeacherWeek,
} from "@/lib/timetable-data";
import { weekdayLabel } from "@/lib/timetable-rules";
import { PageHeader, Card, filterClass } from "../ui";
import { EmptyState } from "../primitives";
import { PrintButton } from "../print-button";
import { ClassGrid } from "./class-grid";
import { StandardDayButton } from "./periods-form";
import { WeekGrid } from "./week-grid";

export const metadata: Metadata = { title: "Timetable · School OS" };
export const dynamic = "force-dynamic";

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

export default async function TimetablePage({ searchParams }: PageProps<"/timetable">) {
  const auth = await requireRole(TIMETABLE_VIEW);
  const query = await searchParams;
  const canEdit = canAccess(auth.roles, TIMETABLE_EDIT);
  const teacherOnly = isTeacherOnly(auth.roles);
  const periods = await getPeriods();

  if (periods.length === 0) {
    return (
      <div className="mx-auto max-w-4xl space-y-5">
        <PageHeader title="Timetable" subtitle="Who teaches what, and when." />
        <Card>
          <EmptyState
            icon={CalendarClock}
            title={
              canEdit
                ? "The school day has not been set up yet. Start from the standard day and change the times to match yours."
                : "The head teacher has not set up the school day yet."
            }
          />
          {canEdit ? (
            <div className="flex flex-col items-center gap-2 pb-8">
              <StandardDayButton />
              <Link href="/timetable/periods" className="text-sm font-semibold text-brand-ink underline-offset-2 hover:underline">
                Or set the periods yourself
              </Link>
            </div>
          ) : null}
        </Card>
      </div>
    );
  }

  // A teacher-only login sees their own week and nothing else. The staff id is
  // the SESSION's: a teacher cannot ask for a colleague's by putting one in the URL.
  if (teacherOnly) {
    const week = auth.staffId ? await getTeacherWeek(auth.staffId) : null;
    return (
      <div className="mx-auto max-w-5xl space-y-5">
        <PageHeader title="My timetable" subtitle={week?.year ? `${week.year.name}` : "Your week"} action={<PrintButton />} />
        {!auth.staffId ? (
          <Notice tone="info">Your login is not linked to a staff record, so there is no timetable to show. Ask the office.</Notice>
        ) : (week?.cells.length ?? 0) === 0 ? (
          <Notice tone="info">
            Nothing is on your timetable yet. It appears here once the head teacher has placed lessons for the classes you
            are assigned to.
          </Notice>
        ) : null}
        <Card>
          <WeekGrid periods={periods} cells={week?.cells ?? []} />
        </Card>
      </div>
    );
  }

  const view = query.view === "teacher" ? "teacher" : "class";
  const clashes = canEdit ? await getSchoolClashes() : [];

  const tabs = (
    <nav className="flex gap-1 print:hidden" aria-label="Timetable views">
      {[
        { href: "/timetable", label: "By class", on: view === "class" },
        { href: "/timetable?view=teacher", label: "By teacher", on: view === "teacher" },
      ].map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={tab.on ? "page" : undefined}
          className={`rounded-full px-3.5 py-1.5 text-sm font-semibold ${
            tab.on ? "bg-brand-600 text-white" : "border border-hairline text-slate-600 hover:bg-slate-50"
          }`}
        >
          {tab.label}
        </Link>
      ))}
      {canEdit ? (
        <Link
          href="/timetable/periods"
          className="ml-auto rounded-full border border-hairline px-3.5 py-1.5 text-sm font-semibold text-slate-600 hover:bg-slate-50"
        >
          School day
        </Link>
      ) : null}
    </nav>
  );

  const clashBanner =
    clashes.length > 0 ? (
      <Notice tone="warning">
        <strong>
          {clashes.length} teacher{clashes.length === 1 ? " is" : "s are"} in two classes at once.
        </strong>{" "}
        {clashes
          .slice(0, 3)
          .map((c) => `${c.teacher}, ${weekdayLabel(c.weekday)} ${c.period}: ${c.classes.join(" and ")}`)
          .join(". ")}
        {clashes.length > 3 ? `, and ${clashes.length - 3} more` : ""}. Change one of the lessons, or the teaching
        assignment, to fix it.
      </Notice>
    ) : null;

  if (view === "teacher") {
    const options = await getTeacherOptions();
    const wanted = typeof query.staff === "string" ? query.staff : "";
    const staffId = options.find((t) => t.id === wanted)?.id ?? options[0]?.id ?? "";
    const week = staffId ? await getTeacherWeek(staffId) : null;
    const name = options.find((t) => t.id === staffId)?.name ?? "";

    return (
      <div className="mx-auto max-w-5xl space-y-5">
        <PageHeader title="Timetable" subtitle={week?.year?.name ?? "By teacher"} action={<PrintButton />} />
        {tabs}
        {clashBanner}
        {options.length === 0 ? (
          <Notice tone="info">
            No teacher has a class and subject assigned this year yet, so there is no week to show. Assign them on each
            class&rsquo;s page under Classes.
          </Notice>
        ) : (
          <>
            <Card title="Which teacher?">
              <form method="get" className="flex flex-wrap items-end gap-3 p-4 print:hidden">
                <input type="hidden" name="view" value="teacher" />
                <label className="text-sm">
                  <span className="mb-1 block font-semibold text-slate-700">Teacher</span>
                  <select name="staff" defaultValue={staffId} className={`${filterClass} w-64`}>
                    {options.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="submit"
                  className="rounded-full border border-hairline bg-surface px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-card transition hover:bg-slate-50"
                >
                  Show
                </button>
              </form>
            </Card>
            <Card title={name ? `${name} · ${week?.classes ?? 0} class${week?.classes === 1 ? "" : "es"}` : undefined}>
              <WeekGrid periods={periods} cells={week?.cells ?? []} />
            </Card>
          </>
        )}
      </div>
    );
  }

  const classes = await getClassOptions();
  const wanted = typeof query.class === "string" ? query.class : "";
  const classGroupId = classes.find((c) => c.id === wanted)?.id ?? classes[0]?.id ?? "";
  const data = classGroupId ? await getClassTimetable(classGroupId) : null;
  const heading = classes.find((c) => c.id === classGroupId)?.label ?? "";

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Timetable"
        subtitle={data?.year ? `${data.year.name} · ${canEdit ? "choose a subject in a cell to place a lesson" : "read only"}` : "By class"}
        action={<PrintButton />}
      />
      {tabs}
      {clashBanner}

      {classes.length === 0 ? (
        <Notice tone="info">
          There are no classes yet.{" "}
          <Link href="/classes" className="font-semibold underline underline-offset-2">
            Create a class
          </Link>{" "}
          first.
        </Notice>
      ) : (
        <>
          <Card title="Which class?">
            <form method="get" className="flex flex-wrap items-end gap-3 p-4 print:hidden">
              <label className="text-sm">
                <span className="mb-1 block font-semibold text-slate-700">Class</span>
                <select name="class" defaultValue={classGroupId} className={`${filterClass} w-52`}>
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                className="rounded-full border border-hairline bg-surface px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-card transition hover:bg-slate-50"
              >
                Show
              </button>
            </form>
          </Card>

          {!data?.year ? (
            <Notice tone="warning">
              There is no current academic year, so there is nowhere to put a timetable. Set one under{" "}
              <Link href="/settings/terms" className="font-semibold underline underline-offset-2">
                Settings → Terms
              </Link>
              .
            </Notice>
          ) : (
            <Card title={heading}>
              <ClassGrid
                key={data.cells.map((c) => `${c.weekday}${c.periodId}${c.subjectId}`).join("|")}
                classGroupId={classGroupId}
                periods={periods}
                subjects={data.subjects}
                cells={data.cells}
                editable={canEdit}
              />
              <p className="border-t border-hairline px-4 py-3 text-xs text-slate-500">
                <span className="font-semibold text-slate-700">Lessons a week: </span>
                {data.subjects.length === 0
                  ? "this class's level offers no subjects yet."
                  : data.subjects.map((s) => `${s.name} ${data.counts.get(s.id) ?? 0}`).join(" · ")}
              </p>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
