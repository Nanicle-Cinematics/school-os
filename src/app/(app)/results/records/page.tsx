import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { LEADERSHIP } from "@/lib/permissions";
import { getRecordsSheet } from "@/lib/records-data";
import { buttonClass } from "../../button-style";
import { ButtonLink } from "../../primitives";
import { PageHeader, Card, Alert, filterClass } from "../../ui";
import { RecordsForm } from "./records-form";

export const metadata: Metadata = { title: "Results from records · School OS" };

const TERM_NAME: Record<string, string> = { FIRST: "First", SECOND: "Second", THIRD: "Third" };

/**
 * Step two of entering earlier years: a subject's term figures, from paper.
 *
 * Only terms of years that ended before the current one are offered — this
 * year is marked on the mark sheet, and the two must never claim the same term.
 */
export default async function RecordsPage({ searchParams }: PageProps<"/results/records">) {
  await requireRole(LEADERSHIP);
  const query = await searchParams;
  const termId = typeof query.term === "string" ? query.term : "";
  const classGroupId = typeof query.class === "string" ? query.class : "";
  const subjectId = typeof query.subject === "string" ? query.subject : "";

  const sheet = await getRecordsSheet(termId, classGroupId, subjectId);
  const { current, earlier, terms, classGroups, term, classGroup, subjects, subject, weights, rows } = sheet;

  // A sheet holding totals with no split behind them was entered as totals;
  // reopen it that way rather than showing two empty columns over a number.
  const enteredAsTotals =
    rows.some((row) => row.totalScore !== null) &&
    rows.every((row) => row.totalScore === null || (row.classScore === null && row.examScore === null));
  const format = query.format === "total" || query.format === "split" ? query.format : enteredAsTotals ? "total" : "split";

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Results from records"
        subtitle={
          term && classGroup && subject
            ? `${classGroup.level.name} ${classGroup.name} · ${TERM_NAME[term.name] ?? term.name} Term ${term.academicYear.name} · ${subject.name}`
            : "Term results for the years before School OS, entered from the school's own records."
        }
        action={
          <ButtonLink href="/results/records/classes" variant="secondary">
            Earlier classes
          </ButtonLink>
        }
      />

      {!current ? (
        <Alert tone="error">
          There is no current academic year, so no year can be told apart as earlier. Set one on
          Settings → Terms.
        </Alert>
      ) : earlier.length === 0 ? (
        <Card>
          <div className="space-y-3 p-5 text-sm text-slate-600">
            <p>
              No earlier years are set up yet. Results from records go into a year that ended before{" "}
              {current.name} began: add those years with their real dates first, then place the pupils
              in the classes they sat in.
            </p>
            <ButtonLink href="/settings/terms" variant="primary">
              Add an earlier year
            </ButtonLink>
          </div>
        </Card>
      ) : (
        <>
          <Card>
            <form method="get" className="flex flex-wrap items-end gap-3 p-4">
              <label className="text-sm">
                <span className="mb-1 block text-xs font-medium text-slate-500">Term</span>
                <select name="term" defaultValue={term?.id ?? ""} className={filterClass}>
                  <option value="">Choose…</option>
                  {terms.map((t) => (
                    <option key={t.id} value={t.id}>
                      {TERM_NAME[t.name] ?? t.name} Term · {t.academicYear.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-xs font-medium text-slate-500">Class that year</span>
                <select name="class" defaultValue={classGroupId} className={filterClass}>
                  <option value="">Choose…</option>
                  {classGroups.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.level.name} {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-xs font-medium text-slate-500">Subject</span>
                <select name="subject" defaultValue={subject?.id ?? ""} className={filterClass}>
                  <option value="">{classGroup ? "Choose…" : "Choose a class first"}</option>
                  {subjects.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-xs font-medium text-slate-500">The records hold</span>
                <select name="format" defaultValue={format} className={filterClass}>
                  <option value="split">Class score and exam score</option>
                  <option value="total">A total out of 100 only</option>
                </select>
              </label>
              <button type="submit" className={buttonClass("primary")}>
                Open sheet
              </button>
            </form>
          </Card>

          {!term || !classGroup || !subject ? (
            <Card>
              <div className="space-y-2 px-4 py-8 text-center text-sm text-slate-500">
                <p>
                  Choose a term, the class the pupils sat in that year, and a subject. The pupils listed
                  are the ones placed in that class on Earlier classes — place them there first.
                </p>
                <p>
                  These results are the school&rsquo;s own record. They are never published to parents
                  and never decide a promotion.
                </p>
              </div>
            </Card>
          ) : rows.length === 0 ? (
            <Alert tone="error">
              Nobody is placed in {classGroup.level.name} {classGroup.name} for {term.academicYear.name}.
              Record where the pupils sat that year on Earlier classes first.
            </Alert>
          ) : (
            <Card>
              <RecordsForm
                key={`${term.id}:${classGroup.id}:${subject.id}:${format}`}
                termId={term.id}
                classGroupId={classGroup.id}
                subjectId={subject.id}
                format={format}
                classWeight={weights.classWeight}
                examWeight={weights.examWeight}
                rows={rows}
              />
            </Card>
          )}
        </>
      )}
    </div>
  );
}
