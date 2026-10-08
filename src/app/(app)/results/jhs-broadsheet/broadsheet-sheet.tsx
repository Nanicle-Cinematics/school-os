import Link from "next/link";
import type { BroadsheetRow } from "@/lib/jhs-broadsheet";
import type { BillSchool } from "@/lib/invoice-data";
import { ordinal } from "@/lib/results-engine";
import { paperWatermark } from "@/lib/paper";
import { BillLetterhead } from "../../bill-letterhead";

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" });

/**
 * A JHS class across JHS 1 to JHS 3: pupils down, subjects across.
 *
 * A DOCUMENT, like the cumulative record it summarises — `.paper`, the shared
 * letterhead, landscape print — and listed as one in verify:design. Each cell
 * is the pupil's average term mark in the subject with the number of terms it
 * averages beneath it, so a figure resting on two terms is never mistaken for
 * one resting on nine.
 */
export function JhsBroadsheetSheet({
  school,
  className,
  yearName,
  subjects,
  rows,
  showClassPosition,
  view,
  printedOn,
}: {
  school: BillSchool;
  className: string;
  yearName: string;
  subjects: { id: string; name: string }[];
  rows: BroadsheetRow[];
  showClassPosition: boolean;
  view: "averages" | "sba";
  printedOn: Date;
}) {
  const anyRecords = rows.some((r) => r.fromRecords);
  return (
    <div
      className="paper rounded-xl border border-slate-200 bg-white p-6 print:rounded-none print:border-0 print:p-0"
      style={paperWatermark(school.crestUrl)}
    >
      <style>{"@media print { @page { size: A4 landscape; margin: 8mm; } }"}</style>

      <BillLetterhead school={school}>
        <p className="mt-2 text-sm font-semibold uppercase tracking-[0.14em] text-brand-800">
          JHS 1–3 {view === "sba" ? "SBA" : "Broadsheet"} · {className}
        </p>
        <p className="text-xs text-slate-500">Academic year {yearName}</p>
      </BillLetterhead>

      <div className="overflow-x-auto py-3">
        <table className="w-full border-collapse text-[10.5px] leading-tight">
          <thead>
            <tr className="bg-brand-800 text-white">
              {showClassPosition ? (
                <th className="border border-slate-300 px-1.5 py-1.5 text-center font-semibold">Pos.</th>
              ) : null}
              <th className="border border-slate-300 px-2 py-1.5 text-left font-semibold">Pupil</th>
              {subjects.map((s) => (
                <th key={s.id} className="border border-slate-300 px-1 py-1.5 text-center font-semibold">
                  {s.name}
                </th>
              ))}
              <th className="border border-slate-300 px-1.5 py-1.5 text-center font-semibold">Terms</th>
              <th className="border border-slate-300 px-1.5 py-1.5 text-center font-semibold">Marks</th>
              <th className="border border-slate-300 px-1.5 py-1.5 text-center font-semibold">%</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.pupil.id}>
                {showClassPosition ? (
                  <td className="border border-slate-300 px-1.5 py-1 text-center tabular-nums font-semibold text-slate-900">
                    {row.position ? ordinal(row.position) : "—"}
                  </td>
                ) : null}
                <td className="whitespace-nowrap border border-slate-300 px-2 py-1 text-slate-900">
                  <Link href={`/results/${row.pupil.id}/cumulative`} className="hover:underline">
                    {row.pupil.lastName}, {row.pupil.firstName}
                  </Link>
                  {row.fromRecords ? <sup className="ml-0.5 font-semibold">R</sup> : null}
                  <span className="block text-[9.5px] text-slate-500">{row.pupil.admissionNo}</span>
                </td>
                {row.cells.map((cell, i) => (
                  <td key={i} className="border border-slate-300 px-1 py-1 text-center tabular-nums text-slate-900">
                    {view === "sba" ? (
                      cell.sba !== null ? (
                        <>
                          {cell.sba.toFixed(1)}
                          <span className="block text-[9px] text-slate-500">
                            {cell.sbaYears} {cell.sbaYears === 1 ? "yr" : "yrs"}
                          </span>
                        </>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )
                    ) : cell.average !== null ? (
                      <>
                        {cell.average}
                        <span className="block text-[9px] text-slate-500">{cell.terms} t</span>
                      </>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                ))}
                <td className="border border-slate-300 px-1.5 py-1 text-center tabular-nums text-slate-900">
                  {row.termsOnRecord}
                </td>
                <td className="whitespace-nowrap border border-slate-300 px-1.5 py-1 text-center tabular-nums text-slate-900">
                  {row.marks !== null ? `${row.marks} / ${row.possible}` : "—"}
                </td>
                <td className="border border-slate-300 px-1.5 py-1 text-center tabular-nums font-semibold text-slate-900">
                  {row.percentage !== null ? row.percentage.toFixed(1) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-0.5 text-[10.5px] text-slate-600">
        {view === "sba" ? (
          <p>
            Each subject shows the pupil&rsquo;s SBA out of 30: each term&rsquo;s class score as a
            percentage of what it is marked out of, averaged within each JHS year, the years averaged
            equally, then scaled to 30. Terms with no class score (paper records entered as a total
            only) are left out; &ldquo;yrs&rdquo; is how many years the figure rests on. The exam score is
            not part of it. Marks and % are all marks over all marks available across the JHS terms.
          </p>
        ) : (
          <p>
            Each subject shows the pupil&rsquo;s average term mark out of 100 across the JHS terms on
            record, with the number of terms (t) it averages. Marks and % are all marks over all marks
            available across those terms. Choose &ldquo;SBA (out of 30)&rdquo; for the school-based
            assessment figure.
          </p>
        )}
        {anyRecords ? (
          <p>
            <sup className="font-semibold">R</sup> Includes terms transcribed from the school&rsquo;s own
            paper records for a year before School OS.
          </p>
        ) : null}
        <p>Printed {dateFmt.format(printedOn)}</p>
      </div>
    </div>
  );
}
