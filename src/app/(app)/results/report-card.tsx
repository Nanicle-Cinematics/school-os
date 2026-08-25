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
  termResult,
  subjectResults,
  settings,
  breakAfter = false,
}: {
  schoolName: string;
  termResult: ReportCardTermResult;
  subjectResults: ReportCardSubjectResult[];
  settings: ReportCardSettings;
  breakAfter?: boolean;
}) {
  const { student, classGroup, term } = termResult;
  const guardian = student.guardians[0]?.guardian;

  return (
    <div
      className={`rounded-xl border border-slate-200 bg-white p-6 print:border-0 ${
        breakAfter ? "print:break-after-page" : ""
      }`}
    >
      <header className="border-b-2 border-slate-900 pb-4 text-center">
        <h1 className="text-lg font-bold uppercase tracking-wide text-slate-900">{schoolName}</h1>
        <p className="mt-0.5 text-sm text-slate-600">Terminal Report</p>
        <p className="text-xs text-slate-500">
          {TERM_NAME[term.name]} Term · {term.academicYear.name}
        </p>
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
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Position</dt>
          <dd className="font-semibold text-slate-900">
            {ordinal(termResult.classPosition)} of {termResult.classSize ?? "—"}
          </dd>
        </div>
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
          <tr className="border-b border-slate-300 text-xs uppercase tracking-wide text-slate-500">
            <th className="pb-2 text-left font-medium">Subject</th>
            <th className="pb-2 text-right font-medium">
              Class ({settings?.classScoreWeight ?? 30}%)
            </th>
            <th className="pb-2 text-right font-medium">
              Exam ({settings?.examScoreWeight ?? 70}%)
            </th>
            <th className="pb-2 text-right font-medium">Total</th>
            <th className="pb-2 text-center font-medium">Grade</th>
            <th className="pb-2 text-right font-medium">Pos.</th>
            <th className="pb-2 text-left font-medium">Remark</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {subjectResults.map((result) => (
            <tr key={result.id}>
              <td className="py-1.5 text-slate-900">{result.subject.name}</td>
              <td className="py-1.5 text-right tabular-nums text-slate-600">
                {result.classScore ? Number(result.classScore).toFixed(1) : "—"}
              </td>
              <td className="py-1.5 text-right tabular-nums text-slate-600">
                {result.examScore ? Number(result.examScore).toFixed(1) : "—"}
              </td>
              <td className="py-1.5 text-right font-medium tabular-nums text-slate-900">
                {result.totalScore ? Number(result.totalScore).toFixed(1) : "—"}
              </td>
              <td className="py-1.5 text-center font-semibold text-slate-900">
                {result.grade ?? "—"}
              </td>
              <td className="py-1.5 text-right tabular-nums text-slate-600">
                {ordinal(result.subjectPosition)}
              </td>
              <td className="py-1.5 text-slate-600">{result.remark ?? "—"}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-slate-300 font-semibold text-slate-900">
            <td className="pt-2">Total / Average</td>
            <td />
            <td />
            <td className="pt-2 text-right tabular-nums">
              {termResult.totalMarks ? Number(termResult.totalMarks).toFixed(0) : "—"}
            </td>
            <td className="pt-2 text-center tabular-nums">
              {termResult.average ? Number(termResult.average).toFixed(1) : "—"}
            </td>
            <td colSpan={2} className="pt-2 text-right text-xs font-normal text-slate-500">
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

      {guardian ? (
        <p className="mt-3 text-xs text-slate-400">
          Issued to {guardian.firstName} {guardian.lastName} · {guardian.phone}
        </p>
      ) : null}
    </div>
  );
}
