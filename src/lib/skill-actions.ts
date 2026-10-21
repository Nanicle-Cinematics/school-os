"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { MARKING, MARK_ANY_CLASS, OFFICE, canAccess } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { rosterWhere } from "@/lib/class-roster";
import { ownsLevels, ownsSheet } from "@/lib/ownership";
import { refusalMessage } from "@/lib/score-limits";
import {
  SKILL_NAME_MAX,
  SKILLS_PER_AREA_MAX,
  areaCode,
  checkSkillGrade,
  checkSkillScore,
  splitSkillLines,
  usesSkillCard,
  type SkillGradeValue,
} from "@/lib/skills";

export type SkillState = { error?: string; ok?: string };

const tidy = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, SKILL_NAME_MAX);

/**
 * Edit the skills listed under each area of one level.
 *
 * The screen posts every skill of the level as `skill:<id>`, in the order they are shown, plus a
 * textarea per area (`add:<subjectId>`, one new skill a line). A row left blank removes its skill,
 * which is how a mistake is undone; a changed one renames it.
 *
 * ⚠️ A skill that children have already been rated on cannot be removed, only renamed. Removing it
 * would delete those ratings with it (the foreign key cascades) and take them off report cards that
 * were already printed, so it is refused and says how many. Same rule as a priced fee item.
 *
 * Every id here is read back through the tenant client: the level, and every skill, which is only
 * ever looked up among THIS level's own rows. A posted id that is not one of them is ignored.
 */
export async function saveLevelSkills(_prev: SkillState, formData: FormData): Promise<SkillState> {
  const auth = await requireRole(OFFICE);
  setTenantContext(auth.tenant);

  const levelId = String(formData.get("levelId") ?? "");
  if (!levelId || !(await ownsLevels([levelId]))) {
    return { error: "That level was not found in this school." };
  }
  const level = await prisma.level.findUnique({ where: { id: levelId }, select: { name: true, stage: true } });
  if (!level) {
    return { error: "That level was not found in this school." };
  }
  if (!usesSkillCard(level.stage)) {
    return { error: `${level.name} is marked out of 100, so it has no skills list to set up.` };
  }

  const offered = await prisma.levelSubject.findMany({
    where: { levelId },
    select: { subjectId: true, subject: { select: { name: true } } },
  });
  const areaName = new Map(offered.map((row) => [row.subjectId, row.subject.name]));

  const existing = await prisma.subjectSkill.findMany({
    where: { levelId },
    select: { id: true, name: true, subjectId: true, order: true },
  });
  const byId = new Map(existing.map((skill) => [skill.id, skill]));
  const ratedRows = existing.length
    ? await prisma.skillRating.groupBy({
        by: ["skillId"],
        where: { skillId: { in: existing.map((skill) => skill.id) } },
        _count: { _all: true },
      })
    : [];
  const rated = new Map(ratedRows.map((row) => [row.skillId, row._count._all]));

  // What the form said, per area, in the order it was shown. A skill the form did not mention is left
  // exactly as it is: a partial post must not read as "delete everything else".
  const posted = new Map<string, { id: string; name: string }[]>();
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("skill:")) continue;
    const skill = byId.get(key.slice("skill:".length));
    if (!skill || !areaName.has(skill.subjectId)) continue;
    const list = posted.get(skill.subjectId) ?? [];
    list.push({ id: skill.id, name: tidy(String(value)) });
    posted.set(skill.subjectId, list);
  }

  const removals: string[] = [];
  const renames: { id: string; name: string; order: number }[] = [];
  const reorders: { id: string; order: number }[] = [];
  const creations: Prisma.SubjectSkillCreateManyInput[] = [];
  const blocked: string[] = [];

  for (const [subjectId, area] of areaName) {
    const rows = posted.get(subjectId) ?? [];
    const untouched = existing.filter((skill) => skill.subjectId === subjectId && !rows.some((r) => r.id === skill.id));
    const kept = rows.filter((row) => row.name !== "");

    for (const row of rows.filter((r) => r.name === "")) {
      const count = rated.get(row.id) ?? 0;
      if (count > 0) {
        blocked.push(
          `"${byId.get(row.id)!.name}" under ${area} has ratings for ${count} child${count === 1 ? "" : "ren"}, so it can be renamed but not removed`,
        );
      } else {
        removals.push(row.id);
      }
    }

    const names = [...kept.map((row) => row.name), ...untouched.map((skill) => skill.name)];
    const lower = names.map((name) => name.toLowerCase());
    const repeated = names.find((_, index) => lower.indexOf(lower[index]) !== index);
    if (repeated) {
      return { error: `"${repeated}" is listed twice under ${area}. Nothing was saved.` };
    }

    const { added, tooMany } = splitSkillLines(String(formData.get(`add:${subjectId}`) ?? ""), names);
    if (tooMany || names.length + added.length > SKILLS_PER_AREA_MAX) {
      return { error: `${area} can list at most ${SKILLS_PER_AREA_MAX} skills. Nothing was saved.` };
    }

    kept.forEach((row, index) => {
      const had = byId.get(row.id)!;
      if (had.name !== row.name) {
        renames.push({ id: row.id, name: row.name, order: index });
      } else if (had.order !== index) {
        reorders.push({ id: row.id, order: index });
      }
    });
    added.forEach((name, index) => {
      creations.push({ schoolId: auth.schoolId, levelId, subjectId, name, order: kept.length + index });
    });
  }

  if (blocked.length > 0) {
    return { error: `Nothing was saved. ${blocked.join("; ")}.` };
  }
  if (removals.length + renames.length + reorders.length + creations.length === 0) {
    return { ok: "Nothing to change." };
  }

  try {
    await tenantTransaction(auth.schoolId, async (tx) => {
      if (removals.length > 0) {
        await tx.subjectSkill.deleteMany({ where: { id: { in: removals }, levelId } });
      }
      for (const change of renames) {
        await tx.subjectSkill.update({ where: { id: change.id }, data: { name: change.name, order: change.order } });
      }
      for (const change of reorders) {
        await tx.subjectSkill.update({ where: { id: change.id }, data: { order: change.order } });
      }
      if (creations.length > 0) {
        await tx.subjectSkill.createMany({ data: creations });
      }
      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: "skills.configure",
        entity: "Level",
        entityId: levelId,
        after: {
          added: creations.length,
          removed: removals.length,
          renamed: renames.length,
        },
      });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { error: "Two skills under one area cannot have the same name. Nothing was saved." };
    }
    throw error;
  }

  revalidatePath("/subjects/skills");
  const parts = [
    creations.length ? `${creations.length} added` : "",
    renames.length ? `${renames.length} renamed` : "",
    removals.length ? `${removals.length} removed` : "",
  ].filter(Boolean);
  return { ok: `Saved ${level.name}: ${parts.join(", ") || "order updated"}.` };
}

/**
 * Add an area to a level: "Language", "Free play". An area is an ordinary subject offered at the
 * level, so it also appears wherever subjects do; the skills are what make it a section of the card.
 * A subject the school already has under that name is reused rather than duplicated.
 */
export async function addSkillArea(_prev: SkillState, formData: FormData): Promise<SkillState> {
  const auth = await requireRole(OFFICE);
  setTenantContext(auth.tenant);

  const levelId = String(formData.get("levelId") ?? "");
  const name = tidy(String(formData.get("name") ?? ""));
  if (!name) {
    return { error: "Give the area a name, such as Language or Free play." };
  }
  if (!levelId || !(await ownsLevels([levelId]))) {
    return { error: "That level was not found in this school." };
  }
  const level = await prisma.level.findUnique({ where: { id: levelId }, select: { name: true, stage: true } });
  if (!level || !usesSkillCard(level.stage)) {
    return { error: "Areas with skills belong to the nursery levels." };
  }

  const subjects = await prisma.subject.findMany({ select: { id: true, name: true, code: true, order: true } });
  const same = subjects.find((subject) => subject.name.toLowerCase() === name.toLowerCase());

  const already = same
    ? await prisma.levelSubject.count({ where: { levelId, subjectId: same.id } })
    : 0;
  if (already > 0) {
    return { error: `${same!.name} is already an area of ${level.name}.` };
  }
  const placed = await prisma.levelSubject.aggregate({ where: { levelId }, _max: { order: true } });

  try {
    await tenantTransaction(auth.schoolId, async (tx) => {
      const subject =
        same ??
        (await tx.subject.create({
          data: {
            schoolId: auth.schoolId,
            name,
            code: areaCode(name, subjects.map((s) => s.code)),
            order: Math.max(0, ...subjects.map((s) => s.order)) + 10,
          },
        }));
      await tx.levelSubject.create({
        data: {
          schoolId: auth.schoolId,
          levelId,
          subjectId: subject.id,
          isElective: false,
          countsForAggregate: false,
          order: (placed._max.order ?? 0) + 1,
        },
      });
      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: "skills.area",
        entity: "Level",
        entityId: levelId,
        after: { name: subject.name, reused: Boolean(same) },
      });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { error: "Another subject already uses that short code. Try a slightly different name." };
    }
    throw error;
  }

  revalidatePath("/subjects/skills");
  revalidatePath("/subjects");
  return { ok: `Added ${name} to ${level.name}. List its skills below.` };
}

/**
 * Save one class's ratings for one area, for the term.
 *
 * The grid posts `score:<skillId>:<studentId>` and `grade:<skillId>:<studentId>` for every cell it
 * shows. A cell with both blank holds no rating, and clears one that was there.
 *
 * ⚠️ All or nothing, naming every refusal (the same rule as a mark): a typed 120, or a grade that is
 * not in the key, stops the save and says whose it is, rather than saving the other thirty-nine and
 * leaving the teacher to find the one that did not go.
 *
 * Who may write: leadership and the IT admin for any class, a teacher for a class they teach
 * anything in (the rule the remarks screen uses: the class teacher of a nursery class is the one
 * person who assesses every area, and may not be assigned each one). Skills and pupils are read back
 * from THIS class and area, so a forged key for another class's child or skill is ignored. A pupil
 * whose card is PUBLISHED is settled and is skipped, like a published remark.
 */
export async function saveSkillRatings(_prev: SkillState, formData: FormData): Promise<SkillState> {
  const auth = await requireRole(MARKING);
  setTenantContext(auth.tenant);

  const termId = String(formData.get("termId") ?? "");
  const classGroupId = String(formData.get("classGroupId") ?? "");
  const subjectId = String(formData.get("subjectId") ?? "");
  if (!termId || !classGroupId || !subjectId) {
    return { error: "Choose a term, a class and an area." };
  }
  if (!(await ownsSheet(termId, classGroupId, subjectId))) {
    return { error: "That term, class or area was not found in this school." };
  }

  const term = await prisma.term.findUnique({ where: { id: termId }, select: { academicYearId: true } });
  const classGroup = await prisma.classGroup.findUnique({
    where: { id: classGroupId },
    select: { levelId: true, level: { select: { stage: true } } },
  });
  if (!term || !classGroup) {
    return { error: "That term or class was not found in this school." };
  }
  if (!usesSkillCard(classGroup.level.stage)) {
    return { error: "That class is marked out of 100; it has no skills to rate." };
  }

  if (!canAccess(auth.roles, MARK_ANY_CLASS)) {
    if (!auth.staffId) {
      return { error: "Your account is not linked to a staff record." };
    }
    const teaches = await prisma.teachingAssignment.count({
      where: { staffId: auth.staffId, classGroupId, academicYearId: term.academicYearId },
    });
    if (teaches === 0) {
      return { error: "You do not teach in that class." };
    }
  }

  const skills = await prisma.subjectSkill.findMany({
    where: { levelId: classGroup.levelId, subjectId },
    select: { id: true, name: true },
  });
  if (skills.length === 0) {
    return { error: "That area has no skills listed for this level yet." };
  }
  const skillName = new Map(skills.map((skill) => [skill.id, skill.name]));

  const roster = await prisma.enrollment.findMany({
    where: rosterWhere(term.academicYearId, classGroupId),
    select: { student: { select: { id: true, firstName: true, lastName: true } } },
  });
  const pupil = new Map(roster.map((row) => [row.student.id, row.student]));

  const settled = new Set(
    (
      await prisma.termResult.findMany({
        where: { termId, studentId: { in: [...pupil.keys()] }, status: "PUBLISHED" },
        select: { studentId: true },
      })
    ).map((row) => row.studentId),
  );

  // Every (skill, pupil) the form carries a cell for, with what was typed.
  type Wanted = { skillId: string; studentId: string; score: number | null; grade: SkillGradeValue | null };
  const cells = new Map<string, { skillId: string; studentId: string; score: string; grade: string }>();
  for (const [key, value] of formData.entries()) {
    const match = /^(score|grade):([^:]+):([^:]+)$/.exec(key);
    if (!match) continue;
    const [, kind, skillId, studentId] = match;
    if (!skillName.has(skillId) || !pupil.has(studentId) || settled.has(studentId)) continue;
    const cell = cells.get(`${skillId}:${studentId}`) ?? { skillId, studentId, score: "", grade: "" };
    cell[kind as "score" | "grade"] = String(value);
    cells.set(`${skillId}:${studentId}`, cell);
  }

  const problems: string[] = [];
  const wanted: Wanted[] = [];
  for (const cell of cells.values()) {
    const who = pupil.get(cell.studentId)!;
    const label = `${who.lastName}, ${who.firstName} (${skillName.get(cell.skillId)})`;
    const score = checkSkillScore(cell.score);
    const grade = checkSkillGrade(cell.grade);
    if (!score.ok) problems.push(`${label}: ${score.reason}`);
    if (!grade.ok) problems.push(`${label}: ${grade.reason}`);
    if (score.ok && grade.ok) {
      wanted.push({ skillId: cell.skillId, studentId: cell.studentId, score: score.value, grade: grade.grade });
    }
  }
  if (problems.length > 0) {
    return { error: refusalMessage(problems) };
  }
  if (wanted.length === 0) {
    return {
      error:
        settled.size > 0
          ? "Those report cards are published, so their ratings are locked."
          : "Nothing to save.",
    };
  }

  const studentIds = [...new Set(wanted.map((cell) => cell.studentId))];
  const had = new Map(
    (
      await prisma.skillRating.findMany({
        where: { termId, skillId: { in: skills.map((s) => s.id) }, studentId: { in: studentIds } },
        select: { id: true, skillId: true, studentId: true, score: true, grade: true },
      })
    ).map((row) => [`${row.skillId}:${row.studentId}`, row]),
  );

  // A diff, not an upsert per cell: only what changed is written (the same lesson as the mark sheet).
  const creates: Prisma.SkillRatingCreateManyInput[] = [];
  const updates: { id: string; score: number | null; grade: SkillGradeValue | null }[] = [];
  const clears: string[] = [];
  for (const cell of wanted) {
    const row = had.get(`${cell.skillId}:${cell.studentId}`);
    const empty = cell.score === null && cell.grade === null;
    if (!row) {
      if (!empty) {
        creates.push({
          schoolId: auth.schoolId,
          termId,
          studentId: cell.studentId,
          skillId: cell.skillId,
          score: cell.score === null ? null : new Prisma.Decimal(cell.score),
          grade: cell.grade,
        });
      }
    } else if (empty) {
      clears.push(row.id);
    } else if ((row.score === null ? null : Number(row.score)) !== cell.score || row.grade !== cell.grade) {
      updates.push({ id: row.id, score: cell.score, grade: cell.grade });
    }
  }

  // The card exists as soon as a child has a rating, so it can be approved and published from Results
  // without anyone first having to type a remark. Never touches one that is already there.
  const needCard = [...new Set(creates.map((row) => row.studentId))];

  await tenantTransaction(auth.schoolId, async (tx) => {
    if (clears.length > 0) {
      await tx.skillRating.deleteMany({ where: { id: { in: clears } } });
    }
    for (const update of updates) {
      await tx.skillRating.update({
        where: { id: update.id },
        data: { score: update.score === null ? null : new Prisma.Decimal(update.score), grade: update.grade },
      });
    }
    if (creates.length > 0) {
      await tx.skillRating.createMany({ data: creates, skipDuplicates: true });
    }
    if (needCard.length > 0) {
      await tx.termResult.createMany({
        data: needCard.map((studentId) => ({ schoolId: auth.schoolId, termId, studentId, classGroupId })),
        skipDuplicates: true,
      });
    }
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "skills.save",
      entity: "ClassGroup",
      entityId: classGroupId,
      after: {
        termId,
        subjectId,
        pupils: studentIds.length,
        written: creates.length + updates.length,
        cleared: clears.length,
      },
    });
  });

  revalidatePath("/results/skills");
  revalidatePath("/results");
  const changed = creates.length + updates.length + clears.length;
  const locked = settled.size > 0 ? ` ${settled.size} published card${settled.size === 1 ? " was" : "s were"} left as published.` : "";
  return {
    ok:
      changed === 0
        ? `Nothing had changed.${locked}`
        : `Saved ${creates.length + updates.length} rating${creates.length + updates.length === 1 ? "" : "s"}${clears.length ? ` and cleared ${clears.length}` : ""}.${locked}`,
  };
}
