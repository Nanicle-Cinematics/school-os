"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { LEADERSHIP } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { rosterWhere } from "@/lib/class-roster";
import { gradeFor } from "@/lib/results-engine";
import { isEarlierYear, loadGradingBands, parseRecordedMark, rollUpRecords } from "@/lib/records-engine";

export type RecordsState = {
  error?: string;
  ok?: string;
  /**
   * What was typed, handed back when a sheet is refused. React resets a form's
   * fields once its action completes (see CLAUDE.md), so without this a refusal
   * over one mistyped mark would also wipe the thirty-nine marks typed correctly.
   */
  values?: Record<string, string>;
};

/** The year must have ENDED before the current one began — see records-engine.ts. */
async function earlierYear(academicYearId: string) {
  const current = await prisma.academicYear.findFirst({
    where: { isCurrent: true },
    select: { startDate: true },
  });
  const year = await prisma.academicYear.findUnique({
    where: { id: academicYearId },
    select: { id: true, name: true, endDate: true },
  });
  return year && isEarlierYear(year, current) ? year : null;
}

/**
 * Step one: record which class each of a current class's pupils sat in, in an
 * earlier year.
 *
 * Every row is re-checked here rather than trusted from the form: the pupil
 * must be on the current class's roll today, the class must exist, and a pupil
 * whose earlier term already holds results keeps the placement those results
 * hang off — moving them would leave a report card pointing at a class the
 * child is no longer recorded in.
 */
export async function saveEarlierClasses(_prev: RecordsState, formData: FormData): Promise<RecordsState> {
  const auth = await requireRole(LEADERSHIP);
  setTenantContext(auth.tenant);

  const yearId = String(formData.get("yearId") ?? "");
  const classGroupId = String(formData.get("classGroupId") ?? "");

  const year = await earlierYear(yearId);
  if (!year) {
    return { error: "Earlier classes can only be recorded for a year that ended before this one began." };
  }
  const current = await prisma.academicYear.findFirst({ where: { isCurrent: true }, select: { id: true } });
  if (!current) {
    return { error: "Set the current academic year first, on Settings → Terms." };
  }

  const roll = await prisma.enrollment.findMany({
    where: rosterWhere(current.id, classGroupId),
    select: { studentId: true, student: { select: { firstName: true, lastName: true } } },
  });
  const onRoll = new Map(roll.map((r) => [r.studentId, `${r.student.firstName} ${r.student.lastName}`]));

  const wanted = new Map<string, string>();
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("place:")) continue;
    const studentId = key.slice("place:".length);
    if (onRoll.has(studentId)) {
      wanted.set(studentId, String(value));
    }
  }
  if (wanted.size === 0) {
    return { error: "Nobody on this class's roll was in the form. Reload the page and try again." };
  }

  const destinations = [...new Set([...wanted.values()].filter(Boolean))];
  if (destinations.length > 0) {
    const real = await prisma.classGroup.count({ where: { id: { in: destinations } } });
    if (real !== destinations.length) {
      return { error: "One of those classes does not exist. Reload the page and try again." };
    }
  }

  const ids = [...wanted.keys()];
  const existing = await prisma.enrollment.findMany({
    where: { academicYearId: year.id, studentId: { in: ids } },
    select: { studentId: true, classGroupId: true, status: true },
  });
  const existingBy = new Map(existing.map((e) => [e.studentId, e]));
  const withResults = new Set(
    (
      await prisma.termResult.findMany({
        where: { studentId: { in: ids }, term: { academicYearId: year.id } },
        select: { studentId: true },
      })
    ).map((r) => r.studentId),
  );

  const counts = { placed: 0, removed: 0, unchanged: 0 };
  const held: string[] = [];

  await tenantTransaction(
    auth.schoolId,
    async (tx) => {
      for (const [studentId, destination] of wanted) {
        const before = existingBy.get(studentId);
        if ((before?.classGroupId ?? "") === destination) {
          counts.unchanged += 1;
          continue;
        }
        if (before && withResults.has(studentId)) {
          held.push(onRoll.get(studentId) as string);
          continue;
        }
        if (!destination) {
          await tx.enrollment.deleteMany({ where: { studentId, academicYearId: year.id } });
          counts.removed += 1;
          continue;
        }
        // COMPLETED is what every row of a finished year reads once its
        // promotion has run; a repeat already recorded is kept as one.
        const status = before?.status === "REPEATED" ? "REPEATED" : "COMPLETED";
        await tx.enrollment.upsert({
          where: { studentId_academicYearId: { studentId, academicYearId: year.id } },
          create: {
            schoolId: auth.schoolId,
            studentId,
            academicYearId: year.id,
            classGroupId: destination,
            status,
          },
          update: { classGroupId: destination, status },
        });
        counts.placed += 1;
      }

      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: "records.earlierClasses",
        entity: "ClassGroup",
        entityId: classGroupId,
        after: { yearId: year.id, year: year.name, ...counts, held: held.length },
      });
    },
    { timeout: 120_000, maxWait: 30_000 },
  );

  revalidatePath("/results/records/classes");

  const parts = [`${counts.placed} placed`];
  if (counts.removed) parts.push(`${counts.removed} marked as not at the school`);
  if (counts.unchanged) parts.push(`${counts.unchanged} unchanged`);
  const ok = `Saved for ${year.name}: ${parts.join(", ")}.`;
  if (held.length) {
    return {
      ok,
      error: `Not moved, because results are already recorded for them in ${year.name}: ${held.join(", ")}. Clear those results first if the class is wrong.`,
    };
  }
  return { ok };
}

/**
 * Step two: one subject's term figures, transcribed from the paper records.
 *
 * All-or-nothing: one mark that does not parse refuses the whole sheet and
 * names the pupil, rather than saving thirty-nine rows and leaving the office
 * to work out which one is missing.
 */
export async function saveRecordedMarks(_prev: RecordsState, formData: FormData): Promise<RecordsState> {
  const auth = await requireRole(LEADERSHIP);
  setTenantContext(auth.tenant);

  const termId = String(formData.get("termId") ?? "");
  const classGroupId = String(formData.get("classGroupId") ?? "");
  const subjectId = String(formData.get("subjectId") ?? "");
  const format = formData.get("format") === "total" ? "total" : "split";

  const term = await prisma.term.findUnique({
    where: { id: termId },
    select: { id: true, academicYearId: true },
  });
  const year = term ? await earlierYear(term.academicYearId) : null;
  if (!term || !year) {
    return {
      error: "Records can only be entered for a term in a year that ended before this one began. This year is marked in the mark sheet.",
    };
  }

  const classGroup = await prisma.classGroup.findUnique({ where: { id: classGroupId }, select: { levelId: true } });
  const offered = classGroup
    ? await prisma.levelSubject.count({ where: { levelId: classGroup.levelId, subjectId } })
    : 0;
  if (!classGroup || offered === 0) {
    return { error: "That subject is not offered at that class's level." };
  }

  const settings = await prisma.schoolSettings.findFirst({
    select: { classScoreWeight: true, examScoreWeight: true },
  });
  const classWeight = settings?.classScoreWeight ?? 30;
  const examWeight = settings?.examScoreWeight ?? 70;

  const roll = await prisma.enrollment.findMany({
    where: rosterWhere(term.academicYearId, classGroupId),
    select: { studentId: true, student: { select: { firstName: true, lastName: true } } },
  });
  const names = new Map(roll.map((r) => [r.studentId, `${r.student.firstName} ${r.student.lastName}`]));
  const ids = [...formData.keys()]
    .filter((key) => key.startsWith("row:"))
    .map((key) => key.slice("row:".length))
    .filter((id) => names.has(id));
  if (ids.length === 0) {
    return { error: "Nobody on this class's roll for that year was in the form. Place the pupils in step one first." };
  }

  // Marked in School OS for this term: the engine owns those rows.
  const computedSubject = await prisma.subjectResult.findMany({
    where: { termId, subjectId, studentId: { in: ids }, source: "COMPUTED" },
    select: { studentId: true },
  });
  const computedTerm = await prisma.termResult.findMany({
    where: {
      termId,
      studentId: { in: ids },
      source: "COMPUTED",
      OR: [{ totalMarks: { not: null } }, { status: "PUBLISHED" }],
    },
    select: { studentId: true },
  });
  const locked = new Set([...computedSubject, ...computedTerm].map((r) => r.studentId));

  type Entry = { studentId: string; classScore: number | null; examScore: number | null; total: number | null };
  const entries: Entry[] = [];
  const problems: string[] = [];

  for (const studentId of ids) {
    if (locked.has(studentId)) continue;
    const read = (key: string, max: number) => {
      const parsed = parseRecordedMark(String(formData.get(`${key}:${studentId}`) ?? ""), max);
      if (!parsed.ok) {
        problems.push(`${names.get(studentId)}: ${parsed.reason}`);
        return null;
      }
      return parsed.value;
    };
    if (format === "total") {
      const total = read("total", 100);
      entries.push({ studentId, classScore: null, examScore: null, total });
    } else {
      const classScore = read("class", classWeight);
      const examScore = read("exam", examWeight);
      const total =
        classScore === null && examScore === null
          ? null
          : Math.round(((classScore ?? 0) + (examScore ?? 0)) * 100) / 100;
      entries.push({ studentId, classScore, examScore, total });
    }
  }

  if (problems.length > 0) {
    const values: Record<string, string> = {};
    for (const [key, value] of formData.entries()) {
      if (/^(class|exam|total):/.test(key)) values[key] = String(value);
    }
    return {
      error: `Nothing was saved. ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? `; and ${problems.length - 5} more` : ""}.`,
      values,
    };
  }

  const decimal = (value: number | null) => (value === null ? null : new Prisma.Decimal(value.toFixed(2)));

  const saved = await tenantTransaction(
    auth.schoolId,
    async (tx) => {
      const { scaleId, bands } = await loadGradingBands(tx, auth.schoolId);
      let written = 0;
      let cleared = 0;

      for (const entry of entries) {
        if (entry.total === null) {
          const gone = await tx.subjectResult.deleteMany({
            where: { termId, studentId: entry.studentId, subjectId, source: "RECORDS" },
          });
          cleared += gone.count;
          continue;
        }
        const total = decimal(entry.total) as Prisma.Decimal;
        const band = gradeFor(bands, total);
        const data = {
          schoolId: auth.schoolId,
          termId,
          studentId: entry.studentId,
          subjectId,
          classGroupId,
          classScore: decimal(entry.classScore),
          examScore: decimal(entry.examScore),
          totalScore: total,
          gradingScaleId: scaleId,
          grade: band?.grade ?? null,
          points: band?.points ?? null,
          remark: band?.remark ?? null,
          teacherId: null,
          source: "RECORDS" as const,
        };
        await tx.subjectResult.upsert({
          where: { termId_studentId_subjectId: { termId, studentId: entry.studentId, subjectId } },
          create: data,
          update: data,
        });
        written += 1;
      }

      await rollUpRecords(tx, auth.schoolId, termId, classGroupId, subjectId);

      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: "records.marks",
        entity: "ClassGroup",
        entityId: classGroupId,
        after: { termId, subjectId, students: written, cleared, locked: locked.size },
      });
      return { written, cleared };
    },
    { timeout: 180_000, maxWait: 30_000 },
  );

  revalidatePath("/results/records");

  const lockedNote = locked.size
    ? ` ${locked.size} ${locked.size === 1 ? "pupil was" : "pupils were"} marked in School OS for this term and left as computed.`
    : "";
  return {
    ok: `Saved ${saved.written} ${saved.written === 1 ? "record" : "records"}${saved.cleared ? `, cleared ${saved.cleared}` : ""}.${lockedNote}`,
  };
}
