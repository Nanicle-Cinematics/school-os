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
import { computeClassResults, computeSubjectScore, rank, ordinal } from "@/lib/results-engine";

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

assert("ordinals", ordinal(1) === "1st" && ordinal(2) === "2nd" && ordinal(11) === "11th" && ordinal(23) === "23rd");

// ── Engine against real data ────────────────────────────────────────────────
const school = await prisma.school.findUniqueOrThrow({ where: { slug: "st-mary-demo" } });
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
  const avg = total / mine.length;
  assert(
    `${tr.student.admissionNo} total matches sum of subjects`,
    Math.abs(total - Number(tr.totalMarks)) < 0.05,
    `stored ${tr.totalMarks} vs summed ${total.toFixed(2)}`,
  );
  assert(
    `${tr.student.admissionNo} average matches`,
    Math.abs(avg - Number(tr.average)) < 0.05,
    `stored ${tr.average} vs ${avg.toFixed(2)}`,
  );
  assert(`${tr.student.admissionNo} subject count`, mine.length === tr.subjectsCount);
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

await prisma.$disconnect();
