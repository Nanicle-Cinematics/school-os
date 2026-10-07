import type { CumulativeRecord } from "@/lib/cumulative";
import type { BillSchool } from "@/lib/invoice-data";
import { ordinal } from "@/lib/results-engine";
import { paperWatermark } from "@/lib/paper";
import { BillLetterhead } from "../bill-letterhead";

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" });

const TERM_LABEL = ["Term 1", "Term 2", "Term 3"];

/**
 * The JHS cumulative record: every subject, every term, JHS 1 to JHS 3, on one
 * landscape A4 sheet.
 *
 * A DOCUMENT, like the report card — `.paper`, the shared letterhead, its own
 * print rules — and listed as one in verify:design. Two marks on a column say
 * where its figures came from, because a transcribed mark and a computed one
 * look identical once printed: R for a term entered from the school's paper
 * records, and an asterisk for one not yet approved, whose figures may still
 * move.
 */
export function CumulativeRecordSheet({
  school,
  student,
  record,
  showClassPosition,
  headSignatureUrl,
  headName,
  printedOn,
}: {
  school: BillSchool;
  student: {
    firstName: string;
    middleName: string | null;
    lastName: string;
    admissionNo: string;
    dateOfBirth: Date | null;
    gender: string | null;
  };
  record: CumulativeRecord;
  showClassPosition: boolean;
  headSignatureUrl?: string | null;
  headName?: string | null;
  printedOn: Date;
}) {
  const fromRecords = record.years.some((y) => y.kind === "year" && y.terms.some((t) => t.source === "RECORDS"));
  const provisional = record.years.some((y) => y.kind === "year" && y.terms.some((t) => t.provisional));
  const termCells = record.years.flatMap((year) =>
    year.kind === "missing" ? [null, null, null] : year.terms,
  );
  const fmt = (n: number | null) => (n === null ? "" : Number.isInteger(n) ? String(n) : n.toFixed(1));

  return (
    <div className="paper rounded-xl border border-slate-200 bg-white p-6 print:rounded-none print:border-0 print:p-0" style={paperWatermark(school.crestUrl)}>
      {/* Landscape for this sheet only: nine term columns do not fit portrait. */}
      <style>{"@media print { @page { size: A4 landscape; margin: 10mm; } }"}</style>

      <BillLetterhead school={school}>
        <p className="mt-2 text-sm font-semibold uppercase tracking-[0.14em] text-brand-800">
          Cumulative Record · Junior High School
        </p>
      </BillLetterhead>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 border-b border-slate-200 py-3 text-sm sm:grid-cols-4">
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
          <dt className="text-xs uppercase tracking-wide text-slate-500">Date of birth</dt>
          <dd className="text-slate-900">{student.dateOfBirth ? dateFmt.format(student.dateOfBirth) : "—"}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Gender</dt>
          <dd className="text-slate-900">{student.gender ? student.gender.charAt(0) + student.gender.slice(1).toLowerCase() : "—"}</dd>
        </div>
      </dl>

      <div className="overflow-x-auto py-3">
        <table className="w-full border-collapse text-[11px] leading-tight">
          <thead>
            <tr className="bg-brand-800 text-white">
              <th rowSpan={2} className="border border-slate-300 px-2 py-1.5 text-left font-semibold">
                Subject
              </th>
              {record.years.map((year, i) => (
                <th key={i} colSpan={3} className="border border-slate-300 px-2 py-1 text-center font-semibold">
                  {year.kind === "year" ? (
                    <>
                      {year.levelName} · {year.yearName}
                      <span className="block text-[10px] font-normal opacity-80">{year.className}</span>
                    </>
                  ) : (
                    <>
                      {year.levelName}
                      <span className="block text-[10px] font-normal opacity-80">Not recorded at this school</span>
                    </>
                  )}
                </th>
              ))}
            </tr>
            <tr className="bg-slate-100 text-slate-700">
              {termCells.map((term, i) => (
                <th key={i} className="border border-slate-300 px-1 py-1 text-center font-medium">
                  {TERM_LABEL[i % 3]}
                  {term?.source === "RECORDS" ? <sup className="ml-0.5 font-semibold">R</sup> : null}
                  {term?.provisional ? <sup className="ml-0.5 font-semibold">*</sup> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {record.rows.map((row) => (
              <tr key={row.subjectId}>
                <td className="whitespace-nowrap border border-slate-300 px-2 py-1 text-slate-900">{row.name}</td>
                {row.cells.map((cell, i) => (
                  <td key={i} className="border border-slate-300 px-1 py-1 text-center tabular-nums text-slate-900">
                    {cell && cell.total !== null ? (
                      <>
                        {fmt(cell.total)}
                        {cell.grade ? <span className="ml-1 text-slate-500">{cell.grade}</span> : null}
                      </>
                    ) : termCells[i] ? (
                      <span className="text-slate-400">—</span>
                    ) : null}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot className="font-semibold">
            <tr className="bg-slate-50">
              <td className="border border-slate-300 px-2 py-1 text-slate-900">Total</td>
              {termCells.map((term, i) => (
                <td key={i} className="border border-slate-300 px-1 py-1 text-center tabular-nums text-slate-900">
                  {term?.totalMarks !== null && term?.totalMarks !== undefined
                    ? `${fmt(term.totalMarks)} / ${term.possibleMarks ?? "—"}`
                    : ""}
                </td>
              ))}
            </tr>
            <tr className="bg-slate-50">
              <td className="border border-slate-300 px-2 py-1 text-slate-900">Percentage</td>
              {termCells.map((term, i) => (
                <td key={i} className="border border-slate-300 px-1 py-1 text-center tabular-nums text-slate-900">
                  {term?.percentage !== null && term?.percentage !== undefined ? `${term.percentage.toFixed(1)}%` : ""}
                </td>
              ))}
            </tr>
            {showClassPosition ? (
              <tr className="bg-slate-50">
                <td className="border border-slate-300 px-2 py-1 text-slate-900">Position</td>
                {termCells.map((term, i) => (
                  <td key={i} className="border border-slate-300 px-1 py-1 text-center tabular-nums text-slate-900">
                    {term?.classPosition ? `${ordinal(term.classPosition)} of ${term.classSize ?? "—"}` : ""}
                  </td>
                ))}
              </tr>
            ) : null}
          </tfoot>
        </table>
      </div>

      {fromRecords || provisional ? (
        <p className="text-[11px] text-slate-600">
          {fromRecords ? (
            <>
              <sup className="font-semibold">R</sup> Transcribed from the school&rsquo;s own paper
              records for a year before School OS.{" "}
            </>
          ) : null}
          {provisional ? (
            <>
              <sup className="font-semibold">*</sup> Not yet approved; these figures may still change.
            </>
          ) : null}
        </p>
      ) : null}

      <footer className="mt-6 flex items-end justify-between gap-6 text-xs text-slate-600">
        <p>Printed {dateFmt.format(printedOn)}</p>
        <div className="text-center">
          {headSignatureUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={headSignatureUrl} alt="" className="mx-auto h-10 object-contain" />
          ) : (
            <div className="h-10" />
          )}
          <p className="border-t border-slate-400 px-8 pt-1">{headName ? `${headName}, ` : ""}Head teacher</p>
        </div>
      </footer>
    </div>
  );
}
