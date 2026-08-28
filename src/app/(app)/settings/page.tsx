import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { getSettings, getYearUsage } from "@/lib/settings-data";
import { setCurrentTerm } from "@/lib/settings-actions";
import { deleteAcademicYear } from "@/lib/term-actions";
import { Alert, Card, EmptyRow, PageHeader, tableHeadClass, thClass } from "../ui";
import { SubmitButton } from "../submit-button";
import { AcademicForm, FeesForm, ProfileForm, SmsForm } from "./settings-forms";

export const metadata: Metadata = { title: "Settings · School OS" };

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const TERM_LABEL: Record<string, string> = {
  FIRST: "First term",
  SECOND: "Second term",
  THIRD: "Third term",
};

export default async function SettingsPage() {
  const auth = await requireRole(OFFICE);
  const { school, settings, gradingScales, years } = await getSettings(auth.schoolId);

  if (!school) {
    notFound();
  }

  // SchoolSettings is created lazily, so the forms fall back to the same
  // defaults the schema declares rather than rendering blank inputs.
  const academic = {
    classScoreWeight: settings?.classScoreWeight ?? 30,
    examScoreWeight: settings?.examScoreWeight ?? 70,
    aggregateSubjects: settings?.aggregateSubjects ?? 6,
    defaultGradingScaleId: settings?.defaultGradingScaleId ?? null,
    showClassPosition: settings?.showClassPosition ?? true,
    showSubjectPosition: settings?.showSubjectPosition ?? true,
    showAggregate: settings?.showAggregate ?? true,
    reportCardTemplate: settings?.reportCardTemplate ?? "ges_standard",
  };

  const currentTerm = years.flatMap((year) => year.terms).find((term) => term.isCurrent);
  const usage = await getYearUsage(years);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title="Settings"
        subtitle={
          currentTerm
            ? `Current: ${TERM_LABEL[currentTerm.name]} · ${
                years.find((year) => year.id === currentTerm.academicYearId)?.name ?? ""
              }`
            : "No term is marked current"
        }
      />

      {!currentTerm ? (
        <Alert tone="error">
          Nothing is marked as the current term, so invoices, score entry and the dashboard have no
          period to work in. Pick one below.
        </Alert>
      ) : null}

      <Card
        title="Academic year and terms"
        action={
          <Link href="/settings/terms" className="text-sm text-slate-500 hover:text-slate-900">
            Manage →
          </Link>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className={tableHeadClass}>
              <tr>
                <th className={thClass}>Year</th>
                <th className={thClass}>Term</th>
                <th className={thClass}>Runs</th>
                <th className={thClass}>Vacation</th>
                <th className={thClass} />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {years.length === 0 ? (
                <EmptyRow colSpan={5}>
                  No academic years yet. They are created by the seed or by an import.
                </EmptyRow>
              ) : (
                years.flatMap((year) =>
                  year.terms.map((term) => (
                    <tr key={term.id} className={term.isCurrent ? "bg-slate-50" : ""}>
                      <td className="whitespace-nowrap px-4 py-2 font-medium text-slate-900">
                        {year.name}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                        {TERM_LABEL[term.name] ?? term.name}
                        {term.isCurrent ? (
                          <span className="ml-2 rounded bg-slate-900 px-1.5 py-0.5 text-xs font-medium text-white">
                            current
                          </span>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                        {dateFmt.format(term.startDate)} – {dateFmt.format(term.endDate)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                        {term.vacationDate ? dateFmt.format(term.vacationDate) : "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {term.isCurrent ? null : (
                            <form action={setCurrentTerm}>
                              <input type="hidden" name="termId" value={term.id} />
                              <SubmitButton variant="secondary" pendingLabel="Switching…">
                                Make current
                              </SubmitButton>
                            </form>
                          )}
                          {/* The delete belongs to the year, so it is offered
                              once, on its first term's row. */}
                          {term.sequence === 1 ? (
                            (usage.get(year.id) ?? 0) > 0 ? (
                              <span
                                className="text-xs text-slate-400"
                                title="Billed, graded or enrolled against."
                              >
                                {usage.get(year.id)} attached
                              </span>
                            ) : (
                              <form action={deleteAcademicYear}>
                                <input type="hidden" name="id" value={year.id} />
                                <SubmitButton variant="danger" pendingLabel="Deleting…">
                                  Delete year
                                </SubmitButton>
                              </form>
                            )
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  )),
                )
              )}
            </tbody>
          </table>
        </div>
        <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
          Switching the current term changes what every other page is talking about — invoices,
          score entry, the dashboard. It does not move or alter any existing record. A year can
          only be deleted while nothing has been billed, graded or enrolled against it — its
          terms carry those records and would take them along.
        </p>
      </Card>

      <Card
        title="School structure"
        action={
          <Link href="/settings/structure" className="text-sm text-slate-500 hover:text-slate-900">
            Manage →
          </Link>
        }
      >
        <p className="p-4 text-sm text-slate-500">
          Levels, houses and programmes — the ladder a child climbs and the groups they belong to.
          A class cannot exist without a level, so this comes first when setting up a school.
        </p>
      </Card>

      <Card
        title="Assessment components"
        action={
          <Link href="/settings/components" className="text-sm text-slate-500 hover:text-slate-900">
            Manage →
          </Link>
        }
      >
        <p className="p-4 text-sm text-slate-500">
          What every subject is marked out of — the class tests, group work, project and exam.
          Teachers get these automatically when they open a mark sheet, and set each
          component&rsquo;s total marks for their own class.
        </p>
      </Card>

      <Card title="School profile">
        <ProfileForm
          values={{
            name: school.name,
            shortName: school.shortName,
            motto: school.motto,
            headName: school.headName,
            email: school.email,
            phone: school.phone,
            altPhone: school.altPhone,
            website: school.website,
            address: school.address,
            town: school.town,
            district: school.district,
            region: school.region,
            gpsAddress: school.gpsAddress,
            accreditationNo: school.accreditationNo,
          }}
        />
      </Card>

      <Card title="Assessment and report cards">
        <AcademicForm
          values={academic}
          scales={gradingScales.map((scale) => ({ id: scale.id, name: scale.name }))}
        />
      </Card>

      <Card
        title="Grading scales"
        action={
          <Link href="/settings/grading" className="text-sm text-slate-500 hover:text-slate-900">
            Manage →
          </Link>
        }
      >
        {gradingScales.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">
            No grading scales yet — results cannot be graded until one exists.
          </p>
        ) : (
          <div className="divide-y divide-slate-100">
            {gradingScales.map((scale) => (
              <div key={scale.id} className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-slate-900">{scale.name}</h3>
                  {scale.id === academic.defaultGradingScaleId ? (
                    <span className="rounded bg-slate-900 px-1.5 py-0.5 text-xs font-medium text-white">
                      default
                    </span>
                  ) : null}
                  <span className="text-xs text-slate-400">
                    used by {scale._count.subjectResults} results
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {scale.bands.map((band) => (
                    <span
                      key={band.id}
                      title={`${band.remark} · ${band.points} point${band.points === 1 ? "" : "s"}`}
                      className={`rounded px-1.5 py-0.5 text-xs ${
                        band.isPass ? "bg-slate-100 text-slate-700" : "bg-red-50 text-red-700"
                      }`}
                    >
                      {band.grade} {band.minScore.toString()}–{band.maxScore.toString()}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
          Bands are read-only here — edit them under Manage. A scale that has already graded results
          is locked there too; duplicate it and edit the copy, so an already-printed report card
          keeps meaning what it said.
        </p>
      </Card>

      <Card title="Fees">
        <FeesForm
          values={{
            invoiceDueDays: settings?.invoiceDueDays ?? 14,
            blockReportOnArrears: settings?.blockReportOnArrears ?? false,
            paymentInstructions: settings?.paymentInstructions ?? "",
            invoiceNote: settings?.invoiceNote ?? "",
          }}
        />
      </Card>

      <Card title="SMS">
        <SmsForm
          values={{
            smsEnabled: settings?.smsEnabled ?? false,
            smsProvider: settings?.smsProvider ?? null,
            smsSenderId: settings?.smsSenderId ?? null,
            notifyOnPayment: settings?.notifyOnPayment ?? true,
            notifyOnResultPublish: settings?.notifyOnResultPublish ?? true,
          }}
        />
      </Card>
    </div>
  );
}
