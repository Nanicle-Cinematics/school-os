import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { getPromotionPlan, getPromotionSetup, getWholeSchoolPlan } from "@/lib/promotion-data";
import { Alert, Card, PageHeader, filterClass } from "../ui";
import { PromotionForm } from "./promotion-form";
import { BulkPromotionForm } from "./bulk-form";

export const metadata: Metadata = { title: "Promotions · School OS" };

export default async function PromotionsPage({ searchParams }: PageProps<"/promotions">) {
  await requireRole(OFFICE);
  const params = await searchParams;

  const { years, classGroups } = await getPromotionSetup();
  const currentYear = years.find((year) => year.isCurrent);

  const classGroupId = typeof params.class === "string" ? params.class : "";
  const sourceYearId =
    typeof params.from === "string" && params.from ? params.from : (currentYear?.id ?? "");
  const targetYearId = typeof params.to === "string" ? params.to : "";

  const differentYears = Boolean(sourceYearId && targetYearId && sourceYearId !== targetYearId);

  const plan =
    classGroupId && differentYears
      ? await getPromotionPlan(classGroupId, sourceYearId, targetYearId)
      : null;

  // No class picked but both years chosen: the whole school at once.
  const bulk =
    !classGroupId && differentYears
      ? await getWholeSchoolPlan(sourceYearId, targetYearId)
      : null;

  const targetYearName = years.find((year) => year.id === targetYearId)?.name ?? "";

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Promotions"
        subtitle="Move a class into the next academic year — one class at a time, so a mistake is one class wide."
      />

      {years.length < 2 ? (
        <Alert tone="error">
          Only one academic year exists, so there is nowhere to promote anyone to. Create next year
          under{" "}
          <Link href="/settings/terms" className="underline">
            Years and terms
          </Link>{" "}
          first.
        </Alert>
      ) : null}

      <Card title="Choose a class">
        <form className="flex flex-wrap items-end gap-3 p-4">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-700">Class</span>
            <select name="class" defaultValue={classGroupId} className={`${filterClass} w-52`}>
              <option value="">Every class (whole school)</option>
              {classGroups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.level.name} {group.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-700">Leaving</span>
            <select name="from" defaultValue={sourceYearId} className={`${filterClass} w-44`}>
              {years.map((year) => (
                <option key={year.id} value={year.id}>
                  {year.name}
                  {year.isCurrent ? " (current)" : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-700">Entering</span>
            <select name="to" defaultValue={targetYearId} className={`${filterClass} w-44`}>
              <option value="">Choose a year</option>
              {years.map((year) => (
                <option key={year.id} value={year.id}>
                  {year.name}
                </option>
              ))}
            </select>
          </label>

          <button
            type="submit"
            className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white shadow-[0_6px_16px_rgba(18,128,92,0.22)] transition hover:bg-brand-700"
          >
            Show the plan
          </button>
        </form>
      </Card>

      {classGroupId && targetYearId && sourceYearId === targetYearId ? (
        <Alert tone="error">
          A class cannot be promoted into the year it is already in — pick a different year to enter.
        </Alert>
      ) : null}

      {bulk ? (
        <Card title={`Every class · ${years.find((y) => y.id === sourceYearId)?.name} → ${targetYearName}`}>
          <BulkPromotionForm
            sourceYearId={sourceYearId}
            targetYearId={targetYearId}
            targetYearName={targetYearName}
            rows={bulk.plans.map((entry) => ({
              classGroupId: entry.classGroup.id,
              label: `${entry.classGroup.levelName} ${entry.classGroup.name}`,
              destinationLabel: entry.destinationLabel,
              blocked: entry.blocked,
              students: entry.moves.length,
              promote: entry.counts.promote,
              repeat: entry.counts.repeat,
              graduate: entry.counts.graduate,
              alreadyPlaced: entry.counts.alreadyPlaced,
            }))}
          />
        </Card>
      ) : null}

      {plan ? (
        <>
          {!plan.nextLevel ? (
            <Alert tone="success">
              {plan.classGroup.level.name} is the top of the ladder, so this class graduates rather
              than moving up. Anyone staying on should be set to repeat.
            </Alert>
          ) : plan.destinationClasses.length === 0 ? (
            <Alert tone="error">
              {plan.nextLevel.name} has no classes yet, so there is nowhere to promote these
              children to. Add one under{" "}
              <Link href="/classes" className="underline">
                Classes
              </Link>
              .
            </Alert>
          ) : null}

          <Card
            title={`${plan.classGroup.level.name} ${plan.classGroup.name} · ${plan.sourceYear.name} → ${plan.targetYear.name}`}
          >
            <PromotionForm
              classGroupId={plan.classGroup.id}
              sourceYearId={plan.sourceYear.id}
              targetYearId={plan.targetYear.id}
              targetYearName={plan.targetYear.name}
              hasNextLevel={Boolean(plan.nextLevel)}
              destinationClasses={plan.destinationClasses}
              repeatClasses={plan.repeatClasses}
              rows={plan.rows.map((row) => ({
                studentId: row.student.id,
                admissionNo: row.student.admissionNo,
                name: `${row.student.lastName}, ${row.student.firstName}`,
                suggestion: row.suggestion,
                fromReportCard: row.fromReportCard,
                destinationId: row.destinationId,
                alreadyPlacedIn: row.alreadyPlacedIn,
              }))}
            />
          </Card>

          <p className="text-xs text-slate-400">
            Running this again for the same class corrects the placement rather than enrolling
            anyone twice — a child has one enrolment per year, and it is overwritten.
          </p>
        </>
      ) : null}
    </div>
  );
}
