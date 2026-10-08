import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { LEADERSHIP } from "@/lib/permissions";
import { getJhsBroadsheet } from "@/lib/jhs-broadsheet-data";
import { getBillSchool } from "@/lib/invoice-data";
import { prisma } from "@/lib/prisma";
import { buttonClass } from "../../button-style";
import { PrintButton } from "../../print-button";
import { Alert, Card, PageHeader, filterClass } from "../../ui";
import { JhsBroadsheetSheet } from "./broadsheet-sheet";

export const metadata: Metadata = { title: "JHS 1–3 broadsheet · School OS" };

/**
 * One of this year's JHS classes, across every JHS term on record.
 *
 * Leadership only, like the cumulative records it summarises: those draw on
 * the earlier-year records, which are the office's own and not published.
 */
export default async function JhsBroadsheetPage({ searchParams }: PageProps<"/results/jhs-broadsheet">) {
  const auth = await requireRole(LEADERSHIP);
  const query = await searchParams;
  const classGroupId = typeof query.class === "string" ? query.class : "";
  // Twelve more columns do not fit a landscape sheet, so the SBA is a second
  // VIEW of the same cells rather than a second set of them.
  const view = query.view === "sba" ? "sba" : "averages";

  const { current, classes, classGroup, sheet } = await getJhsBroadsheet(auth.schoolId, classGroupId);
  const school = sheet ? await getBillSchool(auth.schoolId) : null;
  const settings = sheet
    ? await prisma.schoolSettings.findFirst({
        where: { schoolId: auth.schoolId },
        select: { showClassPosition: true },
      })
    : null;

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="print:hidden">
        <PageHeader
          title="JHS 1–3 broadsheet"
          subtitle={
            classGroup
              ? `${classGroup.level.name} ${classGroup.name} · every JHS term on record`
              : "A JHS class across all three years, one row per pupil."
          }
          action={sheet && sheet.rows.length > 0 ? <PrintButton label="Print broadsheet" /> : null}
        />
      </div>

      <div className="print:hidden">
      <Card>
        <form method="get" className="flex flex-wrap items-end gap-3 p-4">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-slate-500">Class this year</span>
            <select name="class" defaultValue={classGroupId} className={filterClass}>
              <option value="">Choose…</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.level.name} {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-slate-500">Show</span>
            <select name="view" defaultValue={view} className={filterClass}>
              <option value="averages">Term averages</option>
              <option value="sba">SBA (out of 30)</option>
            </select>
          </label>
          <button type="submit" className={buttonClass("primary")}>
            Show broadsheet
          </button>
          <Link href="/results/records" className="mb-2 text-sm text-brand-ink hover:underline">
            Enter earlier years
          </Link>
        </form>
      </Card>
      </div>

      {!current ? (
        <Alert tone="error">There is no current academic year. Set one on Settings → Terms.</Alert>
      ) : classes.length === 0 ? (
        <Alert tone="error">This school has no JHS classes.</Alert>
      ) : !classGroup ? null : !sheet || sheet.rows.length === 0 ? (
        <Alert tone="error">
          Nobody is on the roll of {classGroup.level.name} {classGroup.name} for {current.name}.
        </Alert>
      ) : school ? (
        <JhsBroadsheetSheet
          school={school}
          className={`${classGroup.level.name} ${classGroup.name}`}
          yearName={current.name}
          subjects={sheet.subjects}
          rows={sheet.rows}
          showClassPosition={settings?.showClassPosition ?? true}
          view={view}
          printedOn={new Date()}
        />
      ) : null}
    </div>
  );
}
