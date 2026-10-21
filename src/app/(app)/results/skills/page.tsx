import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { MARKING, MARK_ANY_CLASS, OFFICE, canAccess } from "@/lib/permissions";
import { getSheetOptions } from "@/lib/sheet-data";
import { getSkillGrid, getSkillSections } from "@/lib/skill-data";
import { SKILL_CARD_STAGES } from "@/lib/skills";
import { prisma } from "@/lib/prisma";
import { PageHeader, Card, Alert, inputClass } from "../../ui";
import { buttonClass } from "../../button-style";
import { SkillsGrid } from "./skills-grid";

export const metadata: Metadata = { title: "Skills and ratings · School OS" };

const TERM_NAME: Record<string, string> = { FIRST: "First", SECOND: "Second", THIRD: "Third" };

/**
 * A nursery class's skills, one area at a time: the children down, the area's skills across, a score
 * out of 100 and an A/B/C rating in each cell. It is the nursery's mark sheet, and it fills the same
 * progress report the school prints on paper today.
 *
 * Who reaches a class is the rule the remarks screen uses: leadership and the IT admin any class, a
 * teacher a class they teach anything in. The action checks it again; this page checks it so it never
 * renders a grid its viewer cannot save.
 */
export default async function SkillsEntryPage({ searchParams }: PageProps<"/results/skills">) {
  const auth = await requireRole(MARKING);
  const query = await searchParams;
  const anyClass = canAccess(auth.roles, MARK_ANY_CLASS);

  const { terms, classGroups, pairs } = await getSheetOptions({ staffId: auth.staffId, anyClass });
  const nurseryClasses = classGroups.length
    ? await prisma.classGroup.findMany({
        where: { id: { in: classGroups.map((c) => c.id) }, level: { stage: { in: [...SKILL_CARD_STAGES] } } },
        orderBy: [{ level: { order: "asc" } }, { name: "asc" }],
        select: { id: true, name: true, levelId: true, level: { select: { name: true } } },
      })
    : [];

  const termId =
    typeof query.term === "string" ? query.term : (terms.find((t) => t.isCurrent)?.id ?? "");
  const classGroupId = typeof query.class === "string" ? query.class : "";
  const classGroup = nurseryClasses.find((c) => c.id === classGroupId);
  const term = terms.find((t) => t.id === termId);

  const allowed = !pairs || !classGroup || pairs.some((p) => p.classGroupId === classGroupId);
  const sections = classGroup && allowed ? await getSkillSections(classGroup.levelId) : [];
  const subjectId =
    typeof query.area === "string" && sections.some((s) => s.subjectId === query.area)
      ? query.area
      : (sections[0]?.subjectId ?? "");
  const section = sections.find((s) => s.subjectId === subjectId);

  const grid =
    classGroup && allowed && termId && section
      ? await getSkillGrid(termId, classGroup.id, section.subjectId, classGroup.levelId)
      : null;

  const href = (area: string) =>
    `/results/skills?${new URLSearchParams({ term: termId, class: classGroupId, area }).toString()}`;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Skills and ratings"
        subtitle={
          grid && classGroup
            ? `${classGroup.level.name} ${classGroup.name} · ${section?.subjectName} · ${
                TERM_NAME[term?.name ?? ""] ?? ""
              } Term · ${grid.students.length} children`
            : "The nursery progress report: a score and a rating for each skill."
        }
        action={
          <Link
            href={anyClass ? "/results" : "/results/remarks"}
            className={buttonClass("secondary")}
          >
            {anyClass ? "Results" : "Conduct & remarks"}
          </Link>
        }
      />

      <Card>
        <form method="get" className="flex flex-wrap items-end gap-3 p-4">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-slate-500">Term</span>
            <select name="term" defaultValue={termId} className={inputClass}>
              {terms.map((t) => (
                <option key={t.id} value={t.id}>
                  {TERM_NAME[t.name] ?? t.name} Term · {t.academicYear.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-slate-500">Class</span>
            <select name="class" defaultValue={classGroupId} className={inputClass}>
              <option value="">Choose…</option>
              {nurseryClasses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.level.name} {c.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={buttonClass("primary")}>
            Open
          </button>
        </form>
      </Card>

      {nurseryClasses.length === 0 ? (
        <Card>
          <p className="px-4 py-10 text-center text-sm text-slate-500">
            {anyClass
              ? "There are no nursery classes yet. Add a class under a Nursery level first."
              : "You are not assigned to a nursery class. The school office assigns classes."}
          </p>
        </Card>
      ) : null}

      {!allowed ? (
        <Alert tone="error">
          You do not teach in that class, so its ratings are not yours to enter.
        </Alert>
      ) : null}

      {nurseryClasses.length > 0 && !classGroup && allowed ? (
        <Card>
          <p className="px-4 py-10 text-center text-sm text-slate-500">
            Choose a nursery class above. Each area of the report (Language, Reading and so on) is its own
            sheet, so the whole class can be rated on one area at a time.
          </p>
        </Card>
      ) : null}

      {classGroup && allowed && sections.length === 0 ? (
        <Card title="No skills are listed yet">
          <div className="p-4 text-sm text-slate-600">
            {classGroup.level.name} has no skills to rate.{" "}
            {canAccess(auth.roles, OFFICE) ? (
              <>
                List them under{" "}
                <Link href={`/subjects/skills?level=${classGroup.levelId}`} className="font-medium text-brand-ink hover:underline">
                  Subjects → Nursery skills
                </Link>
                .
              </>
            ) : (
              "Ask the school office to list them."
            )}
          </div>
        </Card>
      ) : null}

      {classGroup && allowed && sections.length > 0 ? (
        <nav aria-label="Areas" className="flex flex-wrap gap-2">
          {sections.map((s) => (
            <Link
              key={s.subjectId}
              href={href(s.subjectId)}
              aria-current={s.subjectId === subjectId ? "page" : undefined}
              className={buttonClass(s.subjectId === subjectId ? "primary" : "secondary", "sm")}
            >
              {s.subjectName}
            </Link>
          ))}
        </nav>
      ) : null}

      {grid && grid.students.length === 0 ? (
        <Alert tone="error">
          No children are placed in {classGroup?.level.name} {classGroup?.name} this year, so there is nobody to
          rate. Place children in the class first.
        </Alert>
      ) : null}

      {grid && section && grid.students.length > 0 ? (
        <SkillsGrid
          key={`${termId}:${classGroupId}:${subjectId}`}
          termId={termId}
          classGroupId={classGroupId}
          subjectId={subjectId}
          skills={grid.skills}
          students={grid.students}
          ratings={grid.ratings}
          locked={grid.locked}
        />
      ) : null}
    </div>
  );
}
