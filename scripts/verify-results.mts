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
import { computeClassResults, computeSubjectScore, gradeFor, rank, ordinal } from "@/lib/results-engine";
import { rosterWhere } from "@/lib/class-roster";

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

await prisma.$disconnect();
