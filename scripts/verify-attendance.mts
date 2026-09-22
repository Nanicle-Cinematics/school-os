/**
 * The register, end to end, against real data.
 *
 *   npm run verify:attendance
 *
 * Checks the arithmetic the report card depends on, and — more importantly —
 * the three refusals that make it trustworthy: a day nobody marked costs
 * nobody an absence, a published card is not rewritten, and a register cannot
 * be taken outside a term.
 */
import { PrismaClient } from "@prisma/client";
import { syncAttendanceTotals } from "@/lib/attendance-engine";
import { parseDay, dayKey, termForDate, getAttendanceSummary } from "@/lib/attendance-data";
import { setTenantContext } from "@/lib/tenant-context";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

let passed = 0;
let failed = 0;
/** `detail` explains a FAILURE, so it prints only when there is one — a reason
 *  printed beside a pass reads as a contradiction. */
function assert(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${!condition && detail ? ` — ${detail}` : ""}`);
  if (condition) passed += 1;
  else {
    failed += 1;
    process.exitCode = 1;
  }
}

// ── Day handling, no database needed ───────────────────────────────────────
console.log("Days are days, not timestamps");
{
  const day = parseDay("2026-09-22")!;
  assert("a yyyy-mm-dd string parses", day !== null);
  assert("and parses at UTC midnight, so it cannot slip a day", day.toISOString() === "2026-09-22T00:00:00.000Z", day.toISOString());
  assert("and round-trips to the same day", dayKey(day) === "2026-09-22", dayKey(day));
  assert("rubbish is refused", parseDay("22/09/2026") === null);
  assert("a timestamp is refused", parseDay("2026-09-22T10:00:00Z") === null);
  assert("an impossible month is refused", parseDay("2026-13-01") === null || dayKey(parseDay("2026-13-01")!) !== "2026-13-01");
}

const school = await prisma.school.findUniqueOrThrow({ where: { slug: "st-mary-demo" } });
// The helpers under test go through the app's tenant-guarded client, which
// refuses to answer without a school — exactly as it would for an action.
setTenantContext({ schoolId: school.id });
const term = await prisma.term.findFirstOrThrow({
  where: { schoolId: school.id, sequence: 1 },
  select: { id: true, startDate: true, endDate: true, academicYearId: true },
});
const classGroup = await prisma.classGroup.findFirstOrThrow({
  where: { schoolId: school.id, level: { code: "B5" } },
  include: { level: true },
});

const roster = await prisma.enrollment.findMany({
  where: { classGroupId: classGroup.id, academicYearId: term.academicYearId, status: "ACTIVE" },
  select: { studentId: true },
  orderBy: { studentId: "asc" },
});
const studentIds = roster.map((row) => row.studentId);
console.log(`\n${classGroup.level.name} ${classGroup.name}: ${studentIds.length} on roll`);
assert("the class has a roll to mark", studentIds.length > 0);

// A clean slate, so a re-run measures this run.
await prisma.attendanceDay.deleteMany({ where: { classGroupId: classGroup.id } });
await prisma.termResult.updateMany({
  where: { termId: term.id, classGroupId: classGroup.id },
  data: { daysPresent: null, daysTotal: null },
});

// ── Which term a date belongs to ───────────────────────────────────────────
console.log("\nA register belongs to a term");
{
  const inside = new Date(term.startDate.getTime() + 24 * 3600 * 1000);
  const found = await termForDate(inside);
  assert("a date inside the term finds it", found?.id === term.id, found?.id ?? "none");

  const longBefore = parseDay("2000-01-04")!;
  const none = await termForDate(longBefore);
  assert("a date in no term finds nothing, so the action can refuse", none === null, none ? "found one" : "");
}

// ── Mark five days ─────────────────────────────────────────────────────────
console.log("\nMarking five days");
const dates = [0, 1, 2, 3, 4].map((offset) => {
  const d = new Date(term.startDate);
  d.setUTCDate(d.getUTCDate() + offset);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
});

// The first child is deliberately awkward: present, late, excused, absent,
// present — one of each, so every branch of the count is exercised by a real row.
const script: Record<number, ("PRESENT" | "LATE" | "EXCUSED" | "ABSENT")[]> = {
  0: ["PRESENT", "LATE", "EXCUSED", "ABSENT", "PRESENT"],
};

for (const [index, date] of dates.entries()) {
  const day = await prisma.attendanceDay.create({
    data: { schoolId: school.id, termId: term.id, classGroupId: classGroup.id, date },
  });
  for (const [position, studentId] of studentIds.entries()) {
    const mark = script[position]?.[index] ?? "PRESENT";
    await prisma.attendanceEntry.create({
      data: {
        schoolId: school.id,
        attendanceDayId: day.id,
        studentId,
        mark,
        note: mark === "EXCUSED" ? "funeral" : null,
      },
    });
  }
}

await prisma.$transaction(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (tx) => syncAttendanceTotals(tx as any, school.id, term.id, classGroup.id),
  { timeout: 60_000, maxWait: 20_000 },
);

const summary = await getAttendanceSummary(term.id, classGroup.id);
assert("five days are recorded as taken", summary.days.length === 5, `${summary.days.length}`);

const awkward = summary.rows.find((row) => row.studentId === studentIds[0])!;
assert("present and late both count as in school", awkward.present + awkward.late === 3, `${awkward.present}P + ${awkward.late}L`);
assert("excused and absent both count as away", awkward.excused + awkward.absent === 2, `${awkward.excused}E + ${awkward.absent}A`);
assert("the percentage is in-school over days marked", awkward.percent !== null && Math.abs(awkward.percent - 60) < 0.01, `${awkward.percent}`);

const cards = await prisma.termResult.findMany({
  where: { termId: term.id, classGroupId: classGroup.id },
  select: { studentId: true, daysPresent: true, daysTotal: true, status: true },
});
const awkwardCard = cards.find((c) => c.studentId === studentIds[0])!;
assert("the report card reads 3 of 5", awkwardCard.daysPresent === 3 && awkwardCard.daysTotal === 5, `${awkwardCard.daysPresent} of ${awkwardCard.daysTotal}`);

const others = cards.filter((c) => c.studentId !== studentIds[0]);
assert("everyone else reads 5 of 5", others.every((c) => c.daysPresent === 5 && c.daysTotal === 5), others.map((c) => `${c.daysPresent}/${c.daysTotal}`).join(" "));

// ── THE POINT: an unmarked day costs nobody an absence ─────────────────────
console.log("\nA day nobody marked is not an absence");
{
  // A sixth school day passes and nobody opens the register.
  const before = cards.find((c) => c.studentId === studentIds[1])!;
  await prisma.$transaction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tx) => syncAttendanceTotals(tx as any, school.id, term.id, classGroup.id),
    { timeout: 60_000, maxWait: 20_000 },
  );
  const after = await prisma.termResult.findUniqueOrThrow({
    where: { termId_studentId: { termId: term.id, studentId: studentIds[1] } },
    select: { daysPresent: true, daysTotal: true },
  });
  assert(
    "the denominator is days taken, not days elapsed",
    after.daysTotal === before.daysTotal && after.daysPresent === before.daysPresent,
    `${before.daysPresent}/${before.daysTotal} → ${after.daysPresent}/${after.daysTotal}`,
  );
}

// ── A child who joins late is marked out of their own days ─────────────────
console.log("\nA child marked on fewer days is judged on fewer days");
{
  const latecomer = studentIds[1];
  await prisma.attendanceEntry.deleteMany({
    where: { studentId: latecomer, attendanceDay: { date: { in: [dates[0], dates[1]] } } },
  });
  await prisma.$transaction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tx) => syncAttendanceTotals(tx as any, school.id, term.id, classGroup.id),
    { timeout: 60_000, maxWait: 20_000 },
  );
  const card = await prisma.termResult.findUniqueOrThrow({
    where: { termId_studentId: { termId: term.id, studentId: latecomer } },
    select: { daysPresent: true, daysTotal: true },
  });
  assert("out of 3, not out of 5", card.daysTotal === 3 && card.daysPresent === 3, `${card.daysPresent} of ${card.daysTotal}`);
}

// ── FORCED RED: a published card must not move ─────────────────────────────
console.log("\nA published card is not rewritten");
{
  const victim = studentIds[2];
  await prisma.termResult.update({
    where: { termId_studentId: { termId: term.id, studentId: victim } },
    data: { status: "PUBLISHED", daysPresent: 99, daysTotal: 99 },
  });

  await prisma.$transaction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tx) => syncAttendanceTotals(tx as any, school.id, term.id, classGroup.id),
    { timeout: 60_000, maxWait: 20_000 },
  );

  const card = await prisma.termResult.findUniqueOrThrow({
    where: { termId_studentId: { termId: term.id, studentId: victim } },
    select: { daysPresent: true, daysTotal: true },
  });
  assert(
    "the absurd published figure survives, proving the guard fires",
    card.daysPresent === 99 && card.daysTotal === 99,
    `${card.daysPresent} of ${card.daysTotal}`,
  );

  // And once unpublished, it is corrected — a guard that never lets go is a bug
  // wearing a guard's clothes.
  await prisma.termResult.update({
    where: { termId_studentId: { termId: term.id, studentId: victim } },
    data: { status: "DRAFT" },
  });
  await prisma.$transaction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tx) => syncAttendanceTotals(tx as any, school.id, term.id, classGroup.id),
    { timeout: 60_000, maxWait: 20_000 },
  );
  const fixed = await prisma.termResult.findUniqueOrThrow({
    where: { termId_studentId: { termId: term.id, studentId: victim } },
    select: { daysPresent: true, daysTotal: true },
  });
  assert("unpublished, it is put right", fixed.daysPresent === 5 && fixed.daysTotal === 5, `${fixed.daysPresent} of ${fixed.daysTotal}`);
}

// ── A class with no register keeps its typed-in figures ────────────────────
console.log("\nA school still on paper is left alone");
{
  const other = await prisma.classGroup.findFirstOrThrow({
    where: { schoolId: school.id, level: { code: "B4" } },
  });
  await prisma.attendanceDay.deleteMany({ where: { classGroupId: other.id } });
  const student = await prisma.enrollment.findFirstOrThrow({
    where: { classGroupId: other.id, academicYearId: term.academicYearId, status: "ACTIVE" },
    select: { studentId: true },
  });
  await prisma.termResult.upsert({
    where: { termId_studentId: { termId: term.id, studentId: student.studentId } },
    create: {
      schoolId: school.id, termId: term.id, studentId: student.studentId,
      classGroupId: other.id, daysPresent: 42, daysTotal: 50,
    },
    update: { daysPresent: 42, daysTotal: 50 },
  });

  const result = await prisma.$transaction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tx) => syncAttendanceTotals(tx as any, school.id, term.id, other.id),
    { timeout: 60_000, maxWait: 20_000 },
  );
  assert("no register means no write at all", result.days === 0 && result.students === 0, JSON.stringify(result));

  const card = await prisma.termResult.findUniqueOrThrow({
    where: { termId_studentId: { termId: term.id, studentId: student.studentId } },
    select: { daysPresent: true, daysTotal: true },
  });
  assert("the hand-typed 42 of 50 is still there", card.daysPresent === 42 && card.daysTotal === 50, `${card.daysPresent} of ${card.daysTotal}`);
}

// ── One register per class per day ─────────────────────────────────────────
console.log("\nOne register per class per day");
{
  let rejected = false;
  try {
    await prisma.attendanceDay.create({
      data: { schoolId: school.id, termId: term.id, classGroupId: classGroup.id, date: dates[0] },
    });
  } catch {
    rejected = true;
  }
  assert("a second register for the same day is refused by the database", rejected);
}

// ── The real action, over HTTP ─────────────────────────────────────────────
//
// Everything above drives the engine directly, which cannot reach `saveRegister`
// — the term lookup, the roster check and `mayMark` all live behind
// `requireRole` in a "use server" function. This posts the form the way a
// browser with JavaScript disabled would, so those guards are exercised too.
//
// Skipped, loudly, when no app is answering: a check that passes because
// nothing ran is worse than one that does not run.
const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const COOKIE = "school_os_session";

async function appIsUp() {
  try {
    const response = await fetch(`${BASE}/login`, { redirect: "manual" });
    return response.status === 200;
  } catch {
    return false;
  }
}

console.log("\nThe register action, over HTTP");
if (!(await appIsUp())) {
  console.log(`  SKIPPED — nothing answering at ${BASE}. Start the app to run these.`);
} else {
  const { createHash, randomBytes } = await import("node:crypto");
  const { withBypass } = await import("@/lib/tenant-context");

  const membership = await withBypass(() =>
    prisma.membership.findFirstOrThrow({
      where: { schoolId: school.id, role: "OWNER" },
      select: { userId: true, schoolId: true },
    }),
  );
  const token = randomBytes(32).toString("hex");
  await withBypass(() =>
    prisma.session.create({
      data: {
        userId: membership.userId,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        activeSchoolId: membership.schoolId,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    }),
  );

  const day = dayKey(dates[0]);
  const path = `/attendance?class=${classGroup.id}&date=${day}`;
  const page = await fetch(BASE + path, {
    headers: { Cookie: `${COOKIE}=${token}` },
    redirect: "manual",
  });
  const html = await page.text();
  assert("the register screen renders for the office", page.status === 200, `HTTP ${page.status}`);
  assert(
    "and shows the class it was asked for",
    html.includes(`${classGroup.level.name} ${classGroup.name}`),
    "class name missing",
  );
  assert("with a mark button for every child on the roll", (html.match(/aria-pressed=/g) ?? []).length === studentIds.length * 4, `${(html.match(/aria-pressed=/g) ?? []).length} buttons`);

  /**
   * The form Next renders for the no-JS path carries the action id; replaying
   * it runs the genuine action, validation and transaction included.
   *
   * ⚠️ Matched on a `mark:` input, NOT on `classGroupId` and NOT on
   * `$ACTION_ID`. Two traps, both hit on the way here:
   *
   *  - "Remove this day" is also a form, also carries `classGroupId`, and
   *    renders FIRST — the loose match posted to `deleteRegister` and silently
   *    destroyed the day it meant to mark.
   *  - A plain `action={fn}` form carries `$ACTION_ID`; one driven by
   *    `useActionState` carries `$ACTION_REF_n` plus encrypted bound args
   *    instead. Requiring `$ACTION_ID` therefore excluded the only form that
   *    mattered.
   *
   * The register is simply the form that holds marks.
   */
  const registerForm = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)]
    .map((match) => match[1])
    .find((inner) => inner.includes('name="mark:'));
  assert("the register form posts without JavaScript", Boolean(registerForm), "no action form found");

  if (registerForm) {
    // The encrypted bound-argument blobs are HTML-escaped in the attribute, so
    // they have to be unescaped or the action cannot decrypt them.
    const unescape = (value: string) =>
      value
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");

    const body = new FormData();
    for (const tag of registerForm.match(/<input\b[^>]*>/g) ?? []) {
      const name = tag.match(/name="([^"]*)"/)?.[1];
      if (!name || name.startsWith("mark:")) continue;
      body.append(unescape(name), unescape(tag.match(/value="([^"]*)"/)?.[1] ?? ""));
    }
    // Everyone absent, which is both a real thing a register says and the
    // opposite of what the rows currently hold — so a no-op cannot pass.
    for (const studentId of studentIds) {
      body.append(`mark:${studentId}`, "ABSENT");
    }

    const posted = await fetch(BASE + path, {
      method: "POST",
      headers: { Cookie: `${COOKIE}=${token}` },
      body,
      redirect: "manual",
    });
    assert("the action accepts the post", posted.status < 400, `HTTP ${posted.status}`);

    const after = await getAttendanceSummary(term.id, classGroup.id);
    const changed = after.rows.find((row) => row.studentId === studentIds[3]);
    assert(
      "marking everyone absent through the action is stored",
      changed !== undefined && changed.absent >= 1,
      changed ? `${changed.absent} absences` : "no row",
    );

    const card = await prisma.termResult.findUniqueOrThrow({
      where: { termId_studentId: { termId: term.id, studentId: studentIds[3] } },
      select: { daysPresent: true, daysTotal: true },
    });
    assert(
      "and the report card followed without anyone pressing Compute",
      card.daysPresent === 4 && card.daysTotal === 5,
      `${card.daysPresent} of ${card.daysTotal}`,
    );
  }

  await withBypass(() =>
    prisma.session.deleteMany({
      where: { tokenHash: createHash("sha256").update(token).digest("hex") },
    }),
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
await prisma.$disconnect();
