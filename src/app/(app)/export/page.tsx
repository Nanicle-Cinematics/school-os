import type { Metadata } from "next";
import { requireRole, requireAuth } from "@/lib/auth";
import { OFFICE, canAccess } from "@/lib/permissions";
import { DATASET_NAMES, dataset } from "@/lib/export-data";
import { getInvoiceFilterOptions } from "@/lib/invoice-data";
import { getCurrentTerm } from "@/lib/fee-data";
import { Card, PageHeader, filterClass } from "../ui";

export const metadata: Metadata = { title: "Export · School OS" };

/**
 * The school's own data, on its way out.
 *
 * Every row here is a plain `<a download>` rather than a form or an action: a
 * download is a GET, and making it one keeps the whole feature working with no
 * JavaScript — which matters on the connections these schools actually have.
 *
 * A dataset the signed-in user may not take is not shown. The route refuses it
 * as well (403), because a hidden link is not a guard — the same lesson
 * /students taught with teachers.
 */
export default async function ExportPage({ searchParams }: PageProps<"/export">) {
  await requireRole(OFFICE);
  const auth = await requireAuth();
  const params = await searchParams;

  const { terms } = await getInvoiceFilterOptions();
  const currentTerm = await getCurrentTerm();
  const selectedTerm =
    (typeof params.term === "string" ? params.term : null) ?? currentTerm?.id ?? terms[0]?.id ?? "";

  const available = DATASET_NAMES.filter((name) => canAccess(auth.roles, dataset(name).roles));

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title="Export"
        subtitle="Your school's records, as spreadsheets you can keep"
      />

      <Card>
        <div className="border-b border-slate-200 p-4">
          <p className="text-sm text-slate-600">
            Every file is a CSV that opens in Excel or Google Sheets. Phone numbers keep
            their leading zero, and the students file uses the same columns as{" "}
            <span className="font-medium text-slate-900">Students → Import</span>, so it
            goes back in as well as out.
          </p>
          {terms.length > 0 ? (
            <form className="mt-3 flex flex-wrap items-center gap-2">
              <label className="text-sm text-slate-600" htmlFor="term">
                Term, for invoices, payments and results
              </label>
              <select id="term" name="term" defaultValue={selectedTerm} className={filterClass}>
                {terms.map((term) => (
                  <option key={term.id} value={term.id}>
                    {term.name} · {term.academicYear.name}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="rounded-card border border-hairline bg-surface px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Use this term
              </button>
            </form>
          ) : null}
        </div>

        <ul className="divide-y divide-slate-100">
          {available.map((name) => {
            const spec = dataset(name);
            const href = spec.needsTerm
              ? `/api/export/${name}?term=${selectedTerm}`
              : `/api/export/${name}`;
            const blocked = spec.needsTerm && !selectedTerm;

            return (
              <li key={name} className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-900">{spec.label}</p>
                  <p className="mt-0.5 text-sm text-slate-500">{spec.description}</p>
                  <p className="mt-1 font-mono text-xs text-slate-400">
                    {spec.headers.join(", ")}
                  </p>
                </div>
                {blocked ? (
                  <span className="shrink-0 text-sm text-slate-400">
                    Set up a term first
                  </span>
                ) : (
                  <a
                    href={href}
                    download
                    className="shrink-0 rounded-xl bg-brand-800 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700"
                  >
                    Download
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      <p className="text-xs text-slate-500">
        Every export is written to the audit trail — what was taken, by whom and when.
        These files hold children&rsquo;s names, dates of birth and their guardians&rsquo;
        phone numbers, so keep them somewhere you would keep the admission register.
      </p>
    </div>
  );
}
