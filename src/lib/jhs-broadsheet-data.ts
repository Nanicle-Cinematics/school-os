import "server-only";

import { prisma } from "@/lib/prisma";
import { rosterWhere } from "@/lib/class-roster";
import { assembleJhsBroadsheet } from "@/lib/jhs-broadsheet";

const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));

/**
 * The JHS 1–3 broadsheet for one of this year's JHS classes.
 *
 * A fixed number of queries for the whole class, never one set per pupil: on
 * this link a round trip is seconds, and forty pupils' worth of per-pupil
 * reads would never finish. Sequential, not Promise.all — see the
 * connection_limit note in CLAUDE.md.
 *
 * Every query that could reach another school names this one explicitly, for
 * the reason the cumulative record learnt: a development database holds
 * several schools with row security off.
 */
export async function getJhsBroadsheet(schoolId: string, classGroupId: string) {
  const current = await prisma.academicYear.findFirst({
    where: { schoolId, isCurrent: true },
    select: { id: true, name: true },
  });
  const classes = await prisma.classGroup.findMany({
    where: { schoolId, level: { stage: "JHS" } },
    orderBy: [{ level: { order: "asc" } }, { name: "asc" }],
    select: { id: true, name: true, level: { select: { name: true } } },
  });
  const classGroup = classes.find((c) => c.id === classGroupId) ?? null;

  if (!current || !classGroup) {
    return { current, classes, classGroup, sheet: null };
  }

  const roll = await prisma.enrollment.findMany({
    where: { schoolId, ...rosterWhere(current.id, classGroupId) },
    select: { student: { select: { id: true, firstName: true, lastName: true, admissionNo: true } } },
  });
  const pupils = roll.map((r) => r.student);
  const pupilIds = pupils.map((p) => p.id);

  const levels = await prisma.level.findMany({
    where: { schoolId, stage: "JHS" },
    select: { id: true },
  });
  const levelIds = levels.map((l) => l.id);

  // Which academic years each pupil spent in JHS: only those terms count, so a
  // pupil's Basic 6 marks never leak into a JHS figure.
  const enrolments = await prisma.enrollment.findMany({
    where: {
      schoolId,
      studentId: { in: pupilIds },
      status: { not: "WITHDRAWN" },
      classGroup: { levelId: { in: levelIds } },
    },
    select: { studentId: true, academicYearId: true },
  });
  const jhsYears = new Map<string, Set<string>>();
  for (const e of enrolments) {
    if (!jhsYears.has(e.studentId)) jhsYears.set(e.studentId, new Set());
    jhsYears.get(e.studentId)!.add(e.academicYearId);
  }

  const terms = await prisma.term.findMany({
    where: { schoolId, academicYearId: { in: [...new Set(enrolments.map((e) => e.academicYearId))] } },
    select: { id: true, academicYearId: true },
  });
  const yearOfTerm = new Map(terms.map((t) => [t.id, t.academicYearId]));
  const counts = (studentId: string, termId: string) =>
    jhsYears.get(studentId)?.has(yearOfTerm.get(termId) ?? "") ?? false;

  const termResults = (
    await prisma.termResult.findMany({
      where: { schoolId, studentId: { in: pupilIds }, termId: { in: terms.map((t) => t.id) } },
      select: { studentId: true, termId: true, totalMarks: true, possibleMarks: true, source: true },
    })
  ).filter((r) => counts(r.studentId, r.termId));

  const subjectResults = (
    await prisma.subjectResult.findMany({
      where: { schoolId, studentId: { in: pupilIds }, termId: { in: terms.map((t) => t.id) } },
      select: { studentId: true, termId: true, subjectId: true, totalScore: true, classScore: true },
    })
  ).filter((r) => counts(r.studentId, r.termId));

  // The columns: the JHS curriculum, plus any subject that carries a mark.
  const offered = await prisma.levelSubject.findMany({
    where: { levelId: { in: levelIds }, isElective: false },
    select: { subjectId: true },
  });
  const subjectIds = [...new Set([...offered.map((o) => o.subjectId), ...subjectResults.map((r) => r.subjectId)])];
  const subjects = await prisma.subject.findMany({
    where: { schoolId, id: { in: subjectIds } },
    select: { id: true, name: true, order: true },
  });

  const settings = await prisma.schoolSettings.findFirst({
    where: { schoolId },
    select: { classScoreWeight: true },
  });

  const sheet = assembleJhsBroadsheet({
    pupils,
    subjects,
    termResults: termResults.map((r) => ({ ...r, totalMarks: num(r.totalMarks) })),
    subjectResults: subjectResults.map((r) => ({
      ...r,
      totalScore: num(r.totalScore),
      classScore: num(r.classScore),
    })),
    yearOfTerm: Object.fromEntries(yearOfTerm),
    classWeight: settings?.classScoreWeight ?? 30,
  });

  return { current, classes, classGroup, sheet };
}
