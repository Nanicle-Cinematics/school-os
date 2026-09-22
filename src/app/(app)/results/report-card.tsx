import { ordinal } from "@/lib/results-engine";
import type {
  ReportCardSettings,
  ReportCardSubjectResult,
  ReportCardTermResult,
} from "@/lib/results-data";

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

const TERM_NAME: Record<string, string> = { FIRST: "First", SECOND: "Second", THIRD: "Third" };

/**
 * One terminal report, laid out to fill a single A4 sheet.
 *
 * Rendered both on a student's own page and in the whole-class print run, from
 * the same data — see REPORT_CARD_INCLUDE. `breakAfter` puts each card on its
 * own sheet when a class is printed together.
 */
export function ReportCard({
  schoolName,
  schoolMotto,
  schoolCrestUrl,
  headSignatureUrl,
  headName,
  termResult,
  subjectResults,
  settings,
  breakAfter = false,
}: {
  schoolName: string;
  schoolMotto?: string | null;
  schoolCrestUrl?: string | null;
  headSignatureUrl?: string | null;
  headName?: string | null;
  termResult: ReportCardTermResult;
  subjectResults: ReportCardSubjectResult[];
  settings: ReportCardSettings;
  breakAfter?: boolean;
}) {
  const { student, classGroup, term } = termResult;
  const guardian = student.guardians[0]?.guardian;

  /**
   * Both default to ON for a school with no settings row, which is what the
   * column defaults say and what a Ghanaian terminal report normally carries.
   *
   * ⚠️ These two were saved by `/settings` and read NOWHERE: a school that
   * turned positions off — the ones that decide not to rank six-year-olds, and
   * they exist — printed them on every card anyway. `showAggregate` below was
   * the only one of the three ever wired up.
   */
  const showClassPosition = settings?.showClassPosition ?? true;
  const showSubjectPosition = settings?.showSubjectPosition ?? true;

  return (
    <div
      className={`paper rounded-xl border border-slate-200 bg-white p-6 print:border-0 ${
        breakAfter ? "print:break-after-page" : ""
      }`}
    >
      <header className="flex items-center gap-4 border-b-2 border-brand-800 pb-4 text-center">
        {schoolCrestUrl ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={schoolCrestUrl}
              alt=""
              className="h-16 w-16 shrink-0 object-contain print:h-14 print:w-14"
            />
          </>
        ) : null}
        <div className="min-w-0 flex-1">
        <h1 className="font-display text-2xl text-slate-900">{schoolName}</h1>
        {schoolMotto ? (
          <p className="mt-0.5 font-display text-xs italic text-accent-600">{schoolMotto}</p>
        ) : null}
        <p className="mt-2 text-sm font-semibold uppercase tracking-[0.14em] text-brand-800">
          Terminal Report
        </p>
        <p className="text-xs text-slate-500">
          {TERM_NAME[term.name]} Term · {term.academicYear.name}
        </p>
        </div>
        {schoolCrestUrl ? <div className="h-16 w-16 shrink-0 print:h-14 print:w-14" /> : null}
      </header>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 border-b border-slate-200 py-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Name</dt>
          <dd className="font-medium text-slate-900">
            {student.firstName} {student.middleName ? `${student.middleName} ` : ""}
            {student.lastName}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Admission no.</dt>
          <dd className="font-mono text-slate-900">{student.admissionNo}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Class</dt>
          <dd className="text-slate-900">
            {classGroup.level.name} {classGroup.name}
          </dd>
        </div>
        {showClassPosition ? (
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Position</dt>
            <dd className="font-semibold text-slate-900">
              {ordinal(termResult.classPosition)} of {termResult.classSize ?? "—"}
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Attendance</dt>
          <dd className="text-slate-900">
            {termResult.daysPresent !== null && termResult.daysTotal !== null
              ? `${termResult.daysPresent} of ${termResult.daysTotal} days`
              : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">House</dt>
          <dd className="text-slate-900">{student.house?.name ?? "—"}</dd>
        </div>
      </dl>

      <table className="mt-4 w-full text-sm">
        <thead>
          <tr className="bg-brand-800 text-xs uppercase tracking-wide text-white print:[-webkit-print-color-adjust:exact] print:[print-color-adjust:exact]">
            <th className="px-2 py-1.5 text-left font-semibold">Subject</th>
            <th className="px-2 py-1.5 text-right font-semibold">
              Class ({settings?.classScoreWeight ?? 30}%)
            </th>
            <th className="px-2 py-1.5 text-right font-semibold">
              Exam ({settings?.examScoreWeight ?? 70}%)
            </th>
            <th className="px-2 py-1.5 text-right font-semibold">Total</th>
            <th className="px-2 py-1.5 text-center font-semibold">Grade</th>
            {showSubjectPosition ? (
              <th className="px-2 py-1.5 text-right font-semibold">Pos.</th>
            ) : null}
            <th className="px-2 py-1.5 text-left font-semibold">Remark</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {subjectResults.map((result) => (
            <tr key={result.id}>
              <td className="px-2 py-1.5 text-slate-900">{result.subject.name}</td>
              <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">
                {result.classScore ? Number(result.classScore).toFixed(1) : "—"}
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">
                {result.examScore ? Number(result.examScore).toFixed(1) : "—"}
              </td>
              <td className="px-2 py-1.5 text-right font-medium tabular-nums text-slate-900">
                {result.totalScore ? Number(result.totalScore).toFixed(1) : "—"}
              </td>
              <td className="px-2 py-1.5 text-center font-semibold text-slate-900">
                {result.grade ?? "—"}
              </td>
              {showSubjectPosition ? (
                <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">
                  {ordinal(result.subjectPosition)}
                </td>
              ) : null}
              <td className="px-2 py-1.5 text-slate-600">{result.remark ?? "—"}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-slate-300 font-semibold text-slate-900">
            <td className="pt-2">Total / Average</td>
            <td />
            <td />
            <td className="pt-2 text-right tabular-nums">
              {termResult.totalMarks === null ? (
                "—"
              ) : (
                <>
                  {Number(termResult.totalMarks).toFixed(0)}
                  {/* The denominator is the point: 624 alone tells a parent
                      nothing until they know the class sat nine subjects. */}
                  {termResult.possibleMarks ? (
                    <span className="font-normal text-slate-500"> / {termResult.possibleMarks}</span>
                  ) : null}
                </>
              )}
            </td>
            <td className="pt-2 text-center tabular-nums">
              {termResult.average === null ? "—" : Number(termResult.average).toFixed(1)}
              {termResult.percentage !== null ? (
                <span className="block text-xs font-normal text-slate-500">
                  {Number(termResult.percentage).toFixed(1)}%
                </span>
              ) : null}
            </td>
            {/* Spans whatever is left after the position column may have gone,
                or the aggregate line lands under the wrong heading. */}
            <td
              colSpan={showSubjectPosition ? 2 : 1}
              className="pt-2 text-right text-xs font-normal text-slate-500"
            >
              {settings?.showAggregate && termResult.aggregate !== null
                ? `Aggregate (best ${settings.aggregateSubjects}): ${termResult.aggregate}`
                : ""}
            </td>
          </tr>
        </tfoot>
      </table>

      <div className="mt-5 grid gap-3 border-t border-slate-200 pt-4 text-sm sm:grid-cols-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Conduct</p>
          <p className="text-slate-900">{termResult.conduct ?? "—"}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Attitude</p>
          <p className="text-slate-900">{termResult.attitude ?? "—"}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Interest</p>
          <p className="text-slate-900">{termResult.interest ?? "—"}</p>
        </div>
      </div>

      <div className="mt-4 space-y-3 border-t border-slate-200 pt-4 text-sm">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">
            Class teacher&rsquo;s remark
            {classGroup.formTeacher
              ? ` — ${classGroup.formTeacher.firstName} ${classGroup.formTeacher.lastName}`
              : ""}
          </p>
          <p className="mt-0.5 min-h-5 text-slate-900">{termResult.formTeacherRemark ?? "—"}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Head teacher&rsquo;s remark</p>
          <p className="mt-0.5 min-h-5 text-slate-900">{termResult.headRemark ?? "—"}</p>
        </div>
      </div>

      <footer className="mt-5 flex flex-wrap justify-between gap-3 border-t border-slate-200 pt-4 text-xs text-slate-500">
        <span>{term.vacationDate ? `Vacation: ${dateFmt.format(term.vacationDate)}` : ""}</span>
        <span>
          {term.nextTermBegins ? `Next term begins: ${dateFmt.format(term.nextTermBegins)}` : ""}
        </span>
      </footer>

      {/* Signatures. A terminal report is not finished until it is signed, and
          the parent's line is what comes back to the school. */}
      <div className="mt-6 flex items-end justify-between gap-10">
        <div className="flex-1">
          {headSignatureUrl ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={headSignatureUrl}
                alt=""
                className="mb-0.5 h-10 max-w-[180px] object-contain object-left"
              />
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

      {guardian ? (
        <p className="mt-3 text-xs text-slate-400">
          Issued to {guardian.firstName} {guardian.lastName} · {guardian.phone}
        </p>
      ) : null}
    </div>
  );
}
