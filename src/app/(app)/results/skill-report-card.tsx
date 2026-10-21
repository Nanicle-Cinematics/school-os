import type { ReportCardTermResult } from "@/lib/results-data";
import type { SkillCardData } from "@/lib/skill-data";
import { SKILL_GRADES, SKILL_GRADE_LABEL, ageLabel } from "@/lib/skills";
import { paperWatermark } from "@/lib/paper";

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

const TERM_NAME: Record<string, string> = { FIRST: "First", SECOND: "Second", THIRD: "Third" };

/**
 * A nursery progress report: the school's own paper form, on screen and in print.
 *
 * Areas down the left (Language, Reading, Writing…), the skills listed under each, then a score out of
 * 100 and an A/B/C rating, and the three remarks a form carries. There are no totals and no positions:
 * the paper form has none, and ranking three-year-olds is not something the school asked for.
 *
 * Rendered from the same data as the marked card (`ReportCard` hands over to this when it is given a
 * level's skills), so the single page, the class print run and the parent portal all show it, and the
 * arrears hold and the publication check in front of them apply unchanged.
 */
export function SkillReportCard({
  schoolName,
  schoolMotto,
  schoolCrestUrl,
  headSignatureUrl,
  headName,
  termResult,
  skills,
  breakAfter = false,
}: {
  schoolName: string;
  schoolMotto?: string | null;
  schoolCrestUrl?: string | null;
  headSignatureUrl?: string | null;
  headName?: string | null;
  termResult: ReportCardTermResult;
  skills: SkillCardData;
  breakAfter?: boolean;
}) {
  const { student, classGroup, term } = termResult;
  const mine = skills.ratings[student.id] ?? {};
  const age = ageLabel(student.dateOfBirth, term.vacationDate ?? term.endDate);
  const comments = [termResult.conduct, termResult.attitude, termResult.interest].filter(Boolean).join(" · ");

  return (
    <div
      className={`paper rounded-xl border border-slate-200 bg-white p-6 print:border-0 ${
        breakAfter ? "print:break-after-page" : ""
      }`}
      style={paperWatermark(schoolCrestUrl)}
    >
      <header className="flex items-center gap-4 border-b-2 border-brand-800 pb-4 text-center">
        {schoolCrestUrl ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={schoolCrestUrl} alt="" className="h-16 w-16 shrink-0 object-contain print:h-14 print:w-14" />
          </>
        ) : null}
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl text-slate-900">{schoolName}</h1>
          {schoolMotto ? (
            <p className="mt-0.5 font-display text-xs italic text-accent-600">{schoolMotto}</p>
          ) : null}
          <p className="mt-2 text-sm font-semibold uppercase tracking-[0.14em] text-brand-800">Progress Report</p>
          <p className="text-xs text-slate-500">
            {TERM_NAME[term.name]} Term · {term.academicYear.name}
          </p>
        </div>
        {schoolCrestUrl ? <div className="h-16 w-16 shrink-0 print:h-14 print:w-14" /> : null}
      </header>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 border-b border-slate-200 py-4 text-sm">
        <div className="col-span-2">
          <dt className="text-xs uppercase tracking-wide text-slate-500">Pupil&rsquo;s name</dt>
          <dd className="font-medium text-slate-900">
            {student.firstName} {student.middleName ? `${student.middleName} ` : ""}
            {student.lastName}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Class</dt>
          <dd className="text-slate-900">
            {classGroup.level.name} {classGroup.name}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Age</dt>
          <dd className="text-slate-900">{age ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Term ending</dt>
          <dd className="text-slate-900">
            {term.vacationDate ? dateFmt.format(term.vacationDate) : dateFmt.format(term.endDate)}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Reopening date</dt>
          <dd className="text-slate-900">{term.nextTermBegins ? dateFmt.format(term.nextTermBegins) : "—"}</dd>
        </div>
        {termResult.daysPresent !== null && termResult.daysTotal !== null ? (
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Attendance</dt>
            <dd className="text-slate-900">
              {termResult.daysPresent} of {termResult.daysTotal} days
            </dd>
          </div>
        ) : null}
      </dl>

      <p className="mt-3 text-xs text-slate-600">
        <span className="font-semibold uppercase tracking-wide text-slate-500">Key: </span>
        {SKILL_GRADES.map((g) => `${g} – ${SKILL_GRADE_LABEL[g]}`).join(" · ")}
      </p>

      {skills.sections.length === 0 ? (
        <p className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
          No skills are listed for {classGroup.level.name} yet, so there is nothing to show here.
        </p>
      ) : (
        <table className="mt-3 w-full border-collapse text-sm">
          <thead>
            <tr className="bg-brand-800 text-xs uppercase tracking-wide text-white print:[-webkit-print-color-adjust:exact] print:[print-color-adjust:exact]">
              <th className="px-2 py-1.5 text-left font-semibold">Area</th>
              <th className="px-2 py-1.5 text-left font-semibold">Skill</th>
              <th className="px-2 py-1.5 text-right font-semibold">Score / 100</th>
              <th className="px-2 py-1.5 text-center font-semibold">Rating</th>
            </tr>
          </thead>
          <tbody>
            {skills.sections.flatMap((section) =>
              section.skills.map((skill, index) => {
                const cell = mine[skill.id];
                return (
                  <tr key={skill.id} className="border-b border-slate-200">
                    {index === 0 ? (
                      <td rowSpan={section.skills.length} className="border-r border-slate-200 px-2 py-1.5 align-top font-medium text-slate-900">
                        {section.subjectName}
                      </td>
                    ) : null}
                    <td className="px-2 py-1.5 text-slate-900">{skill.name}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-700">{cell?.score ?? ""}</td>
                    <td className="px-2 py-1.5 text-center font-semibold text-slate-900">{cell?.grade ?? ""}</td>
                  </tr>
                );
              }),
            )}
          </tbody>
        </table>
      )}

      <div className="mt-5 space-y-3 text-sm">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">General comments</p>
          <p className="mt-0.5 min-h-5 border-b border-dotted border-slate-400 text-slate-900">{comments || " "}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">
            Class teacher&rsquo;s remarks
            {classGroup.formTeacher
              ? ` — ${classGroup.formTeacher.firstName} ${classGroup.formTeacher.lastName}`
              : ""}
          </p>
          <p className="mt-0.5 min-h-5 border-b border-dotted border-slate-400 text-slate-900">
            {termResult.formTeacherRemark ?? " "}
          </p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Head teacher&rsquo;s remarks</p>
          <p className="mt-0.5 min-h-5 border-b border-dotted border-slate-400 text-slate-900">
            {termResult.headRemark ?? " "}
          </p>
        </div>
      </div>

      <div className="mt-6 flex items-end justify-between gap-10">
        <div className="flex-1">
          {headSignatureUrl ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={headSignatureUrl} alt="" className="mb-0.5 h-10 max-w-[180px] object-contain object-left" />
            </>
          ) : (
            <div className="h-10" />
          )}
          <div className="border-t border-slate-900 pt-1">
            <p className="text-xs font-semibold text-slate-900">{headName ?? "Headteacher"}</p>
            <p className="text-[11px] text-slate-500">Headteacher</p>
          </div>
        </div>
        <div className="flex-1">
          <div className="h-10" />
          <div className="border-t border-slate-300 pt-1">
            <p className="text-xs font-semibold text-slate-400">Parent / Guardian</p>
            <p className="text-[11px] text-slate-400">Signature</p>
          </div>
        </div>
      </div>
    </div>
  );
}
