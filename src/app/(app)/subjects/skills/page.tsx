import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { getSkillLevels, getSkillSetup } from "@/lib/skill-data";
import { SKILL_GRADES, SKILL_GRADE_LABEL } from "@/lib/skills";
import { PageHeader, Card, filterClass } from "../../ui";
import { buttonClass } from "../../button-style";
import { AddAreaForm } from "./add-area-form";
import { SkillsSetupForm } from "./skills-setup-form";

export const metadata: Metadata = { title: "Nursery skills · School OS" };

/**
 * The skills a nursery report lists under each area: Language > News telling, Poem recitals.
 *
 * Per LEVEL, because Nursery 2 is not Nursery 1 with the same list. The areas themselves are ordinary
 * subjects offered at the level; what this screen adds is the list under each one, which is what the
 * card prints and what a teacher rates.
 */
export default async function SkillsSetupPage({ searchParams }: PageProps<"/subjects/skills">) {
  await requireRole(OFFICE);
  const query = await searchParams;

  const levels = await getSkillLevels();
  const levelId =
    typeof query.level === "string" && levels.some((level) => level.id === query.level)
      ? query.level
      : (levels[0]?.id ?? "");
  const level = levels.find((l) => l.id === levelId);
  const setup = level ? await getSkillSetup(level.id) : null;
  const total = setup?.areas.reduce((sum, area) => sum + area.skills.length, 0) ?? 0;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title="Nursery skills"
        subtitle={
          level
            ? `${level.name} · ${setup?.areas.length ?? 0} area${setup?.areas.length === 1 ? "" : "s"}, ${total} skill${total === 1 ? "" : "s"}`
            : "What a nursery progress report lists and rates."
        }
        action={
          <Link href="/subjects" className={buttonClass("secondary")}>
            Subjects
          </Link>
        }
      />

      {levels.length === 0 ? (
        <Card>
          <p className="px-4 py-10 text-center text-sm text-slate-500">
            This school has no nursery levels. They are added with the national curriculum under{" "}
            <Link href="/settings/structure" className="font-medium text-brand-ink hover:underline">
              Settings → School structure
            </Link>
            .
          </p>
        </Card>
      ) : (
        <>
          <Card>
            <form method="get" className="flex flex-wrap items-end gap-3 p-4">
              <label className="text-sm">
                <span className="mb-1 block text-xs font-medium text-slate-500">Level</span>
                <select name="level" defaultValue={levelId} className={filterClass}>
                  {levels.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className={buttonClass("primary")}>
                Show
              </button>
            </form>
          </Card>

          <div className="rounded-card border border-hairline bg-surface px-4 py-3 text-sm text-slate-600">
            <span className="font-medium text-slate-900">How the card reads: </span>
            each skill is given a score out of 100 and a rating,{" "}
            {SKILL_GRADES.map((g) => `${g} ${SKILL_GRADE_LABEL[g].toLowerCase()}`).join(", ")}. Teachers
            enter them under{" "}
            <Link href="/results/skills" className="font-medium text-brand-ink hover:underline">
              Results → Skills &amp; ratings
            </Link>
            , and Nursery cards print from the Results screen like any other.
          </div>

          {level && setup ? (
            <>
              <AddAreaForm levelId={level.id} levelName={level.name} />
              {setup.areas.length === 0 ? (
                <Card>
                  <p className="px-4 py-8 text-center text-sm text-slate-500">
                    {level.name} offers no subjects yet. Add the first area above, such as Language.
                  </p>
                </Card>
              ) : (
                <SkillsSetupForm levelId={level.id} areas={setup.areas} />
              )}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
