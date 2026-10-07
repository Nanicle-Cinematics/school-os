import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { LEADERSHIP } from "@/lib/permissions";
import { getPlacementSheet } from "@/lib/records-data";
import { buttonClass } from "../../../button-style";
import { ButtonLink } from "../../../primitives";
import { PageHeader, Card, Alert, filterClass } from "../../../ui";
import { PlacementForm } from "./placement-form";

export const metadata: Metadata = { title: "Earlier classes · School OS" };

/**
 * Step one of entering earlier years: which class each of today's pupils sat in.
 *
 * A record from 2024/25 belongs to the class the child sat in THEN, so the
 * results screen cannot open a past term until the roll for that year exists.
 * This builds it one current class at a time, with a guess already filled in.
 */
export default async function EarlierClassesPage({ searchParams }: PageProps<"/results/records/classes">) {
  await requireRole(LEADERSHIP);
  const query = await searchParams;
  const yearId = typeof query.year === "string" ? query.year : "";
  const classGroupId = typeof query.class === "string" ? query.class : "";

  const sheet = await getPlacementSheet(yearId, classGroupId);
  const { current, earlier, classGroups, year, classGroup, rows } = sheet;
  const chosenYear = year?.id ?? earlier[0]?.id ?? "";

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Earlier classes"
        subtitle={
          year && classGroup
            ? `${classGroup.level.name} ${classGroup.name} today · where they sat in ${year.name}`
            : "Step one of entering results from a year before School OS."
        }
        action={
          <ButtonLink href="/results/records" variant="secondary">
            Results from records
          </ButtonLink>
        }
      />

      {!current ? (
        <Alert tone="error">
          There is no current academic year, so there is nothing to count back from. Set one on
          Settings → Terms.
        </Alert>
      ) : earlier.length === 0 ? (
        <Card>
          <div className="space-y-3 p-5 text-sm text-slate-600">
            <p>
              No earlier years are set up yet. Add each year the pupils were here before{" "}
              {current.name} — for a JHS 3 class, the two years before this one — with its real
              dates, and leave &ldquo;make current&rdquo; unticked.
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
                <span className="mb-1 block text-xs font-medium text-slate-500">Earlier year</span>
                <select name="year" defaultValue={chosenYear} className={filterClass}>
                  {earlier.map((y) => (
                    <option key={y.id} value={y.id}>
                      {y.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-xs font-medium text-slate-500">Class today</span>
                <select name="class" defaultValue={classGroupId} className={filterClass}>
                  <option value="">Choose…</option>
                  {classGroups.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.level.name} {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className={buttonClass("primary")}>
                Open class
              </button>
            </form>
          </Card>

          {!year || !classGroup ? (
            <Card>
              <p className="px-4 py-10 text-center text-sm text-slate-500">
                Choose an earlier year and one of today&rsquo;s classes. Each pupil is given the class
                they most likely sat in that year — the same stream, the right number of levels down
                — and you correct anyone who repeated, changed stream or joined later.
              </p>
            </Card>
          ) : rows.length === 0 ? (
            <Alert tone="error">
              Nobody is on the roll of {classGroup.level.name} {classGroup.name} for {current.name}.
            </Alert>
          ) : (
            <Card>
              <PlacementForm
                yearId={year.id}
                yearName={year.name}
                classGroupId={classGroup.id}
                rows={rows}
                classes={classGroups.map((c) => ({ id: c.id, label: `${c.level.name} ${c.name}` }))}
              />
            </Card>
          )}
        </>
      )}
    </div>
  );
}
