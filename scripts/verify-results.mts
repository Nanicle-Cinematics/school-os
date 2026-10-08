/**
 * Exercises the real results engine against the seeded data and checks the
 * arithmetic independently. Run with:
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-results.ts
 *
 * The react-server condition makes `import "server-only"` resolve to its empty
 * stub instead of throwing, which is what lets a plain script import engine
 * code that is otherwise RSC-only.
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { applyYearPromotion, computeClassResults, computeSubjectScore, gradeFor, rank, ordinal } from "@/lib/results-engine";
import { rosterWhere } from "@/lib/class-roster";
import { assembleCumulativeRecord, type CumulativeInput } from "@/lib/cumulative";
import { assembleJhsBroadsheet } from "@/lib/jhs-broadsheet";
import { sbaFigure } from "@/lib/sba";
import {
  isEarlierYear,
  parseRecordedMark,
  proposeEarlierClass,
  rollUpRecords,
  yearsBack,
} from "@/lib/records-engine";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

function assert(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) {
    process.exitCode = 1;
  }
}

// ── Pure-function checks, no database needed ────────────────────────────────
console.log("Unit checks");

const d = (n: number) => new Prisma.Decimal(n);

{
  // 50/50 weighting: one class test 15/30, exam 80/100 → 25 + 40 = 65
  const r = computeSubjectScore(
    [
      { rawScore: d(15), isAbsent: false, maxScore: d(30), weight: d(100), isExam: false },
      { rawScore: d(80), isAbsent: false, maxScore: d(100), weight: d(100), isExam: true },
    ],
    50,
    50,
  );
  assert("50/50 split computes correctly", Number(r.total) === 65, `got ${r.total}`);
  assert("class score scaled to its weight", Number(r.classScore) === 25, `got ${r.classScore}`);
}

{
  // An unmarked item is excluded; an absent item counts as zero.
  const unmarked = computeSubjectScore(
    [
      { rawScore: d(20), isAbsent: false, maxScore: d(20), weight: d(0), isExam: false },
      { rawScore: null, isAbsent: false, maxScore: d(20), weight: d(0), isExam: false },
    ],
    30,
    70,
  );
  const absent = computeSubjectScore(
    [
      { rawScore: d(20), isAbsent: false, maxScore: d(20), weight: d(0), isExam: false },
      { rawScore: null, isAbsent: true, maxScore: d(20), weight: d(0), isExam: false },
    ],
    30,
    70,
  );
  assert("blank excluded from average", Number(unmarked.classScore) === 30, `got ${unmarked.classScore}`);
  assert("absent counts as zero", Number(absent.classScore) === 15, `got ${absent.classScore}`);
}

{
  const items = [{ v: 90 }, { v: 80 }, { v: 80 }, { v: 70 }];
  const positions = rank(items, (i) => i.v);
  const got = items.map((i) => positions.get(i));
  assert("ties share a position and the next skips", JSON.stringify(got) === "[1,2,2,4]", got.join(","));
}

{
  // Custom bands with a gap between them: a score inside the gap used to get no grade.
  const bands = [
    { grade: "A", minScore: d(80), maxScore: d(100), points: 1, remark: "", isPass: true },
    { grade: "B", minScore: d(70), maxScore: d(79), points: 2, remark: "", isPass: true },
    { grade: "C", minScore: d(60), maxScore: d(69), points: 3, remark: "", isPass: true },
  ];
  assert("a score in a band gap takes the band it reached", gradeFor(bands, d(79.5))?.grade === "B");
  assert("an exact edge still matches its band", gradeFor(bands, d(80))?.grade === "A");
  assert("a score below every band has no grade", gradeFor(bands, d(40)) === null);
}

assert("ordinals", ordinal(1) === "1st" && ordinal(2) === "2nd" && ordinal(11) === "11th" && ordinal(23) === "23rd");

// ── Engine against real data ────────────────────────────────────────────────
const school = await prisma.school.findUniqueOrThrow({ where: { slug: "hope-demo" } });
const term = await prisma.term.findFirstOrThrow({ where: { schoolId: school.id, isCurrent: true } });
const classGroup = await prisma.classGroup.findFirstOrThrow({
  where: { schoolId: school.id, level: { code: "JHS2" } },
  include: { level: true },
});

console.log(`\nComputing ${classGroup.level.name} ${classGroup.name}…`);
const result = await prisma.$transaction(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (tx) => computeClassResults(tx as any, school.id, term.id, classGroup.id),
  { timeout: 180_000, maxWait: 30_000 },
);
console.log(`  ${result.subjects} subjects × ${result.students} students`);

const termResults = await prisma.termResult.findMany({
  where: { termId: term.id, classGroupId: classGroup.id },
  include: { student: { select: { firstName: true, lastName: true, admissionNo: true } } },
  orderBy: { classPosition: "asc" },
});

const subjectResults = await prisma.subjectResult.findMany({
  where: { termId: term.id, classGroupId: classGroup.id },
  include: { subject: { select: { code: true } } },
});

console.log("\nClass standings");
for (const tr of termResults) {
  console.log(
    `  ${ordinal(tr.classPosition).padStart(4)} of ${tr.classSize}  ` +
      `${(tr.student.lastName + ", " + tr.student.firstName).padEnd(22)} ` +
      `total=${String(tr.totalMarks).padStart(7)}  avg=${String(tr.average).padStart(6)}  agg=${tr.aggregate}`,
  );
}

// Independent re-derivation of the stored rollups.
console.log("\nCross-checks");
for (const tr of termResults) {
  const mine = subjectResults.filter((sr) => sr.studentId === tr.studentId);
  const total = mine.reduce((sum, sr) => sum + Number(sr.totalScore), 0);
  assert(
    `${tr.student.admissionNo} total matches sum of subjects`,
    Math.abs(total - Number(tr.totalMarks)) < 0.05,
    `stored ${tr.totalMarks} vs summed ${total.toFixed(2)}`,
  );
  // The average is per OFFERED subject, not per marked one — an un-entered
  // subject must drag it down, which is the whole point of the denominator.
  const offered = tr.subjectsOffered ?? mine.length;
  const avgOffered = total / offered;
  assert(
    `${tr.student.admissionNo} average matches`,
    Math.abs(avgOffered - Number(tr.average)) < 0.05,
    `stored ${tr.average} vs ${avgOffered.toFixed(2)} over ${offered} offered`,
  );
  assert(`${tr.student.admissionNo} subject count`, mine.length === tr.subjectsCount);
  assert(
    `${tr.student.admissionNo} is marked out of ${offered} × 100`,
    tr.possibleMarks === offered * 100,
    `stored ${tr.possibleMarks}`,
  );
  assert(
    `${tr.student.admissionNo} percentage is the total over what was available`,
    Math.abs((total / (offered * 100)) * 100 - Number(tr.percentage)) < 0.05,
    `stored ${tr.percentage}`,
  );
}

// ── The denominator is the level's curriculum, not what got marked ──────────
console.log("\nOut of what?");
{
  const offeredSubjects = await prisma.levelSubject.count({
    where: { levelId: classGroup.levelId, isElective: false },
  });
  const anyRow = termResults[0];
  assert(
    "the class is marked out of the subjects its level offers",
    (anyRow.subjectsOffered ?? 0) >= offeredSubjects,
    `offered ${offeredSubjects}, marked out of ${anyRow.subjectsOffered}`,
  );
  assert(
    "every child in the class is marked out of the same total",
    new Set(termResults.map((tr) => tr.possibleMarks)).size === 1,
    [...new Set(termResults.map((tr) => tr.possibleMarks))].join(", "),
  );
  // Marked can never exceed offered: the offered set contains it by construction,
  // so an un-entered subject is a gap that costs its full 100 rather than
  // shrinking the denominator to hide itself.
  assert(
    "what was marked is a subset of what was offered",
    (anyRow.subjectsCount ?? 0) <= (anyRow.subjectsOffered ?? 0) && (anyRow.subjectsOffered ?? 0) > 0,
    `${anyRow.subjectsCount} marked of ${anyRow.subjectsOffered} offered`,
  );
}

// ── The year decides who moves up ──────────────────────────────────────────
console.log("\nEnd-of-year promotion rule");
{
  const settings = await prisma.schoolSettings.findUnique({ where: { schoolId: school.id } });
  const passMark = settings?.promotionPassPercent ?? 45;

  const terms = await prisma.term.findMany({
    where: { schoolId: school.id, academicYearId: term.academicYearId },
    orderBy: { sequence: "asc" },
  });
  const third = terms.find((t) => t.sequence === 3);

  if (!third) {
    assert("the demo year has a third term", false);
  } else {
    // Compute all three terms, so the year total is real rather than one term
    // standing in for three.
    for (const t of terms) {
      await prisma.$transaction(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (tx) => computeClassResults(tx as any, school.id, t.id, classGroup.id),
        { timeout: 180_000, maxWait: 30_000 },
      );
    }

    const yearRows = await prisma.termResult.findMany({
      where: { termId: { in: terms.map((t) => t.id) }, classGroupId: classGroup.id },
      select: { studentId: true, termId: true, totalMarks: true, possibleMarks: true, promotionStatus: true },
    });

    const thirdRows = yearRows.filter((r) => r.termId === third.id);
    assert("the third term produced results", thirdRows.length > 0, `${thirdRows.length} rows`);

    const nextLevel = await prisma.level.findFirst({
      where: { schoolId: school.id, order: { gt: classGroup.level.order } },
      orderBy: { order: "asc" },
    });

    let checked = 0;
    for (const row of thirdRows) {
      const mine = yearRows.filter(
        (r) => r.studentId === row.studentId && r.totalMarks !== null && r.possibleMarks,
      );
      const marks = mine.reduce((sum, r) => sum + Number(r.totalMarks), 0);
      const possible = mine.reduce((sum, r) => sum + (r.possibleMarks ?? 0), 0);
      if (possible === 0) {
        continue;
      }
      const percent = (marks / possible) * 100;
      const expected = percent < passMark ? "REPEATED" : nextLevel ? "PROMOTED" : "GRADUATED";
      assert(
        `year ${percent.toFixed(1)}% → ${expected.toLowerCase()}`,
        row.promotionStatus === expected,
        `stored ${row.promotionStatus} against a ${passMark}% pass over ${possible} marks`,
      );
      checked += 1;
    }
    assert("every child in the class got a year verdict", checked === thirdRows.length, `${checked} of ${thirdRows.length}`);

    // The rule must be a function of the pass mark, not a hardcoded 45.
    const scores = thirdRows.map((row) => {
      const mine = yearRows.filter(
        (r) => r.studentId === row.studentId && r.totalMarks !== null && r.possibleMarks,
      );
      const marks = mine.reduce((sum, r) => sum + Number(r.totalMarks), 0);
      const possible = mine.reduce((sum, r) => sum + (r.possibleMarks ?? 0), 0);
      return possible === 0 ? 0 : (marks / possible) * 100;
    });
    const ceiling = Math.ceil(Math.max(...scores)) + 1;

    await prisma.schoolSettings.update({
      where: { schoolId: school.id },
      data: { promotionPassPercent: Math.min(ceiling, 100) },
    });
    await prisma.$transaction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tx) => computeClassResults(tx as any, school.id, third.id, classGroup.id),
      { timeout: 180_000, maxWait: 30_000 },
    );
    const afterRaise = await prisma.termResult.findMany({
      where: { termId: third.id, classGroupId: classGroup.id },
      select: { promotionStatus: true },
    });
    assert(
      "raising the pass mark above the best mark repeats the whole class",
      afterRaise.every((r) => r.promotionStatus === "REPEATED"),
      afterRaise.map((r) => r.promotionStatus).join(", "),
    );

    await prisma.schoolSettings.update({
      where: { schoolId: school.id },
      data: { promotionPassPercent: passMark },
    });
    await prisma.$transaction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tx) => computeClassResults(tx as any, school.id, third.id, classGroup.id),
      { timeout: 180_000, maxWait: 30_000 },
    );

    // A first or second term must never decide the year.
    const firstTerm = terms.find((t) => t.sequence === 1);
    if (firstTerm) {
      const firstRows = await prisma.termResult.findMany({
        where: { termId: firstTerm.id, classGroupId: classGroup.id },
        select: { promotionStatus: true },
      });
      assert(
        "the first term leaves the promotion question open",
        firstRows.every((r) => r.promotionStatus === "PENDING"),
        firstRows.map((r) => r.promotionStatus).join(", "),
      );
    }
  }
}

const sorted = [...termResults].sort((a, b) => Number(b.totalMarks) - Number(a.totalMarks));
assert(
  "class positions are ordered by total marks",
  sorted.every((tr, i) => (i === 0 ? true : Number(sorted[i - 1].totalMarks) >= Number(tr.totalMarks))) &&
    sorted[0].classPosition === 1,
  `top is ${sorted[0].student.lastName} at position ${sorted[0].classPosition}`,
);

const outOfRange = subjectResults.filter(
  (sr) => Number(sr.totalScore) < 0 || Number(sr.totalScore) > 100,
);
assert("every subject total is within 0–100", outOfRange.length === 0, `${outOfRange.length} outliers`);

const ungraded = subjectResults.filter((sr) => !sr.grade);
assert("every subject result got a grade band", ungraded.length === 0, `${ungraded.length} ungraded`);

const sample = subjectResults.filter((sr) => sr.studentId === termResults[0].studentId);
console.log(`\nTop student's subjects (${termResults[0].student.lastName})`);
for (const sr of sample) {
  console.log(
    `  ${sr.subject.code.padEnd(6)} class=${String(sr.classScore).padStart(6)} ` +
      `exam=${String(sr.examScore).padStart(6)} total=${String(sr.totalScore).padStart(6)} ` +
      `grade=${sr.grade}  pos=${ordinal(sr.subjectPosition)}`,
  );
}

// ── Marks-based components ──────────────────────────────────────────────────
// The whole component design rests on one identity: weighting each item's
// percentage by its own maximum reduces to (marks earned / marks available).
// If this breaks, every report card is silently wrong.

console.log("\nMarks-based components (weight = maxScore)");
{
  const D = (n: number) => new Prisma.Decimal(n);
  const item = (raw: number | null, max: number, isExam = false, absent = false) => ({
    rawScore: raw === null ? null : D(raw),
    isAbsent: absent,
    maxScore: D(max),
    weight: D(max), // the identity under test
    isExam,
  });

  // Class Test 1 18/20, Class Test 2 17/20, Group Work 1 9/10, Group Work 2 8/10,
  // Project 19/20 → 71 of 80 marks. Exam 77/100.
  const sheet = [
    item(18, 20), item(17, 20), item(9, 10), item(8, 10), item(19, 20),
    item(77, 100, true),
  ];
  const r = computeSubjectScore(sheet, 50, 50);
  const expectedClass = (71 / 80) * 50; // 44.375 → 44.38
  const expectedExam = (77 / 100) * 50; // 38.5

  assert("the class score is marks earned over marks available",
    Number(r.classScore) === Number(expectedClass.toFixed(2)),
    `${r.classScore} vs ${expectedClass.toFixed(2)}`);
  assert("the exam is scaled to its own share",
    Number(r.examScore) === Number(expectedExam.toFixed(2)), `${r.examScore}`);
  assert("the total is the two added",
    Number(r.total) === Number((expectedClass + expectedExam).toFixed(2)), `${r.total}`);

  // Raising a component's marks must raise its influence, with nothing else set.
  const heavier = [
    item(18, 20), item(17, 20), item(9, 10), item(8, 10), item(10, 40), // project now /40
    item(77, 100, true),
  ];
  const h = computeSubjectScore(heavier, 50, 50);
  const expectedHeavier = ((18 + 17 + 9 + 8 + 10) / (20 + 20 + 10 + 10 + 40)) * 50;
  assert("changing a component's total changes its influence proportionally",
    Number(h.classScore) === Number(expectedHeavier.toFixed(2)),
    `${h.classScore} vs ${expectedHeavier.toFixed(2)}`);
  assert("a bigger, badly-done component pulls the class score down",
    Number(h.classScore) < Number(r.classScore),
    `${h.classScore} < ${r.classScore}`);

  // Absent is zero earned but still counts toward what was available; unmarked
  // is excluded entirely. Conflating them is how a child gets a false zero.
  const withAbsent = [item(18, 20), item(null, 20, false, true)];
  const a = computeSubjectScore(withAbsent, 50, 50);
  assert("absent counts as zero out of its marks",
    Number(a.classScore) === Number(((18 / 40) * 50).toFixed(2)), `${a.classScore}`);

  const withUnmarked = [item(18, 20), item(null, 20)];
  const u = computeSubjectScore(withUnmarked, 50, 50);
  assert("an unmarked component is left out, not counted as zero",
    Number(u.classScore) === Number(((18 / 20) * 50).toFixed(2)), `${u.classScore}`);
  assert("...which is not the same as being absent",
    Number(u.classScore) !== Number(a.classScore), `${u.classScore} vs ${a.classScore}`);

  // A full sheet of full marks must be exactly the split, not 99.99.
  const perfect = [
    item(20, 20), item(20, 20), item(10, 10), item(10, 10), item(20, 20),
    item(100, 100, true),
  ];
  const p = computeSubjectScore(perfect, 50, 50);
  assert("full marks everywhere is exactly 100", Number(p.total) === 100, `${p.total}`);

  const zero = [item(0, 20), item(0, 100, true)];
  const z = computeSubjectScore(zero, 50, 50);
  assert("zero everywhere is exactly 0", Number(z.total) === 0, `${z.total}`);

  // A 30/70 school must scale the same marks differently.
  const shs = computeSubjectScore(sheet, 30, 70);
  assert("the same marks scale to a 30/70 school",
    Number(shs.classScore) === Number(((71 / 80) * 30).toFixed(2)) &&
      Number(shs.examScore) === Number(((77 / 100) * 70).toFixed(2)),
    `${shs.classScore} + ${shs.examScore}`);

  // With no exam entered yet, a mid-term class score must not be inflated to
  // look like a final mark.
  const classOnly = [item(18, 20), item(17, 20)];
  const c = computeSubjectScore(classOnly, 50, 50);
  assert("class-only marking gives no exam score rather than a zero",
    c.examScore === null, `${c.examScore}`);
  assert("and the total is the class part alone",
    Number(c.total) === Number(c.classScore), `${c.total}`);
}

// ── A finished year's roll is the cohort that sat it, not the class today ────
//
// "JHS 2 Gold" holds a new cohort every September. Before rosterWhere, the mark
// sheet listed the class TODAY for any term, and the engine read every ACTIVE
// enrolment with no year — so a past term rolled up the wrong children. The
// fixture is a year in 1990, far from anything real, with ONE of today's pupils
// placed in the class back then. Everything it creates hangs off that year and
// goes with it.
console.log("\nA past term's roll");
{
  const today = await prisma.enrollment.findMany({
    where: { classGroupId: classGroup.id, academicYearId: term.academicYearId, status: "ACTIVE" },
    select: { studentId: true },
  });
  assert("fixture: the class has more than one pupil today", today.length > 1, `${today.length}`);
  const sat = today[0].studentId;

  const pastYear = await prisma.academicYear.create({
    data: {
      schoolId: school.id,
      name: "verify-roster-1990",
      startDate: new Date("1990-09-01"),
      endDate: new Date("1991-07-31"),
    },
  });
  try {
    const pastTerm = await prisma.term.create({
      data: {
        schoolId: school.id,
        academicYearId: pastYear.id,
        name: "FIRST",
        sequence: 1,
        startDate: new Date("1990-09-01"),
        endDate: new Date("1990-12-15"),
      },
    });
    // COMPLETED, as every row of a finished year reads once the promotion ran.
    await prisma.enrollment.create({
      data: {
        schoolId: school.id,
        studentId: sat,
        academicYearId: pastYear.id,
        classGroupId: classGroup.id,
        status: "COMPLETED",
      },
    });

    const roll = await prisma.enrollment.findMany({
      where: rosterWhere(pastYear.id, classGroup.id),
      select: { studentId: true },
    });
    assert(
      "the 1990 roll is the one child who sat in the class in 1990",
      roll.length === 1 && roll[0].studentId === sat,
      `${roll.length} on the roll`,
    );

    const subject = await prisma.levelSubject.findFirstOrThrow({
      where: { levelId: classGroup.levelId },
      select: { subjectId: true },
    });
    await prisma.assessment.create({
      data: {
        schoolId: school.id,
        termId: pastTerm.id,
        classGroupId: classGroup.id,
        subjectId: subject.subjectId,
        type: "END_OF_TERM_EXAM",
        title: "verify-roster exam",
        maxScore: 100,
        weight: 100,
        status: "APPROVED",
        scores: { create: { schoolId: school.id, studentId: sat, rawScore: 80 } },
      },
    });

    const past = await prisma.$transaction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tx) => computeClassResults(tx as any, school.id, pastTerm.id, classGroup.id),
      { timeout: 180_000, maxWait: 30_000 },
    );
    const rows = await prisma.termResult.findMany({
      where: { termId: pastTerm.id },
      select: { studentId: true },
    });
    assert(
      "computing the 1990 term rolls up that child and nobody from today's class",
      past.students === 1 && rows.length === 1 && rows[0].studentId === sat,
      `${past.students} computed, ${rows.length} report cards`,
    );
  } finally {
    await prisma.academicYear.delete({ where: { id: pastYear.id } });
  }
}

// ── Results from paper records, for years before School OS ──────────────────
console.log("\nResults from records — the rules");
{
  const mark = (raw: string, max: number) => parseRecordedMark(raw, max);
  const blank = mark("  ", 30);
  assert("a blank box is no record, not zero", blank.ok && blank.value === null);
  const half = mark("24.5", 30);
  assert("a decimal mark is read", half.ok && half.value === 24.5);
  assert("a mark above what it is out of is refused", !mark("31", 30).ok);
  assert("a word is refused", !mark("abs", 30).ok);
  assert("a negative is refused", !mark("-2", 30).ok);

  const y = (start: string, end: string) => ({ startDate: new Date(start), endDate: new Date(end) });
  const now = y("2026-09-01", "2027-07-31");
  const last = y("2025-09-01", "2026-07-31");
  const before = y("2024-09-01", "2025-07-31");
  assert("a year that ended before this one began is earlier", isEarlierYear(last, now));
  assert("the current year is not earlier than itself", !isEarlierYear(now, now));
  assert("with no current year, nothing is earlier", !isEarlierYear(last, null));
  assert("2025/26 is one year back, 2024/25 two",
    yearsBack(last, now, [now, last, before]) === 1 && yearsBack(before, now, [now, last, before]) === 2);

  const level = (name: string, order: number) => ({ name, order });
  const classes = [
    { id: "j1g", name: "Gold", level: level("JHS 1", 9) },
    { id: "j1b", name: "JHS 1 Blue", level: level("JHS 1", 9) },
    { id: "j2g", name: "JHS 2 Gold", level: level("JHS 2", 10) },
    { id: "b6", name: "A", level: level("Basic 6", 8) },
  ];
  const j3gold = { id: "j3g", name: "Gold", level: level("JHS 3", 11) };
  assert("two years back from JHS 3 Gold is JHS 1 Gold, whichever way the name is written",
    proposeEarlierClass(j3gold, 2, classes) === "j1g");
  assert("one year back is JHS 2 Gold", proposeEarlierClass(j3gold, 1, classes) === "j2g");
  assert("a level with one class needs no stream match",
    proposeEarlierClass(j3gold, 3, classes) === "b6");
  assert("an unknown stream at a level of several proposes nothing",
    proposeEarlierClass({ id: "x", name: "Red", level: level("JHS 3", 11) }, 2, classes) === null);
  assert("below the bottom rung proposes nothing", proposeEarlierClass(j3gold, 9, classes) === null);
}

console.log("\nResults from records — against the database");
{
  const roll = await prisma.enrollment.findMany({
    where: { classGroupId: classGroup.id, academicYearId: term.academicYearId, status: "ACTIVE" },
    select: { studentId: true },
  });
  const [first, second] = roll.map((r) => r.studentId);
  const offered = await prisma.levelSubject.findMany({
    where: { levelId: classGroup.levelId, isElective: false },
    select: { subjectId: true, countsForAggregate: true },
  });
  const pastYear = await prisma.academicYear.create({
    data: {
      schoolId: school.id,
      name: "verify-records-1990",
      startDate: new Date("1990-09-01"),
      endDate: new Date("1991-07-31"),
    },
  });
  try {
    const t3 = await prisma.term.create({
      data: {
        schoolId: school.id,
        academicYearId: pastYear.id,
        name: "THIRD",
        sequence: 3,
        startDate: new Date("1991-04-20"),
        endDate: new Date("1991-07-31"),
      },
    });
    for (const studentId of [first, second]) {
      await prisma.enrollment.create({
        data: { schoolId: school.id, studentId, academicYearId: pastYear.id, classGroupId: classGroup.id, status: "COMPLETED" },
      });
    }
    // Two subjects on paper: the first pupil 20+50 and 25+60, the second 10+30
    // in the first subject only — a hole in the record stays a hole.
    const [s1, s2] = offered.map((o) => o.subjectId);
    const rec = (studentId: string, subjectId: string, c: number, e: number) =>
      prisma.subjectResult.create({
        data: {
          schoolId: school.id,
          termId: t3.id,
          studentId,
          subjectId,
          classGroupId: classGroup.id,
          classScore: c,
          examScore: e,
          totalScore: c + e,
          source: "RECORDS",
        },
      });
    await rec(first, s1, 20, 50);
    await rec(first, s2, 25, 60);
    await rec(second, s1, 10, 30);

    await prisma.$transaction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tx) => rollUpRecords(tx as any, school.id, t3.id, classGroup.id, s1),
      { timeout: 120_000, maxWait: 30_000 },
    );
    const card = async (studentId: string) =>
      prisma.termResult.findUnique({ where: { termId_studentId: { termId: t3.id, studentId } } });
    const a = await card(first);
    const b = await card(second);
    const outOf = offered.length * 100;
    assert("the roll-up writes a RECORDS term for each pupil with a record",
      a?.source === "RECORDS" && b?.source === "RECORDS");
    assert("and marks it settled, never a draft waiting to be published",
      a?.status === "APPROVED" && b?.status === "APPROVED");
    assert("the total is the sum of the recorded subjects", Number(a?.totalMarks) === 155, `${a?.totalMarks}`);
    assert("out of the level's curriculum, so a missing subject pulls the total down",
      a?.possibleMarks === outOf && b?.possibleMarks === outOf, `${a?.possibleMarks} of ${outOf}`);
    assert("class positions follow the totals", a?.classPosition === 1 && b?.classPosition === 2);
    const line = await prisma.subjectResult.findUnique({
      where: { termId_studentId_subjectId: { termId: t3.id, studentId: second, subjectId: s1 } },
    });
    assert("subject positions are set for the sheet saved", line?.subjectPosition === 2 && line?.subjectSize === 2);

    // The engine and the promotion rule must leave those figures alone: there are
    // no marks behind them, so a recompute would blank the term. An approved sheet
    // with no scores on it puts the first subject in the engine's path — without
    // one the engine never reaches the subject lines and this would pass vacuously.
    await prisma.assessment.create({
      data: {
        schoolId: school.id,
        termId: t3.id,
        classGroupId: classGroup.id,
        subjectId: s1,
        type: "END_OF_TERM_EXAM",
        title: "verify-records empty sheet",
        maxScore: 100,
        weight: 100,
        status: "APPROVED",
      },
    });
    await prisma.$transaction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tx) => computeClassResults(tx as any, school.id, t3.id, classGroup.id),
      { timeout: 180_000, maxWait: 30_000 },
    );
    const after = await card(first);
    const lines = await prisma.subjectResult.count({ where: { termId: t3.id, source: "RECORDS" } });
    assert("Compute on that term leaves the recorded total as it was", Number(after?.totalMarks) === 155,
      `${after?.totalMarks}`);
    assert("and every recorded subject line survives it", lines === 3, `${lines}`);
    // Called directly, so it is the promotion rule's own guard being tested and
    // not the engine's: a blanked term has no totals and would pass either way.
    await prisma.$transaction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tx) => applyYearPromotion(tx as any, school.id, t3.id, classGroup.id, pastYear.id),
      { timeout: 120_000, maxWait: 30_000 },
    );
    assert("and a third term from records never decides a promotion",
      (await card(first))?.promotionStatus === "PENDING", `${(await card(first))?.promotionStatus}`);

    // Clearing every record for a pupil clears their term.
    await prisma.subjectResult.deleteMany({ where: { termId: t3.id, studentId: second } });
    await prisma.$transaction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tx) => rollUpRecords(tx as any, school.id, t3.id, classGroup.id, s1),
      { timeout: 120_000, maxWait: 30_000 },
    );
    assert("a pupil with no records left has no term", (await card(second)) === null);
    assert("and the class positions close up behind them", (await card(first))?.classSize === 1);
  } finally {
    await prisma.academicYear.delete({ where: { id: pastYear.id } });
  }
}

// ── The JHS cumulative record: which years print, and every row lines up ────
console.log("\nThe JHS cumulative record");
{
  const j1 = { id: "j1", name: "JHS 1", order: 9 };
  const j2 = { id: "j2", name: "JHS 2", order: 10 };
  const j3 = { id: "j3", name: "JHS 3", order: 11 };
  const year = (id: string, start: string) => ({ id, name: id, startDate: new Date(start) });
  const y24 = year("2024/2025", "2024-09-01");
  const y25 = year("2025/2026", "2025-09-01");
  const y26 = year("2026/2027", "2026-09-01");
  const termsOf = (y: { id: string }) =>
    [1, 2, 3].map((sequence) => ({ id: `${y.id}-t${sequence}`, academicYearId: y.id, sequence }));
  const base: CumulativeInput = {
    levels: [j3, j1, j2],
    currentLevelOrder: 11,
    enrolments: [
      { academicYear: y24, classGroup: { name: "Gold", level: j1 } },
      { academicYear: y25, classGroup: { name: "JHS 2 Gold", level: j2 } },
      { academicYear: y26, classGroup: { name: "Gold", level: j3 } },
    ],
    terms: [...termsOf(y24), ...termsOf(y25), ...termsOf(y26)],
    termResults: [
      { termId: "2024/2025-t1", totalMarks: 600, possibleMarks: 1000, percentage: 60, classPosition: 3, classSize: 30, status: "APPROVED", source: "RECORDS" },
      { termId: "2026/2027-t1", totalMarks: 700, possibleMarks: 1000, percentage: 70, classPosition: 1, classSize: 30, status: "DRAFT", source: "COMPUTED" },
    ],
    subjectResults: [
      { termId: "2024/2025-t1", subjectId: "eng", totalScore: 61, grade: "4" },
      { termId: "2026/2027-t1", subjectId: "mat", totalScore: 72.5, grade: "2" },
    ],
    subjects: [
      { id: "mat", name: "Mathematics", order: 2 },
      { id: "eng", name: "English Language", order: 1 },
    ],
  };

  const full = assembleCumulativeRecord(base);
  const cols = full.years.length * 3;
  assert("a JHS 3 pupil with all three years prints nine term columns",
    full.years.length === 3 && cols === 9, `${cols}`);
  assert("the years run JHS 1, JHS 2, JHS 3 whatever order the levels arrive in",
    full.years.map((y) => y.levelName).join(",") === "JHS 1,JHS 2,JHS 3");
  assert("every subject row has a cell for every term column",
    full.rows.every((r) => r.cells.length === cols));
  assert("subjects follow the curriculum order", full.rows[0].name === "English Language");
  assert("a mark lands in its own term's column",
    full.rows[0].cells[0]?.total === 61 && full.rows[1].cells[6]?.total === 72.5);
  assert("a term with no mark is an empty cell, not a missing column", full.rows[0].cells[1] === null);
  const y1 = full.years[0];
  const y3 = full.years[2];
  assert("a term from paper records is marked as such",
    y1.kind === "year" && y1.terms[0].source === "RECORDS" && !y1.terms[0].provisional);
  assert("a draft computed term is marked provisional", y3.kind === "year" && y3.terms[0].provisional);
  assert("a class named only by its stream reads with its level", y1.kind === "year" && y1.className === "JHS 1 Gold");
  assert("a class named in full is not doubled", full.years[1].kind === "year" && full.years[1].className === "JHS 2 Gold");

  const joinedLate = assembleCumulativeRecord({ ...base, enrolments: base.enrolments.slice(1) });
  assert("a JHS 3 pupil with no JHS 1 enrolment shows JHS 1 as not recorded",
    joinedLate.years[0].kind === "missing" && joinedLate.years.length === 3);
  assert("and the gap keeps its three columns so the rows still line up",
    joinedLate.rows.every((r) => r.cells.length === 9 && r.cells[0] === null));

  const inJhs2 = assembleCumulativeRecord({ ...base, currentLevelOrder: 10, enrolments: base.enrolments.slice(0, 2) });
  assert("a JHS 2 pupil has no JHS 3 columns yet", inJhs2.years.length === 2);

  const repeater = assembleCumulativeRecord({
    ...base,
    enrolments: [
      base.enrolments[0],
      { academicYear: y25, classGroup: { name: "Gold", level: j2 } },
      { academicYear: y26, classGroup: { name: "Gold", level: j2 } },
    ],
    currentLevelOrder: 10,
  });
  assert("a pupil who repeated JHS 2 shows both years at it",
    repeater.years.filter((y) => y.levelName === "JHS 2").length === 2);
}

// ── The JHS 1–3 broadsheet: averages, totals and positions across three years
console.log("\nThe JHS 1–3 broadsheet");
{
  const pupil = (id: string, lastName: string) => ({ id, firstName: id.toUpperCase(), lastName, admissionNo: id });
  const sheet = assembleJhsBroadsheet({
    pupils: [pupil("ama", "Mensah"), pupil("kofi", "Boateng"), pupil("esi", "Owusu"), pupil("yaw", "Addo")],
    subjects: [
      { id: "mat", name: "Mathematics", order: 2 },
      { id: "eng", name: "English Language", order: 1 },
    ],
    termResults: [
      // Ama: 3 terms, 150 + 160 + 170 of 200 each = 480 / 600 = 80%
      { studentId: "ama", termId: "t1", totalMarks: 150, possibleMarks: 200, source: "RECORDS" },
      { studentId: "ama", termId: "t2", totalMarks: 160, possibleMarks: 200, source: "RECORDS" },
      { studentId: "ama", termId: "t3", totalMarks: 170, possibleMarks: 200, source: "COMPUTED" },
      // Kofi: one term, 160 / 200 = 80% — ties Ama
      { studentId: "kofi", termId: "t3", totalMarks: 160, possibleMarks: 200, source: "COMPUTED" },
      // Esi: 120 / 200 = 60%
      { studentId: "esi", termId: "t3", totalMarks: 120, possibleMarks: 200, source: "COMPUTED" },
      // Yaw: nothing on record
    ],
    subjectResults: [
      { studentId: "ama", termId: "t1", subjectId: "eng", totalScore: 70 },
      { studentId: "ama", termId: "t2", subjectId: "eng", totalScore: 80 },
      { studentId: "ama", termId: "t3", subjectId: "eng", totalScore: 85 },
      { studentId: "ama", termId: "t1", subjectId: "mat", totalScore: 80 },
      // Ama's term-2 mathematics was never recorded.
      { studentId: "ama", termId: "t3", subjectId: "mat", totalScore: 85 },
      { studentId: "esi", termId: "t3", subjectId: "eng", totalScore: null },
    ],
  });
  const row = (id: string) => sheet.rows.find((r) => r.pupil.id === id)!;
  assert("columns follow the curriculum order", sheet.subjects.map((s) => s.id).join(",") === "eng,mat");
  assert("a subject average is the mean of the terms recorded", row("ama").cells[0].average === 78.3,
    `${row("ama").cells[0].average}`);
  assert("and says how many terms it averages", row("ama").cells[0].terms === 3);
  assert("a term with no mark is left out of the average, and the count shows it",
    row("ama").cells[1].average === 82.5 && row("ama").cells[1].terms === 2);
  assert("a null mark is not a zero", row("esi").cells[0].average === null && row("esi").cells[0].terms === 0);
  assert("overall is all marks over all marks available", row("ama").marks === 480 && row("ama").possible === 600
    && row("ama").percentage === 80);
  assert("equal percentages share a position", row("ama").position === 1 && row("kofi").position === 1);
  assert("and the next position skips", row("esi").position === 3);
  assert("a pupil with nothing on record has no position and no percentage",
    row("yaw").position === null && row("yaw").percentage === null);
  assert("rows run best first, the unrecorded last", sheet.rows[sheet.rows.length - 1].pupil.id === "yaw"
    && sheet.rows[2].pupil.id === "esi");
  assert("a pupil with a transcribed term is flagged", row("ama").fromRecords && !row("kofi").fromRecords);
}

// ── The SBA figure: class scores, each JHS year equal, out of 30 ────────────
console.log("\nThe SBA figure");
{
  // 30/70 school: year A class scores 24 and 21 of 30 (80%, 70%), year B 27 (90%).
  const twoYears = sbaFigure(
    [
      { yearId: "A", classScore: 24 },
      { yearId: "A", classScore: 21 },
      { yearId: "B", classScore: 27 },
    ],
    30,
  );
  assert("each year counts equally: (75 + 90) / 2 = 82.5%, scaled to 30 = 24.8",
    twoYears.sba === 24.8 && twoYears.years === 2, `${twoYears.sba} over ${twoYears.years}`);
  assert("which is not the plain term average (80% = 24.0) — the year with one term still counts a half",
    twoYears.sba !== 24);
  const fifty = sbaFigure([{ yearId: "A", classScore: 40 }], 50);
  assert("a 50/50 school's class score is read out of 50: 40 / 50 = 80% = 24.0 / 30", fifty.sba === 24);
  const holes = sbaFigure(
    [
      { yearId: "A", classScore: null },
      { yearId: "B", classScore: 15 },
    ],
    30,
  );
  assert("a term with no class score (a total-only record) is left out, not counted as zero",
    holes.sba === 15 && holes.years === 1, `${holes.sba} over ${holes.years}`);
  // Out of 50: year A 68%, 50%, 64% (mean 60.67), year B 66%, 84% (mean 75):
  // (60.67 + 75) / 2 = 67.83%, scaled to 30 is exactly 20.35, which floating
  // point stores as 20.3499… and plain rounding prints as 20.3.
  const half = sbaFigure(
    [
      { yearId: "A", classScore: 34 },
      { yearId: "A", classScore: 25 },
      { yearId: "A", classScore: 32 },
      { yearId: "B", classScore: 33 },
      { yearId: "B", classScore: 42 },
    ],
    50,
  );
  assert("an exact .x5 rounds up, as it does on paper: 20.35 prints 20.4", half.sba === 20.4, `${half.sba}`);
  const none = sbaFigure([{ yearId: "A", classScore: null }], 30);
  assert("no class scores at all gives no SBA, not a zero", none.sba === null && none.years === 0);
  assert("a nonsense class weight gives no SBA rather than a division by zero",
    sbaFigure([{ yearId: "A", classScore: 20 }], 0).sba === null);

  // The two sheets read the same rule.
  const cum = assembleCumulativeRecord({
    levels: [{ id: "j1", name: "JHS 1", order: 9 }, { id: "j2", name: "JHS 2", order: 10 }],
    currentLevelOrder: 10,
    enrolments: [
      { academicYear: { id: "A", name: "A", startDate: new Date("2024-09-01") }, classGroup: { name: "Gold", level: { id: "j1", name: "JHS 1", order: 9 } } },
      { academicYear: { id: "B", name: "B", startDate: new Date("2025-09-01") }, classGroup: { name: "Gold", level: { id: "j2", name: "JHS 2", order: 10 } } },
    ],
    terms: [
      { id: "A1", academicYearId: "A", sequence: 1 },
      { id: "A2", academicYearId: "A", sequence: 2 },
      { id: "B1", academicYearId: "B", sequence: 1 },
    ],
    termResults: [],
    subjectResults: [
      { termId: "A1", subjectId: "eng", totalScore: 70, grade: null, classScore: 24 },
      { termId: "A2", subjectId: "eng", totalScore: 65, grade: null, classScore: 21 },
      { termId: "B1", subjectId: "eng", totalScore: 80, grade: null, classScore: 27 },
    ],
    subjects: [{ id: "eng", name: "English Language", order: 1 }],
    classWeight: 30,
  });
  assert("the cumulative record's SBA column applies the same rule", cum.rows[0].sba.sba === 24.8,
    `${cum.rows[0].sba.sba}`);
  const board = assembleJhsBroadsheet({
    pupils: [{ id: "p", firstName: "P", lastName: "Q", admissionNo: "1" }],
    subjects: [{ id: "eng", name: "English Language", order: 1 }],
    termResults: [],
    subjectResults: [
      { studentId: "p", termId: "A1", subjectId: "eng", totalScore: 70, classScore: 24 },
      { studentId: "p", termId: "A2", subjectId: "eng", totalScore: 65, classScore: 21 },
      { studentId: "p", termId: "B1", subjectId: "eng", totalScore: 80, classScore: 27 },
    ],
    yearOfTerm: { A1: "A", A2: "A", B1: "B" },
    classWeight: 30,
  });
  assert("and so does the broadsheet's SBA view", board.rows[0].cells[0].sba === 24.8
    && board.rows[0].cells[0].sbaYears === 2, `${board.rows[0].cells[0].sba}`);
}

await prisma.$disconnect();
