/**
 * Admissions, against the real app and database.
 *
 *   npm run verify:admissions-route        (needs the app running)
 *
 * `verify:admissions` proves the rules and the shape of the code. This proves they hold where a browser
 * cannot be trusted:
 *
 *   - the PUBLIC form: closed means "not found", the same as an unknown school; a script that fills the
 *     hidden field is told it worked and nothing is saved; JSON only, same-origin only, a body cap;
 *     another school's class is refused; one address is limited per hour; a repeat submission of the
 *     same child is accepted and then flagged to the OFFICE rather than refused to a stranger;
 *   - the PIPELINE, run as the office through the real engine: a place offered is a place counted, the
 *     last one cannot be promised twice, admitting an accepted child creates the pupil with the class,
 *     the guardian and the audit row, two admits at once make one pupil, a full class refuses, a child
 *     starting in a later year is admitted without a class and still counted against that year's places;
 *   - the SCREENS: the head sees the queue, the places and a child's page; a teacher and a stranger do not.
 *
 * It builds its own level, class and (later) year, so it does not depend on what the demo school holds, and
 * it removes everything it made, also after a failure. Development databases only.
 */
import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { ONLINE_PER_ADDRESS_PER_HOUR, MAX_BODY, readApplication, type ApplicationInput } from "@/lib/admissions-rules";

// The development link answers in seconds, and Prisma's defaults (a ten second wait for a connection) give
// up before it does: two simultaneous decisions, each several round trips, then fail with P2024 on a slow
// day for reasons that have nothing to do with the code. Patient here, set BEFORE the app's client is made,
// which is why the engine is imported below and not at the top.
{
  const appUrl = new URL(process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL!);
  appUrl.searchParams.set("pool_timeout", "90");
  appUrl.searchParams.set("connect_timeout", "60");
  process.env.APP_DATABASE_URL = appUrl.toString();
}
const { prisma: app } = await import("@/lib/prisma");
const { runWithTenantContext, withBypass } = await import("@/lib/tenant-context");
const { admitApplication, createApplication, deleteApplication, loadSeats, moveApplication, recordTest, updateApplication } = await import("@/lib/admissions-engine");

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const COOKIE = "school_os_session";
// The development link answers in seconds and Prisma's defaults give up before it does.
const dbUrl = new URL(process.env.DIRECT_URL!);
dbUrl.searchParams.set("pool_timeout", "60");
dbUrl.searchParams.set("connect_timeout", "60");
const owner = new PrismaClient({ datasourceUrl: dbUrl.toString() });

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

const school = await owner.school.findUniqueOrThrow({ where: { slug: "hope-demo" }, select: { id: true, name: true, slug: true } });
const year = await owner.academicYear.findFirstOrThrow({ where: { schoolId: school.id, isCurrent: true }, select: { id: true, name: true } });
const settingsBefore = await owner.schoolSettings.findUniqueOrThrow({ where: { schoolId: school.id }, select: { applicationsOpen: true, applicationsNote: true } });

const startedAt = new Date();
const sessions: string[] = [];
const phone = `020${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
const addresses: string[] = [];

const inSchool = <T,>(fn: () => Promise<T>) => runWithTenantContext({ schoolId: school.id }, fn);
const actor = { schoolId: school.id, userId: null as string | null };

async function sessionFor(userId: string) {
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await withBypass(() => owner.session.create({ data: { userId, tokenHash, activeSchoolId: school.id, expiresAt: new Date(Date.now() + 3 * 3_600_000) } }));
  sessions.push(tokenHash);
  return token;
}

type Json = Record<string, unknown>;
async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    redirect: "manual",
  });
  let json: Json = {};
  try {
    json = (await response.json()) as Json;
  } catch {
    // no body
  }
  return { status: response.status, json, error: String(json.error ?? "") };
}
const get = async (path: string, token?: string) => {
  const response = await fetch(`${BASE}${path}`, { headers: token ? { Cookie: `${COOKIE}=${token}` } : {}, redirect: "manual" });
  return { status: response.status, html: await response.text() };
};
const address = () => {
  const a = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
  addresses.push(a);
  return a;
};

let counter = 0;
function child(first: string, patch: Record<string, unknown> = {}): ApplicationInput {
  counter += 1;
  const read = readApplication({
    firstName: first,
    lastName: "Admtest",
    gender: "FEMALE",
    dateOfBirth: `201${counter % 9}-0${(counter % 9) + 1}-1${counter % 9}`,
    guardianName: "Kofi Admtest",
    guardianPhone: phone,
    notes: "Allergic to groundnuts",
    levelId,
    academicYearId: year.id,
    ...patch,
  });
  if (!read.ok) throw new Error(`fixture: ${read.error}`);
  return read.value;
}

// ── fixtures: a level with one class of ONE place, so the arithmetic is the whole story ─────────────────
await owner.level.deleteMany({ where: { schoolId: school.id, code: "ZZADM" } });
await owner.academicYear.deleteMany({ where: { schoolId: school.id, name: "2098/2099" } });
const level = await owner.level.create({ data: { schoolId: school.id, name: "ZZ Admissions test", code: "ZZADM", stage: "PRIMARY", order: 90 } });
const klass = await owner.classGroup.create({ data: { schoolId: school.id, levelId: level.id, name: "Z", capacity: 1 } });
const otherLevel = await owner.level.findFirst({ where: { schoolId: school.id, id: { not: level.id }, classGroups: { some: {} } }, select: { id: true } });
const levelId = level.id;
const foreignLevel = await owner.level.findFirst({ where: { schoolId: { not: school.id } }, select: { id: true } });
const futureYear = await owner.academicYear.create({
  data: { schoolId: school.id, name: "2098/2099", startDate: new Date("2098-09-01T00:00:00Z"), endDate: new Date("2099-07-31T00:00:00Z") },
});

try {
  const head = await withBypass(() => owner.membership.findFirstOrThrow({ where: { schoolId: school.id, role: "OWNER" }, select: { userId: true } }));
  const headToken = await sessionFor(head.userId);

  console.log("The public form is closed until the school opens it");
  {
    const closed = await post(`/api/apply/${school.slug}`, { ...child("Closed"), dateOfBirth: "2018-03-05" }, { "x-forwarded-for": address() });
    check("a closed form answers 404 and saves nothing", closed.status === 404 && (await owner.application.count({ where: { schoolId: school.id, levelId } })) === 0, `HTTP ${closed.status}`);
    const unknown = await post(`/api/apply/no-such-school-here`, { ...child("Unknown"), dateOfBirth: "2018-03-05" }, { "x-forwarded-for": address() });
    check("an unknown school answers the same 404 with the same words, so it cannot be used to ask which schools exist", unknown.status === 404 && unknown.error === closed.error, `${unknown.status} ${unknown.error} / ${closed.error}`);
    const page = await get(`/apply/${school.slug}`);
    check("the page says the form is not available, and shows no field", page.status === 200 && /not available/.test(page.html) && !/name="firstName"/.test(page.html));
    const junk = await post(`/api/apply/${"x".repeat(200)}`, {}, { "x-forwarded-for": address() });
    check("a slug that could not be a school is turned away before any lookup", junk.status === 404);
  }

  await owner.schoolSettings.update({ where: { schoolId: school.id }, data: { applicationsOpen: true, applicationsNote: "Entrance test on Saturdays." } });

  console.log("\nOnce open, a parent can apply");
  {
    const page = await get(`/apply/${school.slug}`);
    check("the page shows the school's name, its note and the fields", page.status === 200 && page.html.includes(school.name) && /Entrance test on Saturdays/.test(page.html) && /name="firstName"/.test(page.html), `HTTP ${page.status}`);
    check("the page lists the school's classes and years to choose from", page.html.includes("ZZ Admissions test") && page.html.includes(year.name));
    check("it carries the hidden trap field", /name="website"/.test(page.html));
    check("and asks search engines to leave it alone", /noindex/.test(page.html));

    const mine = address();
    const sent = { ...child("Online"), dateOfBirth: "2018-03-05" };
    const ok = await post(`/api/apply/${school.slug}`, sent, { "x-forwarded-for": mine });
    check("a complete application is accepted and answers with its reference", ok.status === 200 && /^APP-\d{4,}$/.test(String(ok.json.reference)), JSON.stringify(ok));
    const row = await owner.application.findFirst({ where: { schoolId: school.id, reference: String(ok.json.reference) } });
    check("it is saved as an ONLINE application, at the first step, for the class asked for", row?.source === "ONLINE" && row.status === "APPLIED" && row.levelId === levelId && row.guardianPhone === phone, JSON.stringify(row));
    const audit = await owner.auditLog.findFirst({ where: { schoolId: school.id, action: "application.submit", entityId: row?.id } });
    check("with an audit row that names no user, because nobody was signed in", audit !== null && audit.actorUserId === null);

    const text = await post(`/api/apply/${school.slug}`, "x=1", { "content-type": "text/plain", "x-forwarded-for": address() });
    check("a body that is not JSON is refused (415)", text.status === 415);
    const cross = await post(`/api/apply/${school.slug}`, sent, { "sec-fetch-site": "cross-site", "x-forwarded-for": address() });
    check("a post from another site is refused (403)", cross.status === 403);
    const huge = await post(`/api/apply/${school.slug}`, JSON.stringify({ ...sent, notes: "x".repeat(MAX_BODY + 10) }), { "x-forwarded-for": address() });
    check("a body over the cap is refused (413) before it is parsed", huge.status === 413);
    const badJson = await post(`/api/apply/${school.slug}`, "{not json", { "x-forwarded-for": address() });
    check("broken JSON is a 400", badJson.status === 400);
    const badPhone = await post(`/api/apply/${school.slug}`, { ...sent, guardianPhone: "12345" }, { "x-forwarded-for": address() });
    check("a phone that is not a mobile number is refused with the reason", badPhone.status === 400 && /Ghanaian mobile/.test(badPhone.error), JSON.stringify(badPhone));
    const array = await post(`/api/apply/${school.slug}`, [1, 2], { "x-forwarded-for": address() });
    check("a body that is a list is refused", array.status === 400);

    const before = await owner.application.count({ where: { schoolId: school.id } });
    const trap = await post(`/api/apply/${school.slug}`, { ...sent, website: "http://spam.example" }, { "x-forwarded-for": address() });
    check("a script that fills the hidden field is told it worked", trap.status === 200 && trap.json.reference === "APP-0000");
    check("and nothing was saved", (await owner.application.count({ where: { schoolId: school.id } })) === before);

    if (foreignLevel) {
      const foreign = await post(`/api/apply/${school.slug}`, { ...sent, levelId: foreignLevel.id }, { "x-forwarded-for": address() });
      check("another school's class is refused", foreign.status === 400 && /not found/.test(foreign.error) && (await owner.application.count({ where: { schoolId: school.id } })) === before, JSON.stringify(foreign));
    } else {
      console.log("  SKIPPED — no second school in this database to point an id at");
    }
    const ended = await owner.academicYear.findFirst({ where: { schoolId: school.id, endDate: { lt: new Date() } }, select: { id: true } });
    if (ended) {
      const old = await post(`/api/apply/${school.slug}`, { ...sent, academicYearId: ended.id }, { "x-forwarded-for": address() });
      check("a year that has already ended is refused", old.status === 400 && /ended/.test(old.error), JSON.stringify(old));
    }

    // The same child sent twice, from two connections.
    const twice = await post(`/api/apply/${school.slug}`, sent, { "x-forwarded-for": address() });
    check("the same child sent again is accepted, and not told it is a repeat", twice.status === 200 && twice.json.reference !== ok.json.reference);
    const list = await get("/admissions?status=all", headToken);
    check("but the office's list marks it as a possible duplicate", list.status === 200 && /possible duplicate/.test(list.html));

    // One connection, over the hourly limit.
    const flood = address();
    let allowed = 0;
    let last = 0;
    for (let i = 0; i <= ONLINE_PER_ADDRESS_PER_HOUR; i += 1) {
      const r = await post(`/api/apply/${school.slug}`, { ...child(`Flood${i}`), dateOfBirth: `2017-0${(i % 9) + 1}-10` }, { "x-forwarded-for": flood });
      if (r.status === 200) allowed += 1;
      last = r.status;
    }
    check(`one connection gets ${ONLINE_PER_ADDRESS_PER_HOUR} applications an hour and then a 429`, allowed === ONLINE_PER_ADDRESS_PER_HOUR && last === 429, `${allowed} allowed, last ${last}`);
  }

  console.log("\nThe pipeline, as the office");
  {
    const a = await inSchool(() => createApplication(actor, child("Alpha"), "OFFICE"));
    const b = await inSchool(() => createApplication(actor, child("Beta"), "OFFICE"));
    const c = await inSchool(() => createApplication(actor, child("Gamma"), "OFFICE"));
    if ("error" in a || "error" in b || "error" in c) throw new Error("fixture applications were refused");
    check("the office records applications, each with its own reference", new Set([a.reference, b.reference, c.reference]).size === 3);

    const offerA = await inSchool(() => moveApplication(actor, a.id, "OFFERED", { offerExpiresOn: new Date(Date.now() + 7 * 86_400_000) }));
    check("an offer is made while a place is left", "ok" in offerA, JSON.stringify(offerA));
    const seats1 = await inSchool(() => loadSeats(app, school.id, levelId, year.id));
    check("and the place is counted at once: 1 of 1 taken", seats1.limited && seats1.capacity === 1 && seats1.held === 1 && seats1.left === 0, JSON.stringify(seats1));
    const offerB = await inSchool(() => moveApplication(actor, b.id, "OFFERED"));
    check("the last place cannot be promised twice", "error" in offerB && /no place left/.test(offerB.error) && /waiting list/.test(offerB.error), JSON.stringify(offerB));
    check("and the refusal changed nothing", (await owner.application.findUniqueOrThrow({ where: { id: b.id } })).status === "APPLIED");
    const waitB = await inSchool(() => moveApplication(actor, b.id, "WAITLISTED"));
    check("the child who missed out goes on the waiting list", "ok" in waitB);
    const skip = await inSchool(() => moveApplication(actor, c.id, "ACCEPTED"));
    check("a step the pipeline does not allow is refused (applied cannot jump to accepted)", "error" in skip && /cannot be moved/.test(skip.error), JSON.stringify(skip));
    const byHand = await inSchool(() => moveApplication(actor, c.id, "ADMITTED"));
    check("and so is a hand-made move to ADMITTED", "error" in byHand);

    const test = await inSchool(() => recordTest(actor, c.id, { testedOn: new Date("2026-11-07T00:00:00Z"), testScore: 72.5, testNotes: "Reads well" }));
    const cRow = await owner.application.findUniqueOrThrow({ where: { id: c.id } });
    check("a test result is saved, and starts a fresh application", "ok" in test && Number(cRow.testScore) === 72.5 && cRow.status === "TESTING", JSON.stringify(cRow));

    // Raise the class to two places: one is held by A, so exactly ONE of two simultaneous offers can win.
    await owner.classGroup.update({ where: { id: klass.id }, data: { capacity: 2 } });
    const race = await Promise.all([
      inSchool(() => moveApplication(actor, b.id, "OFFERED")),
      inSchool(() => moveApplication(actor, c.id, "OFFERED")),
    ]);
    const raceSeats = await inSchool(() => loadSeats(app, school.id, levelId, year.id));
    check("with one place left, two simultaneous offers promise exactly one", race.filter((r) => "ok" in r).length === 1 && raceSeats.limited && raceSeats.held === 2 && raceSeats.left === 0, JSON.stringify([race, raceSeats]));

    const accepted = await inSchool(() => moveApplication(actor, a.id, "ACCEPTED"));
    check("the family accepts: no second place is asked for the one already held", "ok" in accepted, JSON.stringify(accepted));

    const wrongStep = await inSchool(() => admitApplication(actor, b.id, klass.id));
    check("only an accepted application can be admitted", "error" in wrongStep && /accepted/.test(wrongStep.error), JSON.stringify(wrongStep));
    if (otherLevel) {
      const otherClass = await owner.classGroup.findFirstOrThrow({ where: { levelId: otherLevel.id }, select: { id: true } });
      const wrongClass = await inSchool(() => admitApplication(actor, a.id, otherClass.id));
      check("a class in another level is refused", "error" in wrongClass && /not in the level/.test(wrongClass.error), JSON.stringify(wrongClass));
    }
    if (foreignLevel) {
      const foreignClass = await owner.classGroup.findFirst({ where: { schoolId: { not: school.id } }, select: { id: true } });
      if (foreignClass) {
        const foreign = await inSchool(() => admitApplication(actor, a.id, foreignClass.id));
        check("another school's class is refused", "error" in foreign && /not found/.test(foreign.error), JSON.stringify(foreign));
      }
    }
    const noClass = await inSchool(() => admitApplication(actor, a.id, ""));
    check("a child starting this year needs a class", "error" in noClass && /Pick the class/.test(noClass.error), JSON.stringify(noClass));
    check("and none of those refusals made a pupil", (await owner.student.count({ where: { schoolId: school.id, lastName: "Admtest", firstName: "Alpha" } })) === 0);

    const admitted = await inSchool(() => admitApplication(actor, a.id, klass.id));
    check("an accepted child is admitted into the class", "ok" in admitted, JSON.stringify(admitted));
    const studentId = "studentId" in admitted ? admitted.studentId : "";
    const student = await owner.student.findUnique({
      where: { id: studentId },
      include: { enrollments: true, guardians: { include: { guardian: true } } },
    });
    check("a pupil exists with an admission number, ACTIVE, in the class", student?.status === "ACTIVE" && /^[A-Z]+\/\d+$/.test(student.admissionNo) && student.currentClassGroupId === klass.id, JSON.stringify(student));
    check("enrolled for the year in that class", student?.enrollments.length === 1 && student.enrollments[0].academicYearId === year.id && student.enrollments[0].classGroupId === klass.id);
    check("with the parent linked as the primary guardian, on the phone given", student?.guardians.length === 1 && student.guardians[0].isPrimary && student.guardians[0].guardian.phone === phone);
    check("and the health note carried over to the pupil", student?.medicalNotes === "Allergic to groundnuts");
    const aRow = await owner.application.findUniqueOrThrow({ where: { id: a.id } });
    check("the application is ADMITTED and points at the pupil", aRow.status === "ADMITTED" && aRow.studentId === studentId);
    const admitAudit = await owner.auditLog.findFirst({ where: { schoolId: school.id, action: "student.admit", entityId: studentId } });
    check("the admission is audited, naming the application it came from", (admitAudit?.after as Json | null)?.applicationId === a.id);
    const seats2 = await inSchool(() => loadSeats(app, school.id, levelId, year.id));
    check("the place moves from 'offered' to 'enrolled' and is not counted twice (the other held place is the race winner's)", seats2.limited && seats2.enrolled === 1 && seats2.held === 1 && seats2.left === 0, JSON.stringify(seats2));

    const again = await inSchool(() => admitApplication(actor, a.id, klass.id));
    check("admitting the same child again is refused", "error" in again && /already been admitted/.test(again.error));
    const editAdmitted = await inSchool(() => updateApplication(actor, a.id, child("Alpha")));
    const deleteAdmitted = await inSchool(() => deleteApplication(actor, a.id));
    const testAdmitted = await inSchool(() => recordTest(actor, a.id, { testedOn: null, testScore: 50, testNotes: null }));
    check("an admitted application can no longer be edited, tested or deleted", "error" in editAdmitted && "error" in deleteAdmitted && "error" in testAdmitted);

    // A full class refuses; two admits at once make one pupil.
    await owner.classGroup.update({ where: { id: klass.id }, data: { capacity: 9 } });
    const d = await inSchool(() => createApplication(actor, child("Delta"), "OFFICE"));
    if ("error" in d) throw new Error("fixture");
    await inSchool(() => moveApplication(actor, d.id, "OFFERED"));
    await inSchool(() => moveApplication(actor, d.id, "ACCEPTED"));
    const twin = await Promise.all([inSchool(() => admitApplication(actor, d.id, klass.id)), inSchool(() => admitApplication(actor, d.id, klass.id))]);
    const winners = twin.filter((r) => "ok" in r).length;
    const pupils = await owner.student.count({ where: { schoolId: school.id, firstName: "Delta", lastName: "Admtest" } });
    check("two simultaneous admits of one child make exactly one pupil", winners === 1 && pupils === 1, `${winners} won, ${pupils} pupils`);

    const e = await inSchool(() => createApplication(actor, child("Epsilon"), "OFFICE"));
    if ("error" in e) throw new Error("fixture");
    await inSchool(() => moveApplication(actor, e.id, "OFFERED"));
    await inSchool(() => moveApplication(actor, e.id, "ACCEPTED"));
    await owner.classGroup.update({ where: { id: klass.id }, data: { capacity: 2 } });
    const full = await inSchool(() => admitApplication(actor, e.id, klass.id));
    check("a class that is full refuses the admission, naming its size", "error" in full && /is full \(2 places\)/.test(full.error), JSON.stringify(full));
    check("and the child stays accepted, to be placed elsewhere", (await owner.application.findUniqueOrThrow({ where: { id: e.id } })).status === "ACCEPTED");

    const deleted = await inSchool(() => deleteApplication(actor, b.id));
    check("an application that went nowhere can be deleted, and is audited", "ok" in deleted && (await owner.application.count({ where: { id: b.id } })) === 0 && (await owner.auditLog.count({ where: { schoolId: school.id, action: "application.delete", entityId: b.id } })) === 1);

    const foreignApp = foreignLevel ? await inSchool(() => createApplication(actor, child("Foreign", { levelId: foreignLevel.id }), "OFFICE")) : null;
    if (foreignApp) check("an application for another school's class is refused", "error" in foreignApp && /not found/.test(foreignApp.error), JSON.stringify(foreignApp));
    const pastYear = await owner.academicYear.findFirst({ where: { schoolId: school.id, endDate: { lt: new Date() } }, select: { id: true } });
    if (pastYear) {
      const past = await inSchool(() => createApplication(actor, child("Past", { academicYearId: pastYear.id }), "OFFICE"));
      check("and so is a year that has already ended", "error" in past && /ended/.test(past.error));
    }

    // A later year: admitted without a class, and still counted against that year's places.
    const f = await inSchool(() => createApplication(actor, child("Future", { academicYearId: futureYear.id }), "OFFICE"));
    if ("error" in f) throw new Error("fixture");
    await inSchool(() => moveApplication(actor, f.id, "OFFERED"));
    await inSchool(() => moveApplication(actor, f.id, "ACCEPTED"));
    const early = await inSchool(() => admitApplication(actor, f.id, ""));
    const fStudent = "studentId" in early ? await owner.student.findUnique({ where: { id: early.studentId }, include: { enrollments: true } }) : null;
    check("a child starting in a later year is admitted with no class and no enrolment", "ok" in early && fStudent?.status === "ADMITTED" && fStudent.enrollments.length === 0 && fStudent.currentClassGroupId === null, JSON.stringify(early));
    const seatsLater = await inSchool(() => loadSeats(app, school.id, levelId, futureYear.id));
    check("and still takes one of that year's places until the office places them", seatsLater.limited && seatsLater.held === 1 && seatsLater.enrolled === 0, JSON.stringify(seatsLater));

    // A lapsed offer is derived from its date.
    const g = await inSchool(() => createApplication(actor, child("Gamma2", { academicYearId: futureYear.id }), "OFFICE"));
    if ("error" in g) throw new Error("fixture");
    await inSchool(() => moveApplication(actor, g.id, "OFFERED"));
    await owner.application.update({ where: { id: g.id }, data: { offerExpiresOn: new Date(Date.now() - 3 * 86_400_000) } });
    const lapsedList = await get(`/admissions?status=OFFERED&year=${futureYear.id}`, headToken);
    check("an offer past its date reads as lapsed on the list, though nothing stored changed", /Offer lapsed/.test(lapsedList.html) && (await owner.application.findUniqueOrThrow({ where: { id: g.id } })).status === "OFFERED");

    console.log("\nThe screens");
    {
      const home = await get("/admissions?status=all", headToken);
      check("the head sees the queue and the places", home.status === 200 && home.html.includes(a.reference) && /Places for/.test(home.html) && home.html.includes("ZZ Admissions test"), `HTTP ${home.status}`);
      check("and the online form's panel with its link", home.html.includes(`/apply/${school.slug}`));
      const detail = await get(`/admissions/${c.id}`, headToken);
      check("a child's page shows the test result and the steps open to it", detail.status === 200 && /72\.5|72,5/.test(detail.html) && /Where it stands/.test(detail.html), `HTTP ${detail.status}`);
      const done = await get(`/admissions/${a.id}`, headToken);
      check("an admitted child's page links to the pupil and offers no steps", done.status === 200 && /Now a pupil/.test(done.html) && !/Offer a place/.test(done.html) && !/Delete this application/.test(done.html));
      const acceptedPage = await get(`/admissions/${e.id}`, headToken);
      check("an accepted child's page has the admit form, with the full class disabled", acceptedPage.status === 200 && /Admit as a pupil/.test(acceptedPage.html) && /\(full\)/.test(acceptedPage.html));
      const edit = await get(`/admissions/${c.id}/edit`, headToken);
      check("the edit page opens", edit.status === 200 && /Save changes/.test(edit.html));
      const redirected = await get(`/admissions/${a.id}/edit`, headToken);
      check("and an admitted child's edit page sends you back to the child", redirected.status >= 300 && redirected.status < 400);
      const missing = await get(`/admissions/not-an-application`, headToken);
      check("an id that is not an application is a 404", missing.status === 404);
      const newForm = await get("/admissions/new", headToken);
      check("the new-application form opens", newForm.status === 200 && /Record application/.test(newForm.html));

      const signedOut = await get("/admissions");
      check("a signed-out visitor is sent to sign in", signedOut.status >= 300 && signedOut.status < 400 && (signedOut.html.length < 500 || !/Places for/.test(signedOut.html)));
      const teacher = await withBypass(() => owner.membership.findFirst({ where: { schoolId: school.id, role: "TEACHER", staffId: { not: null }, user: { mustChangePassword: false } }, select: { userId: true } }));
      if (teacher) {
        const teacherToken = await sessionFor(teacher.userId);
        const refused = await get("/admissions", teacherToken);
        const refusedDetail = await get(`/admissions/${c.id}`, teacherToken);
        check("a teacher is refused the list and a child's page", refused.status >= 300 && refused.status < 400 && refusedDetail.status >= 300 && refusedDetail.status < 400, `HTTP ${refused.status}/${refusedDetail.status}`);
      } else {
        console.log("  SKIPPED — no teacher login in the demo school");
      }
    }
  }
} finally {
  // Everything this run made, and nothing it did not.
  const students = await owner.student.findMany({ where: { schoolId: school.id, lastName: "Admtest" }, select: { id: true } });
  const studentIds = students.map((s) => s.id);
  await owner.application.deleteMany({ where: { schoolId: school.id, OR: [{ levelId: level.id }, { lastName: "Admtest" }] } });
  await owner.student.deleteMany({ where: { id: { in: studentIds } } });
  await owner.guardian.deleteMany({ where: { schoolId: school.id, phone } });
  await owner.auditLog.deleteMany({
    where: {
      schoolId: school.id,
      createdAt: { gte: startedAt },
      OR: [{ action: { startsWith: "application." } }, { action: "student.admit", entityId: { in: studentIds } }],
    },
  });
  await owner.classGroup.deleteMany({ where: { levelId: level.id } });
  await owner.level.deleteMany({ where: { id: level.id } });
  await owner.academicYear.deleteMany({ where: { id: futureYear.id } });
  await owner.loginAttempt.deleteMany({ where: { identifier: { in: addresses.map((a) => `apply:${a}`) } } });
  await owner.schoolSettings.update({ where: { schoolId: school.id }, data: settingsBefore });
  await withBypass(() => owner.session.deleteMany({ where: { tokenHash: { in: sessions } } }));
  await owner.$disconnect();
  await app.$disconnect();
}

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
