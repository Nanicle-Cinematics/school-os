import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { TIMETABLE_EDIT } from "@/lib/permissions";
import { getPeriodUse, getPeriods } from "@/lib/timetable-data";
import { PageHeader, Card } from "../../ui";
import { PeriodsForm, StandardDayButton } from "../periods-form";

export const metadata: Metadata = { title: "School day · Timetable · School OS" };
export const dynamic = "force-dynamic";

export default async function SchoolDayPage() {
  await requireRole(TIMETABLE_EDIT);
  const periods = await getPeriods();
  const use = await getPeriodUse();

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title="The school day"
        subtitle="The periods and breaks, the same every weekday. The timetable is built on these."
        action={
          <Link href="/timetable" className="text-sm font-semibold text-brand-ink underline-offset-2 hover:underline">
            Back to the timetable
          </Link>
        }
      />

      {periods.length === 0 ? (
        <Card title="No school day yet">
          <div className="space-y-3 p-4">
            <p className="text-sm text-slate-600">
              Start from the standard day (seven lessons and two breaks) and change the times to match yours, or add
              the periods one at a time below.
            </p>
            <StandardDayButton variant="secondary" />
          </div>
        </Card>
      ) : null}

      <Card title="Periods and breaks">
        <PeriodsForm
          key={periods.map((p) => `${p.id}${p.order}${p.label}${p.startTime}${p.endTime}${p.isBreak}`).join("|")}
          initial={periods.map((p) => ({
            id: p.id,
            label: p.label,
            startTime: p.startTime,
            endTime: p.endTime,
            isBreak: p.isBreak,
            lessons: use.get(p.id) ?? 0,
          }))}
        />
      </Card>

      <p className="text-xs text-slate-500">
        A period with lessons on the timetable cannot be removed or turned into a break: clear its lessons first. Times
        are on the school&rsquo;s own clock, as hours and minutes (08:30).
      </p>
    </div>
  );
}
