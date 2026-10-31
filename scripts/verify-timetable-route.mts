/**
 * The timetable's routes and pages, against the real app and database.
 *
 *   npm run verify:timetable-route        (needs the app running)
 *
 * `verify:timetable` proves the rules. This proves they are enforced where a
 * browser cannot be trusted, and that the pages show what the rules decide.
 *
 *   - only the head (LEADERSHIP) places a lesson or sets the school day;
 *   - one teacher cannot be put in two classes at the same period, worked out
 *     from the year's teaching assignments; and a clash that appears AFTER the
 *     lessons were placed (an assignment edited later) is still shown;
 *   - a double lesson is all or nothing; a break takes no lesson; a subject the
 *     class's level does not offer is refused; another school's class id is refused;
 *   - a teacher sees their own week and no one else's.
 *
 * It WRITES to the demo school (a school day, lessons, and two teaching
 * assignments) and removes every row it made, also after a failure. It refuses to
 * start when the school already has a timetable, because it could not tell its own
 * rows from yours.
 *
 * Development databases only.
 */
import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { withBypass } from "@/lib/tenant-context";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const COOKIE = "school_os_session";
// The development link answers in seconds, and Prisma's defaults (a ten second wait for a connection) give
// up before it does. Patient here, because this script is one client doing one thing at a time.
const dbUrl = new URL(process.env.DIRECT_URL!);
dbUrl.searchParams.set("pool_timeout", "60");
dbUrl.searchParams.set("connect_timeout", "60");
const prisma = new PrismaClient({ datasourceUrl: dbUrl.toString() });

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail.slice(0, 400)}` : ""}`);
  if (!ok) failures += 1;
}

{
  const up = await fetch(`${BASE}/login`, { redirect: "manual" }).then((r) => r.status === 200, () => false);
  if (!up) {
    console.log(`  SKIPPED — nothing answering at ${BASE}. Start the app to run this.`);
    process.exit(0);
  }
}

const school = await prisma.school.findUniqueOrThrow({ where: { slug: "hope-demo" } });
const year = await prisma.academicYear.findFirstOrThrow({ where: { schoolId: school.id, isCurrent: true }, select: { id: true } });
if ((await prisma.timetablePeriod.count({ where: { schoolId: school.id } })) > 0) {
  console.log("  The demo school already has a school day, so this guard cannot tell its rows from yours.");
  console.log("  Clear it first:  delete from \"TimetableSlot\"; delete from \"TimetablePeriod\"; (dev database only)");
  process.exit(1);
}

const startedAt = new Date();
const sessions: string[] = [];
const madeAssignments: string[] = [];
let madePeriods = false;

async function sessionFor(userId: string) {
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await withBypass(() =>
    prisma.session.create({ data: { userId, tokenHash, activeSchoolId: school.id, expiresAt: new Date(Date.now() + 3 * 3_600_000) } }),
  );
  sessions.push(tokenHash);
  return token;
}

type Json = Record<string, unknown>;
async function post(token: string | null, path: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { ...headers, ...(token ? { Cookie: `${COOKIE}=${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
    redirect: "manual",
  });
  let json: Json = {};
  try {
    json = (await response.json()) as Json;
  } catch {
    // a redirect has no body
  }
  return { status: response.status, json, error: String(json.error ?? (json.errors as string[] | undefined)?.join(" ") ?? "") };
}
const get = async (token: string, path: string) => {
  const response = await fetch(`${BASE}${path}`, { headers: { Cookie: `${COOKIE}=${token}` }, redirect: "manual" });
  return { status: response.status, html: await response.text() };
};
const slotsOf = (classGroupId: string) =>
  prisma.timetableSlot.findMany({ where: { classGroupId, academicYearId: year.id }, select: { weekday: true, periodId: true, subjectId: true } });

try {
  const owner = await withBypass(() => prisma.membership.findFirstOrThrow({ where: { schoolId: school.id, role: "OWNER" }, select: { userId: true } }));
  const ownerToken = await sessionFor(owner.userId);

  // ── fixtures, taken from the school's real teaching assignments ──────────────────────────────────
  // The demo school gives every class ten subjects spread over the same five teachers, so the guard
  // finds its teacher in the data instead of assuming one: X teaches something in B5 AND something in
  // B6, which is exactly the person who can be double-booked. It creates one extra assignment, for the
  // "changed after the lessons were placed" case, and removes it.
  const classes = await prisma.classGroup.findMany({ where: { schoolId: school.id, level: { code: { in: ["B5", "B6"] } } }, select: { id: true, levelId: true, level: { select: { code: true } } } });
  const b5 = classes.find((c) => c.level.code === "B5")!;
  const b6 = classes.find((c) => c.level.code === "B6")!;
  const offered6 = new Set((await prisma.levelSubject.findMany({ where: { levelId: b6.levelId }, select: { subjectId: true } })).map((r) => r.subjectId));
  const assignments = await prisma.teachingAssignment.findMany({
    where: { academicYearId: year.id, classGroupId: { in: [b5.id, b6.id] } },
    select: { staffId: true, classGroupId: true, subjectId: true },
  });
  const staffIn = (classGroupId: string) => new Set(assignments.filter((a) => a.classGroupId === classGroupId).map((a) => a.staffId));
  const teachersOf = (classGroupId: string, subjectId: string) =>
    assignments.filter((a) => a.classGroupId === classGroupId && a.subjectId === subjectId).map((a) => a.staffId);
  const xId = [...staffIn(b5.id)].find((id) => staffIn(b6.id).has(id));
  if (!xId) throw new Error("No teacher teaches in both B5 and B6; run this guard on the seeded demo school");
  const x = await prisma.staff.findUniqueOrThrow({ where: { id: xId }, select: { id: true, firstName: true, lastName: true } });
  const subjectA = assignments.find((a) => a.staffId === xId && a.classGroupId === b5.id)!.subjectId; // X teaches it to B5
  const subjectB = assignments.find((a) => a.staffId === xId && a.classGroupId === b6.id)!.subjectId; // X teaches it to B6
  const subjectD = assignments.find((a) => a.classGroupId === b5.id && a.subjectId !== subjectA)!.subjectId; // any other B5 subject
  const subjectC = assignments.find((a) => a.classGroupId === b6.id && !teachersOf(b6.id, a.subjectId).includes(xId))?.subjectId; // B6, X does NOT teach it
  if (!subjectC) throw new Error("Every B6 subject is taught by the same teacher; the 'changed afterwards' case cannot be set up");
  console.log(`  (the teacher under test is ${x.firstName} ${x.lastName}, who teaches in both B5 and B6)`);

  console.log("The school day");
  {
    const signedOut = await post(null, "/api/timetable/periods", { standard: true });
    check("a signed-out caller is sent to sign in and nothing is made", signedOut.status >= 300 && signedOut.status < 400 && (await prisma.timetablePeriod.count({ where: { schoolId: school.id } })) === 0, `HTTP ${signedOut.status}`);
    const text = await post(ownerToken, "/api/timetable/periods", "x=1", { "content-type": "text/plain" });
    check("a body that is not JSON is refused (415)", text.status === 415);
    const cross = await post(ownerToken, "/api/timetable/periods", { standard: true }, { "content-type": "application/json", "sec-fetch-site": "cross-site" });
    check("a post from another site is refused (403)", cross.status === 403 && (await prisma.timetablePeriod.count({ where: { schoolId: school.id } })) === 0);

    const teacher = await withBypass(() => prisma.membership.findFirst({ where: { schoolId: school.id, role: "TEACHER", staffId: { not: null }, user: { mustChangePassword: false } }, select: { userId: true, staffId: true } }));
    if (teacher) {
      const teacherToken = await sessionFor(teacher.userId);
      const refused = await post(teacherToken, "/api/timetable/periods", { standard: true });
      check("a teacher cannot set the school day", refused.status >= 300 && refused.status < 400 && (await prisma.timetablePeriod.count({ where: { schoolId: school.id } })) === 0, `HTTP ${refused.status}`);
    } else {
      console.log("  SKIPPED — no teacher login in the demo school");
    }

    const made = await post(ownerToken, "/api/timetable/periods", { standard: true });
    madePeriods = true;
    const rows = await prisma.timetablePeriod.findMany({ where: { schoolId: school.id }, orderBy: { order: "asc" } });
    check("the head can give the school the standard day", made.status === 200 && rows.length === 9 && rows.filter((r) => r.isBreak).length === 2, JSON.stringify(made));
    check("with the orders 1 to 9 and no gap", rows.map((r) => r.order).join() === "1,2,3,4,5,6,7,8,9");
    const again = await post(ownerToken, "/api/timetable/periods", { standard: true });
    check("and cannot do it twice", again.status === 422 && /already/.test(again.error) && (await prisma.timetablePeriod.count({ where: { schoolId: school.id } })) === 9);

    const bad = await post(ownerToken, "/api/timetable/periods", { rows: rows.map((r) => ({ id: r.id, label: r.label, startTime: r.id === rows[0].id ? "9am" : r.startTime, endTime: r.endTime, isBreak: r.isBreak })) });
    check("a bad time is refused with the reason, and nothing changes", bad.status === 422 && /not a time/.test(bad.error), JSON.stringify(bad));
    const foreign = await post(ownerToken, "/api/timetable/periods", { rows: [{ id: "not-mine", label: "X", startTime: "08:00", endTime: "09:00", isBreak: false }] });
    check("a period id that is not this school's is refused", foreign.status === 422 && /not found/.test(foreign.error), JSON.stringify(foreign));
    const renamed = await post(ownerToken, "/api/timetable/periods", { rows: rows.map((r, i) => ({ id: r.id, label: i === 0 ? "First lesson" : r.label, startTime: r.startTime, endTime: r.endTime, isBreak: r.isBreak })) });
    const after = await prisma.timetablePeriod.findMany({ where: { schoolId: school.id }, orderBy: { order: "asc" } });
    check("a period can be renamed and keeps its id (so its lessons stay with it)", renamed.status === 200 && after[0].id === rows[0].id && after[0].label === "First lesson" && after.length === 9, JSON.stringify(renamed));
  }

  const periods = await prisma.timetablePeriod.findMany({ where: { schoolId: school.id }, orderBy: { order: "asc" } });
  const lessonPeriods = periods.filter((p) => !p.isBreak);
  const [p1, p2, p3] = lessonPeriods;
  const theBreak = periods.find((p) => p.isBreak)!;
  const lessonBeforeBreak = periods[periods.findIndex((p) => p.isBreak) - 1];
  const place = (token: string, classGroupId: string, weekday: number, periodId: string, subjectId: string, double = false) =>
    post(token, "/api/timetable/slot", { classGroupId, weekday, periodId, subjectId, double });

  console.log("\nPlacing a lesson");
  {
    const bad = await place(ownerToken, b5.id, 6, p1.id, subjectA);
    check("a Saturday is refused", bad.status === 400);
    const ok = await place(ownerToken, b5.id, 1, p1.id, subjectA);
    check("the head places a lesson in B5, Monday, period 1", ok.status === 200 && (await slotsOf(b5.id)).length === 1, JSON.stringify(ok));
    const replaced = await place(ownerToken, b5.id, 1, p1.id, subjectD);
    const here = await slotsOf(b5.id);
    check("placing another subject in the same cell replaces it", replaced.status === 200 && here.length === 1 && here[0].subjectId === subjectD, JSON.stringify(replaced));
    await place(ownerToken, b5.id, 1, p1.id, subjectA);

    const onBreak = await place(ownerToken, b5.id, 1, theBreak.id, subjectA);
    check("a break takes no lesson", onBreak.status === 422 && /break/.test(onBreak.error) && (await slotsOf(b5.id)).length === 1, JSON.stringify(onBreak));
    const nowhere = await place(ownerToken, "no-such-class", 1, p1.id, subjectA);
    check("a class that is not this school's is refused", nowhere.status === 422 && /not found/.test(nowhere.error), JSON.stringify(nowhere));
    const noPeriod = await place(ownerToken, b5.id, 1, "no-such-period", subjectA);
    check("so is a period that is not", noPeriod.status === 422 && /not found/.test(noPeriod.error), JSON.stringify(noPeriod));

    const notOffered = (await prisma.subject.findMany({ where: { schoolId: school.id }, select: { id: true } })).map((s) => s.id).filter((id) => !offered6.has(id));
    if (notOffered.length > 0) {
      const wrong = await place(ownerToken, b6.id, 2, p1.id, notOffered[0]);
      check("a subject the class's level does not offer is refused", wrong.status === 422 && /does not offer/.test(wrong.error) && (await slotsOf(b6.id)).length === 0, JSON.stringify(wrong));
    } else {
      console.log("  SKIPPED — every subject in the demo school is offered at B6");
    }
  }

  console.log("\nOne teacher, two classes");
  {
    const clash = await place(ownerToken, b6.id, 1, p1.id, subjectB);
    check("the teacher cannot be put in B6 at the time they are in B5", clash.status === 422 && clash.error.includes(x.firstName) && /already teaching/.test(clash.error), JSON.stringify(clash));
    check("and nothing was written for B6", (await slotsOf(b6.id)).length === 0);
    const elsewhere = await place(ownerToken, b6.id, 1, p2.id, subjectB);
    check("another period is fine", elsewhere.status === 200, JSON.stringify(elsewhere));
    const day = await place(ownerToken, b6.id, 2, p1.id, subjectB);
    check("so is another day", day.status === 200, JSON.stringify(day));
    const cleared = await place(ownerToken, b6.id, 2, p1.id, "");
    check("a lesson can be taken off", cleared.status === 200 && (await slotsOf(b6.id)).filter((s) => s.weekday === 2).length === 0);
    await place(ownerToken, b5.id, 1, p1.id, "");
    const lifted = await place(ownerToken, b6.id, 1, p1.id, subjectB);
    check("the clash lifts when the other class's lesson is cleared", lifted.status === 200, JSON.stringify(lifted));
    await place(ownerToken, b6.id, 1, p1.id, "");
    await place(ownerToken, b6.id, 1, p2.id, "");
  }

  console.log("\nA double lesson is all or nothing");
  {
    const dbl = await place(ownerToken, b5.id, 3, p1.id, subjectA, true);
    const rows = (await slotsOf(b5.id)).filter((s) => s.weekday === 3);
    check("a double fills this period and the next", dbl.status === 200 && rows.length === 2 && rows.some((r) => r.periodId === p1.id) && rows.some((r) => r.periodId === p2.id), JSON.stringify(dbl));
    const acrossBreak = await place(ownerToken, b5.id, 3, lessonBeforeBreak.id, subjectD, true);
    check("a double cannot run into a break", acrossBreak.status === 422 && /double/.test(acrossBreak.error) && (await slotsOf(b5.id)).filter((s) => s.weekday === 3).length === 2, JSON.stringify(acrossBreak));
    // The teacher is in B6 in period 2 on Thursday; a double in B5 from period 1 would put them in both at period 2.
    await place(ownerToken, b6.id, 4, p2.id, subjectB);
    const half = await place(ownerToken, b5.id, 4, p1.id, subjectA, true);
    check("a double whose SECOND period clashes is refused whole, the first is not left behind", half.status === 422 && (await slotsOf(b5.id)).filter((s) => s.weekday === 4).length === 0, JSON.stringify(half));
    const one = await place(ownerToken, b5.id, 3, p1.id, "");
    check("clearing a period leaves its neighbour", one.status === 200 && (await slotsOf(b5.id)).filter((s) => s.weekday === 3).length === 1);
    await place(ownerToken, b5.id, 3, p2.id, "");
    await place(ownerToken, b6.id, 4, p2.id, "");
  }

  console.log("\nA clash made AFTER the lessons were placed is still shown");
  {
    // X teaches subjectA to B5; subjectC in B6 is taught by someone else. Both on Friday period 3: no clash.
    await place(ownerToken, b5.id, 5, p3.id, subjectA);
    const fine = await place(ownerToken, b6.id, 5, p3.id, subjectC);
    check("two different teachers in two classes at once is fine", fine.status === 200, JSON.stringify(fine));
    // Now the head also makes X the teacher of subjectC in B6: they are in two classes, and nobody placed that.
    const made = await prisma.teachingAssignment.create({ data: { schoolId: school.id, academicYearId: year.id, staffId: xId, classGroupId: b6.id, subjectId: subjectC } });
    madeAssignments.push(made.id);
    const page = await get(ownerToken, `/timetable?class=${b6.id}`);
    check("the class page warns that the teacher is also in B5 at that time", page.status === 200 && /is also in/.test(page.html) && page.html.includes(x.lastName), `HTTP ${page.status}`);
    const home = await get(ownerToken, "/timetable");
    check("and the head sees a school-wide warning", home.status === 200 && /in two classes at once/.test(home.html));
    const week = await get(ownerToken, `/timetable?view=teacher&staff=${xId}`);
    check("the teacher's own week shows the clash, not just one of the lessons", week.status === 200 && /In two classes at once/.test(week.html), `HTTP ${week.status}`);
    await prisma.teachingAssignment.delete({ where: { id: made.id } });
    madeAssignments.pop();
    const after = await get(ownerToken, `/timetable?class=${b6.id}`);
    check("and the warning goes when the assignment is put back", after.status === 200 && !/is also in/.test(after.html));
  }

  console.log("\nA teacher sees their own week");
  {
    const teacher = await withBypass(() => prisma.membership.findFirst({ where: { schoolId: school.id, role: "TEACHER", staffId: { not: null }, user: { mustChangePassword: false } }, select: { userId: true, staffId: true } }));
    if (!teacher) {
      console.log("  SKIPPED — no teacher login in the demo school");
    } else {
      const token = await sessionFor(teacher.userId);
      const mine = await get(token, "/timetable");
      check("a teacher opens the timetable", mine.status === 200 && /My timetable/.test(mine.html), `HTTP ${mine.status}`);
      check("and gets no class or teacher picker", !/name="class"/.test(mine.html) && !/name="staff"/.test(mine.html));
      const snoop = await get(token, `/timetable?view=teacher&staff=${xId}&class=${b5.id}`);
      check("asking for a colleague's week by URL changes nothing", snoop.status === 200 && /My timetable/.test(snoop.html) && !/name="staff"/.test(snoop.html));
      const setup = await get(token, "/timetable/periods");
      check("the school-day page is refused to a teacher", setup.status >= 300 && setup.status < 400, `HTTP ${setup.status}`);
      const slot = await place(token, b5.id, 2, p1.id, subjectA);
      check("and so is placing a lesson", slot.status >= 300 && slot.status < 400 && (await slotsOf(b5.id)).filter((s) => s.weekday === 2).length === 0, `HTTP ${slot.status}`);
    }
  }
} finally {
  // Everything this run made, and nothing it did not.
  await prisma.timetableSlot.deleteMany({ where: { schoolId: school.id, academicYearId: year.id } });
  if (madePeriods) await prisma.timetablePeriod.deleteMany({ where: { schoolId: school.id } });
  await prisma.teachingAssignment.deleteMany({ where: { id: { in: madeAssignments } } });
  await prisma.auditLog.deleteMany({ where: { schoolId: school.id, action: { startsWith: "timetable." }, createdAt: { gte: startedAt } } });
  await withBypass(() => prisma.session.deleteMany({ where: { tokenHash: { in: sessions } } }));
  await prisma.$disconnect();
}

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
