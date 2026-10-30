/**
 * The route a phone posts its queued registers to, against the real app and database.
 *
 *   npm run verify:offline-sync        (needs the app running)
 *
 * `verify:offline-register` proves the rules; this proves they are enforced where
 * a phone cannot be trusted. Nothing here is a refusal-only check: it writes a
 * register (on days no other guard uses) and removes every row it made.
 *
 * What it settles that nothing else can:
 *   - a phone speaks only for the children it listed. The office marks a child
 *     the phone never saw; the phone's late post must leave that mark alone.
 *   - the form teacher of a class may send it, any other teacher may not, a
 *     signed-out caller gets nothing written.
 *   - the same register posted twice is the same register.
 *
 * Development databases only (it writes to the demo school), like verify:attendance.
 */
import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { syncAttendanceTotals } from "@/lib/attendance-engine";
import { dayKey } from "@/lib/attendance-data";
import { withBypass } from "@/lib/tenant-context";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const COOKIE = "school_os_session";
const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail.slice(0, 300)}` : ""}`);
  if (!ok) failures += 1;
}

try {
  const up = await fetch(`${BASE}/login`, { redirect: "manual" }).then((r) => r.status === 200, () => false);
  if (!up) {
    console.log(`  SKIPPED — nothing answering at ${BASE}. Start the app to run this.`);
    process.exit(0);
  }
} catch {
  process.exit(0);
}

const school = await prisma.school.findUniqueOrThrow({ where: { slug: "hope-demo" } });
const term = await prisma.term.findFirstOrThrow({
  where: { schoolId: school.id, sequence: 1 },
  select: { id: true, startDate: true, endDate: true, academicYearId: true },
});
const classGroup = await prisma.classGroup.findFirstOrThrow({
  where: { schoolId: school.id, level: { code: "B5" } },
  select: { id: true, formTeacherId: true },
});
const roster = await prisma.enrollment.findMany({
  where: { classGroupId: classGroup.id, academicYearId: term.academicYearId, status: "ACTIVE" },
  select: { studentId: true },
  orderBy: { studentId: "asc" },
});
const ids = roster.map((r) => r.studentId);
if (ids.length < 4) throw new Error(`B5 needs at least 4 pupils to run this; it has ${ids.length}`);

// Two days well inside the term that no other guard marks (verify:attendance uses the first five).
const day = (offset: number) => {
  const d = new Date(term.startDate);
  d.setUTCDate(d.getUTCDate() + offset);
  return dayKey(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())));
};
const D1 = day(40);
const D2 = day(41);
if (new Date(D2) > term.endDate) throw new Error("The first term is too short for this guard");
const startedAt = new Date();

// A pupil from a class that is not B5, for "a child who is not on this roll".
const stranger = await prisma.enrollment.findFirstOrThrow({
  where: { schoolId: school.id, academicYearId: term.academicYearId, classGroupId: { not: classGroup.id }, status: "ACTIVE" },
  select: { studentId: true },
});

const sessions: string[] = [];
async function sessionFor(userId: string) {
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await withBypass(() =>
    prisma.session.create({ data: { userId, tokenHash, activeSchoolId: school.id, expiresAt: new Date(Date.now() + 3 * 3_600_000) } }),
  );
  sessions.push(tokenHash);
  return token;
}

async function post(token: string | null, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) {
  const response = await fetch(`${BASE}/api/attendance/sync`, {
    method: "POST",
    headers: { ...headers, ...(token ? { Cookie: `${COOKIE}=${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
    redirect: "manual",
  });
  let json: { error?: string; results?: Array<{ key: string; ok: boolean; message?: string; error?: string }> } = {};
  try {
    json = await response.json();
  } catch {
    // a redirect has no body
  }
  return { status: response.status, json };
}
const item = (date: string, marks: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  classGroupId: classGroup.id, date, marks, markedAt: new Date().toISOString(), ...extra,
});
const entriesOn = async (date: string) =>
  prisma.attendanceEntry.findMany({
    where: { attendanceDay: { classGroupId: classGroup.id, date: new Date(`${date}T00:00:00Z`) } },
    select: { studentId: true, mark: true, note: true },
  });

try {
  const owner = await withBypass(() => prisma.membership.findFirstOrThrow({ where: { schoolId: school.id, role: "OWNER" }, select: { userId: true } }));
  const ownerToken = await sessionFor(owner.userId);

  console.log("Refusals, before anything is written");
  {
    const signedOut = await post(null, { items: [item(D1, { [ids[0]]: "PRESENT" })] });
    check("a signed-out caller is sent to sign in and nothing is written", signedOut.status >= 300 && signedOut.status < 400 && (await entriesOn(D1)).length === 0, `HTTP ${signedOut.status}`);
    const text = await post(ownerToken, "x=1", { "content-type": "text/plain" });
    check("a body that is not JSON is refused (415)", text.status === 415, `HTTP ${text.status}`);
    const cross = await post(ownerToken, { items: [item(D1, { [ids[0]]: "PRESENT" })] }, { "content-type": "application/json", "sec-fetch-site": "cross-site" });
    check("a post from another site is refused (403)", cross.status === 403 && (await entriesOn(D1)).length === 0, `HTTP ${cross.status}`);
    const broken = await post(ownerToken, "{nope");
    check("broken JSON is a 400", broken.status === 400, `HTTP ${broken.status}`);
    const badMark = await post(ownerToken, { items: [item(D1, { [ids[0]]: "HERE" })] });
    check("a mark that is not one of the four is a 400 and writes nothing", badMark.status === 400 && (await entriesOn(D1)).length === 0, `HTTP ${badMark.status}`);
    const outside = await post(ownerToken, { items: [item("1990-01-04", { [ids[0]]: "PRESENT" })] });
    check("a day outside every term is refused for that register, in words", outside.status === 200 && outside.json.results?.[0]?.ok === false && /not inside any term/.test(outside.json.results[0].error ?? ""), JSON.stringify(outside.json));
    const foreignClass = await post(ownerToken, { items: [{ ...item(D1, { [ids[0]]: "PRESENT" }), classGroupId: "does-not-exist" }] });
    check("a class that is not this school's is refused", foreignClass.json.results?.[0]?.ok === false && /not found/.test(foreignClass.json.results[0].error ?? ""), JSON.stringify(foreignClass.json));
  }

  console.log("\nA register taken with no signal, sent later");
  {
    const sent = await post(ownerToken, {
      items: [item(D1, { [ids[0]]: "PRESENT", [ids[1]]: "EXCUSED", [ids[2]]: "LATE" }, { notes: { [ids[1]]: "funeral", [ids[0]]: "ignored on a present child" } })],
    });
    check("the route accepts it", sent.status === 200 && sent.json.results?.[0]?.ok === true, JSON.stringify(sent.json));
    const rows = await entriesOn(D1);
    const by = new Map(rows.map((r) => [r.studentId, r]));
    check("every listed child has their mark", rows.length === 3 && by.get(ids[0])?.mark === "PRESENT" && by.get(ids[1])?.mark === "EXCUSED" && by.get(ids[2])?.mark === "LATE");
    check("a reason is kept only on the excused child", by.get(ids[1])?.note === "funeral" && by.get(ids[0])?.note === null);

    const audit = await prisma.auditLog.findFirst({
      where: { schoolId: school.id, action: "attendance.register", entityId: classGroup.id, createdAt: { gte: startedAt } },
      orderBy: { createdAt: "desc" },
    });
    const after = (audit?.after ?? {}) as { offline?: boolean; markedAt?: string };
    check("the audit trail says it came from a phone, and when it was marked", after.offline === true && typeof after.markedAt === "string", JSON.stringify(after));

    const again = await post(ownerToken, { items: [item(D1, { [ids[0]]: "PRESENT", [ids[1]]: "EXCUSED", [ids[2]]: "LATE" }, { notes: { [ids[1]]: "funeral" } })] });
    check("sending the same register again changes nothing", again.json.results?.[0]?.ok === true && (await entriesOn(D1)).length === 3);
    const days = await prisma.attendanceDay.count({ where: { classGroupId: classGroup.id, date: new Date(`${D1}T00:00:00Z`) } });
    check("and there is still one register for the day", days === 1, `${days}`);
  }

  console.log("\nA phone speaks only for the children it listed");
  {
    // The office marks a child the phone never listed.
    const day1 = await prisma.attendanceDay.findFirstOrThrow({ where: { classGroupId: classGroup.id, date: new Date(`${D1}T00:00:00Z`) }, select: { id: true } });
    await prisma.attendanceEntry.create({
      data: { schoolId: school.id, attendanceDayId: day1.id, studentId: ids[3], mark: "EXCUSED", note: "marked by the office" },
    });
    // The phone corrects one child, clears another (it listed ids[2] as ""), and adds a stranger.
    const late = await post(ownerToken, {
      items: [item(D1, { [ids[0]]: "ABSENT", [ids[2]]: "", [stranger.studentId]: "PRESENT" })],
    });
    check("the late post is accepted", late.json.results?.[0]?.ok === true, JSON.stringify(late.json));
    const by = new Map((await entriesOn(D1)).map((r) => [r.studentId, r]));
    check("a child the phone did not list keeps the office's mark, note and all", by.get(ids[3])?.mark === "EXCUSED" && by.get(ids[3])?.note === "marked by the office");
    check("a child the phone listed and corrected is corrected", by.get(ids[0])?.mark === "ABSENT");
    check("a child the phone listed and cleared loses their entry", !by.has(ids[2]));
    check("a child it listed earlier and not this time is left as they were", by.get(ids[1])?.mark === "EXCUSED" && by.get(ids[1])?.note === "funeral");
    check("a child who is not on this class's roll is not written", !by.has(stranger.studentId));
    check("and the answer says so", /no longer in this class/.test(late.json.results?.[0]?.message ?? ""), late.json.results?.[0]?.message);
  }

console.log("\nThe report card follows without anyone pressing Compute");
  {
    const day2 = await post(ownerToken, { items: [item(D2, Object.fromEntries(ids.map((id) => [id, "PRESENT"])))] });
    check("a second day for the whole class", day2.json.results?.[0]?.ok === true, JSON.stringify(day2.json));
    const card = await prisma.termResult.findFirst({ where: { termId: term.id, studentId: ids[0] }, select: { daysPresent: true, daysTotal: true } });
    check("daysTotal now counts the days the register was taken", card !== null && (card.daysTotal ?? 0) >= 2, JSON.stringify(card));
  }

  console.log("\nWho may send a register");
  {
    const teachers = await withBypass(() =>
      prisma.membership.findMany({
        where: { schoolId: school.id, role: "TEACHER", staffId: { not: null }, user: { mustChangePassword: false } },
        select: { userId: true, staffId: true },
      }),
    );
    const formTeacher = teachers.find((t) => t.staffId === classGroup.formTeacherId);
    const other = teachers.find((t) => t.staffId !== classGroup.formTeacherId);
    if (!formTeacher || !other) {
      console.log("  SKIPPED — the demo school has no login for both this class's form teacher and another teacher");
    } else {
      const refusedToken = await sessionFor(other.userId);
      const before = (await entriesOn(D1)).length;
      const refused = await post(refusedToken, { items: [item(D1, { [ids[0]]: "LATE" })] });
      check("a teacher who is not this class's form teacher is refused", refused.json.results?.[0]?.ok === false && /form teacher/.test(refused.json.results[0].error ?? ""), JSON.stringify(refused));
      check("and nothing was written", (await entriesOn(D1)).length === before && (await entriesOn(D1)).find((r) => r.studentId === ids[0])?.mark === "ABSENT");
      const okToken = await sessionFor(formTeacher.userId);
      const accepted = await post(okToken, { items: [item(D1, { [ids[0]]: "LATE" })] });
      check("the form teacher may send it", accepted.json.results?.[0]?.ok === true, JSON.stringify(accepted));
      check("and their mark is stored", (await entriesOn(D1)).find((r) => r.studentId === ids[0])?.mark === "LATE");
    }
  }
} finally {
  // Everything this run made, and nothing it did not.
  await prisma.attendanceDay.deleteMany({
    where: { classGroupId: classGroup.id, date: { in: [new Date(`${D1}T00:00:00Z`), new Date(`${D2}T00:00:00Z`)] } },
  });
  await prisma.auditLog.deleteMany({ where: { schoolId: school.id, action: "attendance.register", entityId: classGroup.id, createdAt: { gte: startedAt } } });
  await prisma.$transaction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tx) => syncAttendanceTotals(tx as any, school.id, term.id, classGroup.id),
    { timeout: 60_000, maxWait: 20_000 },
  );
  await withBypass(() => prisma.session.deleteMany({ where: { tokenHash: { in: sessions } } }));
  await prisma.$disconnect();
}

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
