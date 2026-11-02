import type { BillSchool } from "@/lib/invoice-data";
import type { PayslipView } from "@/lib/payroll-data";
import { periodLabel } from "@/lib/payroll-rules";
import { paperWatermark, printedByLine } from "@/lib/paper";
import { gh } from "./format";

const addressLine = (school: BillSchool) => [school.address, school.town, school.district, school.region].filter(Boolean).join(", ");

/**
 * One payslip on one A4 sheet. It prints what was frozen when the run was worked out, never today's salary or today's
 * rates, so a slip reprinted next year reads what was paid. The employer's SSNIT is shown but is not a deduction: it
 * is a cost to the school and nobody's pay.
 */
export function PayslipSheet({
  school,
  slip,
  year,
  month,
  provisional,
  printedBy,
  breakAfter,
}: {
  school: BillSchool;
  slip: PayslipView;
  year: number;
  month: number;
  /** The run is not approved yet: what is printed may still change. */
  provisional: boolean;
  printedBy: string;
  breakAfter: boolean;
}) {
  const address = addressLine(school);
  const allowances = slip.lines.filter((l) => l.kind === "ALLOWANCE");
  const loans = slip.lines.filter((l) => l.kind === "DEDUCTION");
  const totalDeductions = slip.ssnitEmployee + slip.paye + slip.deductions;

  return (
    <article
      className={`paper rounded-xl border border-slate-200 bg-white p-6 text-slate-900 print:rounded-none print:border-0 print:p-0 ${breakAfter ? "print:break-after-page" : ""}`}
      style={paperWatermark(school.crestUrl)}
    >
      <header className="flex items-center gap-4 border-b-2 border-brand-800 pb-3 text-center">
        {school.crestUrl ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={school.crestUrl} alt="" className="h-14 w-14 shrink-0 object-contain" />
          </>
        ) : null}
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl">{school.name}</h1>
          {address ? <p className="mt-1 text-xs text-slate-600">{address}</p> : null}
          {school.tin ? <p className="text-xs text-slate-500">TIN {school.tin}</p> : null}
        </div>
        {school.crestUrl ? <div className="h-14 w-14 shrink-0" /> : null}
      </header>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-3">
        <div>
          <p className="text-sm font-semibold tracking-[0.14em] text-brand-800">Payslip</p>
          <p className="text-xs text-slate-600">{periodLabel(year, month)}</p>
        </div>
        {provisional ? <p className="text-xs font-semibold text-red-700">Not yet approved: figures may change</p> : null}
      </div>

      <dl className="grid gap-x-6 gap-y-1 border-b border-slate-200 py-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-slate-500">Employee</dt>
          <dd className="font-medium">{slip.name}</dd>
          <dd className="text-xs text-slate-600">{[slip.staffNo, slip.designation].filter(Boolean).join(" · ")}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">SSNIT number · TIN</dt>
          <dd className="text-sm">
            {slip.ssnitNumber ?? "not recorded"} · {slip.tin ?? "not recorded"}
          </dd>
        </div>
      </dl>

      <div className="mt-3 grid gap-6 sm:grid-cols-2">
        <section>
          <h2 className="border-b border-slate-300 pb-1 text-xs font-medium text-slate-600">Earnings</h2>
          <table className="mt-1 w-full text-sm">
            <tbody>
              <tr>
                <td className="py-1">Basic salary</td>
                <td className="py-1 text-right tabular-nums">{gh(slip.basic)}</td>
              </tr>
              {allowances.map((l) => (
                <tr key={l.id}>
                  <td className="py-1">
                    {l.name}
                    {l.taxable ? "" : " (not taxed)"}
                  </td>
                  <td className="py-1 text-right tabular-nums">{gh(l.amount)}</td>
                </tr>
              ))}
              <tr className="border-t border-slate-300 font-semibold">
                <td className="py-1">Gross pay</td>
                <td className="py-1 text-right tabular-nums">{gh(slip.gross)}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section>
          <h2 className="border-b border-slate-300 pb-1 text-xs font-medium text-slate-600">Deductions</h2>
          <table className="mt-1 w-full text-sm">
            <tbody>
              <tr>
                <td className="py-1">SSNIT (employee)</td>
                <td className="py-1 text-right tabular-nums">{gh(slip.ssnitEmployee)}</td>
              </tr>
              <tr>
                <td className="py-1">PAYE income tax</td>
                <td className="py-1 text-right tabular-nums">{gh(slip.paye)}</td>
              </tr>
              {loans.map((l) => (
                <tr key={l.id}>
                  <td className="py-1">{l.name}</td>
                  <td className="py-1 text-right tabular-nums">{gh(l.amount)}</td>
                </tr>
              ))}
              <tr className="border-t border-slate-300 font-semibold">
                <td className="py-1">Total deductions</td>
                <td className="py-1 text-right tabular-nums">{gh(totalDeductions)}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>

      <div className="mt-4 flex items-center justify-between rounded-lg border-2 border-brand-800 px-4 py-3">
        <span className="text-sm font-semibold">Net pay</span>
        <span className="font-display text-2xl tabular-nums">{gh(slip.net)}</span>
      </div>

      <p className="mt-3 text-xs text-slate-500">
        Tax is worked on {gh(slip.chargeable)} of taxable pay, after the employee&rsquo;s SSNIT. The school also pays {gh(slip.ssnitEmployer)} SSNIT as the
        employer, which is not taken from your pay.
      </p>
      {slip.warnings ? <p className="mt-1 whitespace-pre-line text-xs font-semibold text-red-700">{slip.warnings}</p> : null}
      <p className="mt-4 border-t border-slate-200 pt-2 text-[10px] text-slate-400">{printedByLine(printedBy)}</p>
    </article>
  );
}
