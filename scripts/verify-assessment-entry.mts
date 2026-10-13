/**
 * Recording an assessment, through the running app: who may, and what a mark may not exceed.
 *
 * verify:score-limits proves the rule and the shape of the code. This proves they are applied: real
 * sessions for a head, an IT admin and a teacher, the real forms posted without JavaScript, and the
 * rows read back from the database afterwards.
 *
 * Every refusal has a positive control beside it, because a refusal that cannot be told from a
 * request that never arrived proves nothing: a save is refused for a mark above the total AND the
 * same save without that mark is accepted, and a forged status change is refused for the IT admin
 * AND the identical replay changes the row for the head.
 *
 * Fixtures: three logins, one assessment (created by the IT admin through the real form, which is
 * itself a check), all removed at the end together with the audit rows they caused. The class is
 * one with no results at all, because a published class is locked before the total is ever looked
 * at, and a test that passed on THAT refusal would prove nothing about the maximum.
 *
 *   npm run dev
 *   npm run verify:assessment-entry
 */
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { SESSION_COOKIE_NAME } from "@/lib/session-cookie";
import { demoSchool, withOwner } from "./fixture.mjs";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const TOTAL = 10;

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) passed += 1;
  else failed += 1;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const unescape = (value: string) =>
  value.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

type Reply = { status: number; location: string; html: string };

/** A GET that retries a dropped connection, which on this link is usually all a 500 is. */
async function get(path: string, token: string): Promise<Reply> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const r = await fetch(BASE + path, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
        redirect: "manual",
        signal: AbortSignal.timeout(120_000),
      });
      const html = await r.text();
      if (r.status === 500) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      return { status: r.status, location: r.headers.get("location") ?? "", html };
    } catch {
      await sleep(500 * (attempt + 1));
    }
  }
  throw new Error(`GET ${path} never answered`);
}

/** Every `<form>` on a page, as its inner HTML. */
const forms = (html: string) => [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].map((m) => m[1]);
const formWith = (html: string, marker: string) => forms(html).find((inner) => inner.includes(marker));

/** What a browser would submit with JavaScript off: hidden and text inputs, not an unticked box. */
function fieldsOf(inner: string): [string, string][] {
  const out: [string, string][] = [];
  for (const tag of inner.match(/<input\b[^>]*>/g) ?? []) {
    const type = tag.match(/type="([^"]*)"/)?.[1] ?? "text";
    if (type === "checkbox" || type === "submit" || /\sdisabled(=|\s|>)/.test(tag)) continue;
    const name = tag.match(/name="([^"]*)"/)?.[1];
    if (!name) continue;
    out.push([unescape(name), unescape(tag.match(/value="([^"]*)"/)?.[1] ?? "")]);
  }
  return out;
}

/** POST a form. Never retried: a write that was retried may have been applied twice. */
async function post(path: string, token: string, fields: [string, string][], overrides: Record<string, string> = {}): Promise<Reply> {
  const body = new FormData();
  const done = new Set<string>();
  for (const [name, value] of fields) {
    body.append(name, name in overrides ? overrides[name] : value);
    done.add(name);
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (!done.has(name)) body.append(name, value);
  }
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(180_000),
  });
  const html = await r.text();
  return { status: r.status, location: r.headers.get("location") ?? "", html };
}

const sha = (token: string) => createHash("sha256").update(token).digest("hex");

async function main() {
  if (!(await fetch(BASE, { redirect: "manual" }).catch(() => null))) {
    console.log(`Nothing answers at ${BASE} — start the app first (npm run dev).`);
    process.exitCode = 1;
    return;
  }

  const school = await demoSchool();
  const stamp = Date.now();
  const title = `Probe test ${stamp}`;

  const term = await withBypass(() =>
    prisma.term.findFirst({ where: { schoolId: school.id, isCurrent: true }, select: { id: true, academicYearId: true } }),
  );
  if (!term) {
    check("the demo school has a current term", false);
    process.exitCode = 1;
    return;
  }

  // A class with pupils and no results of any kind, so nothing is locked and no roll-up is triggered.
  const classes = await withBypass(() => prisma.classGroup.findMany({ where: { schoolId: school.id }, select: { id: true } }));
  let classGroupId = "";
  let pupils: { id: string; name: string }[] = [];
  for (const c of classes) {
    const results = await withBypass(() => prisma.termResult.count({ where: { termId: term.id, classGroupId: c.id } }));
    if (results > 0) continue;
    const roll = await withBypass(() =>
      prisma.enrollment.findMany({
        where: { schoolId: school.id, academicYearId: term.academicYearId, classGroupId: c.id, status: { not: "WITHDRAWN" } },
        select: { student: { select: { id: true, firstName: true, lastName: true } } },
      }),
    );
    if (roll.length >= 3) {
      classGroupId = c.id;
      pupils = roll.map((r) => ({ id: r.student.id, name: `${r.student.lastName} ${r.student.firstName}` }));
      break;
    }
  }
  const subject = await withBypass(() => prisma.subject.findFirst({ where: { schoolId: school.id }, select: { id: true } }));
  if (!classGroupId || !subject) {
    check("the demo school has a class with three pupils and no results", false);
    process.exitCode = 1;
    return;
  }
  const [p1, p2, p3] = pupils;

  // --- three real logins -------------------------------------------------------------------------
  const tokens: Record<"HEAD" | "IT_ADMIN" | "TEACHER", string> = { HEAD: "", IT_ADMIN: "", TEACHER: "" };
  const userIds: string[] = [];
  for (const role of ["HEAD", "IT_ADMIN", "TEACHER"] as const) {
    const user = await withBypass(() =>
      prisma.user.create({
        data: { name: `Probe ${role}`, email: `vae-${role.toLowerCase()}-${stamp}@example.test`, passwordHash: "x", schoolId: school.id },
        select: { id: true },
      }),
    );
    userIds.push(user.id);
    await withBypass(() => prisma.membership.create({ data: { schoolId: school.id, userId: user.id, role, status: "ACTIVE" } }));
    const token = randomBytes(32).toString("hex");
    await withBypass(() =>
      prisma.session.create({
        data: { userId: user.id, tokenHash: sha(token), activeSchoolId: school.id, expiresAt: new Date(Date.now() + 3 * 3600_000) },
      }),
    );
    tokens[role] = token;
  }

  let assessmentId = "";
  const scores = () => withBypass(() => prisma.score.findMany({ where: { assessmentId }, select: { studentId: true, rawScore: true, isAbsent: true } }));
  const scoreOf = async (studentId: string) => {
    const row = (await scores()).find((s) => s.studentId === studentId);
    return row?.rawScore === null || row === undefined ? null : Number(row.rawScore);
  };
  const assessment = () => withBypass(() => prisma.assessment.findUnique({ where: { id: assessmentId } }));

  try {
    // --- 1. the IT admin records an assessment ----------------------------------------------------
    console.log("\nAn IT admin creates an assessment, through the real form");
    const page = await get("/assessments?new=1", tokens.IT_ADMIN);
    check("the Assessments page opens for an IT admin", page.status === 200, `HTTP ${page.status}`);
    check("with the New assessment form on it (not 'View only')", /name="maxScore"/.test(page.html) && !/View only/.test(page.html));
    const createInner = formWith(page.html, 'name="maxScore"');
    if (!createInner) {
      check("the create form posts without JavaScript", false);
      return;
    }
    const createFields = fieldsOf(createInner);
    const create = await post("/assessments?new=1", tokens.IT_ADMIN, createFields, {
      termId: term.id,
      classGroupId,
      subjectId: subject.id,
      type: "CLASS_TEST",
      title,
      maxScore: String(TOTAL),
      weight: "0",
      dueDate: "",
    });
    assessmentId = create.location.match(/\/assessments\/([^/?#]+)$/)?.[1] ?? "";
    check("it is accepted and sent to the new assessment's page", create.status === 303 && Boolean(assessmentId), `HTTP ${create.status} ${create.location}`);
    const row = assessmentId ? await assessment() : null;
    check("the row exists, in this school, marked out of 10", row?.schoolId === school.id && Number(row?.maxScore) === TOTAL, String(row?.maxScore));
    check("recorded by a login with no staff record, which is allowed", row !== null && row.createdByStaffId === null);
    if (!assessmentId || !row) return;

    const again = await post("/assessments?new=1", tokens.IT_ADMIN, createFields, {
      termId: term.id, classGroupId, subjectId: subject.id, type: "CLASS_TEST", title, maxScore: "20", weight: "0", dueDate: "",
    });
    check(
      "creating the same title again is refused plainly, not with a server error",
      again.status < 500 && /already/i.test(again.html),
      `HTTP ${again.status}`,
    );
    check("and does not change the total of the one that exists", Number((await assessment())?.maxScore) === TOTAL);

    // --- 2. the page an IT admin gets -------------------------------------------------------------
    console.log("\nThe score page, as an IT admin");
    const path = `/assessments/${assessmentId}`;
    const itPage = await get(path, tokens.IT_ADMIN);
    check("it opens", itPage.status === 200, `HTTP ${itPage.status}`);
    check("marked out of 10, said on the page", /Score \/ 10/.test(itPage.html.replace(/<!-- -->/g, "")));
    const gridInner = formWith(itPage.html, `name="score:${p1.id}"`);
    check("with a grid it can type into", Boolean(gridInner) && !/name="score:[^"]*"[^>]*disabled/.test(gridInner ?? ""));
    check("with a Submit for review button, and no Approve, Unlock or Delete, which are a head's", /Submit for review/.test(itPage.html) && !/>Approve<|Unlock for edits|>Delete</.test(itPage.html));
    check("with a line saying what it can and cannot do", /enter and correct marks here and submit/i.test(itPage.html));
    if (!gridInner) return;
    const gridFields = fieldsOf(gridInner);
    const enter = (as: string, marks: Record<string, string>, absent: string[] = []) =>
      post(path, as, gridFields, {
        ...Object.fromEntries(pupils.map((p) => [`score:${p.id}`, marks[p.id] ?? ""])),
        ...Object.fromEntries(absent.map((id) => [`absent:${id}`, "on"])),
      });

    // --- 3. nothing above the total ---------------------------------------------------------------
    console.log("\nA mark above the total is refused, and nothing is saved");
    const over = await enter(tokens.IT_ADMIN, { [p1.id]: "15", [p2.id]: "7" });
    check("a 15 in a test out of 10 is refused", /Nothing was saved/.test(over.html) && /above the 10/.test(over.html));
    check("naming the pupil", over.html.includes(p1.name), p1.name);
    check("and the pupil whose mark was fine is NOT saved either (all or nothing)", (await scores()).length === 0, `${(await scores()).length} rows`);
    const justOver = await enter(tokens.IT_ADMIN, { [p1.id]: "10.01" });
    check("10.01 is refused: the edge is the total itself", /above the 10/.test(justOver.html) && (await scores()).length === 0);
    const two = await enter(tokens.IT_ADMIN, { [p1.id]: "11", [p2.id]: "12", [p3.id]: "9" });
    check("two marks over are BOTH named, not just the first", two.html.includes(p1.name) && two.html.includes(p2.name));

    console.log("\nThe same save without the bad mark is accepted (the positive control)");
    const good = await enter(tokens.IT_ADMIN, { [p1.id]: "10", [p2.id]: "7.5" });
    check("10 out of 10 and 7.5 are saved", /Saved 2 scores/.test(good.html), good.html.match(/Saved \d+ scores|Nothing was saved[^<]*/)?.[0] ?? "");
    check("as exactly those numbers", (await scoreOf(p1.id)) === 10 && (await scoreOf(p2.id)) === 7.5);

    console.log("\nOther things that are not marks");
    for (const bad of ["-1", "abc", "1e1", "0x5", "+5", "7,5", "Infinity"]) {
      const reply = await enter(tokens.IT_ADMIN, { [p1.id]: bad });
      check(`"${bad}" is refused`, /Nothing was saved/.test(reply.html));
    }
    check("and the saved marks are exactly as they were", (await scoreOf(p1.id)) === 10 && (await scoreOf(p2.id)) === 7.5);
    const mixed = await enter(tokens.IT_ADMIN, { [p1.id]: "3", [p2.id]: "99" });
    check("a good mark beside a bad one is not saved on its own", /Nothing was saved/.test(mixed.html) && (await scoreOf(p1.id)) === 10);

    console.log("\nAbsent still works, and an absent pupil's box is not judged");
    const abs = await enter(tokens.IT_ADMIN, { [p1.id]: "10", [p2.id]: "7.5", [p3.id]: "99" }, [p3.id]);
    const absentRow = (await scores()).find((s) => s.studentId === p3.id);
    check("a pupil marked absent is saved as absent whatever is in their box", /Saved 3 scores/.test(abs.html) && absentRow?.isAbsent === true && absentRow.rawScore === null, abs.html.match(/Saved \d+ scores|Nothing was saved[^<]*/)?.[0] ?? "");
    const cleared = await enter(tokens.IT_ADMIN, { [p1.id]: "10", [p2.id]: "", [p3.id]: "" });
    check("a blank is 'not marked yet': it removes the row, it is not a zero", (await scoreOf(p2.id)) === null && !(await scores()).some((s) => s.studentId === p2.id), cleared.html.match(/Saved \d+ scores|Nothing was saved[^<]*/)?.[0] ?? "");
    await enter(tokens.IT_ADMIN, { [p1.id]: "10", [p2.id]: "7.5" });

    // --- 4. the head is held to it as well --------------------------------------------------------
    console.log("\nA head is held to the same total");
    const headOver = await enter(tokens.HEAD, { [p1.id]: "15" });
    check("a head's 15 out of 10 is refused too", /Nothing was saved/.test(headOver.html) && /above the 10/.test(headOver.html));
    check("and the row is untouched", (await scoreOf(p1.id)) === 10);

    // --- 5. an IT admin may submit; the head signs off ---------------------------------------------
    console.log("\nAn IT admin may submit, and nothing further, even with a forged request");
    const headPage = await get(path, tokens.HEAD);
    const submitInner = formWith(headPage.html, 'value="SUBMITTED"');
    const deleteInner = forms(headPage.html).find((inner) => /Deleting|Delete/.test(inner) && inner.includes('name="assessmentId"') && !inner.includes('name="status"'));
    check("the head's page offers Submit and Delete forms (so there is something to forge)", Boolean(submitInner) && Boolean(deleteInner));
    const status = async () => String((await assessment())?.status);
    if (submitInner && deleteInner) {
      await post(path, tokens.IT_ADMIN, fieldsOf(deleteInner));
      check("the head's 'Delete' replayed by the IT admin deletes nothing", (await assessment()) !== null && (await scores()).length >= 2);
      await post(path, tokens.IT_ADMIN, fieldsOf(submitInner), { status: "APPROVED" });
      check("an IT admin cannot skip review: OPEN straight to APPROVED is refused", (await status()) === "OPEN", await status());

      const mine = formWith(itPage.html, 'value="SUBMITTED"');
      check("the IT admin's own page has a Submit form", Boolean(mine));
      if (mine) {
        await post(path, tokens.IT_ADMIN, fieldsOf(mine));
        check("and posting it submits the assessment", (await status()) === "SUBMITTED", await status());
      }

      const headSubmitted = await get(path, tokens.HEAD);
      const approveInner = formWith(headSubmitted.html, 'value="APPROVED"');
      const sendBackInner = formWith(headSubmitted.html, 'value="OPEN"');
      check("once submitted, the head's page offers Approve and Send back", Boolean(approveInner) && Boolean(sendBackInner));
      if (approveInner && sendBackInner) {
        await post(path, tokens.IT_ADMIN, fieldsOf(approveInner));
        check("the head's 'Approve' replayed by the IT admin does nothing", (await status()) === "SUBMITTED", await status());
        await post(path, tokens.IT_ADMIN, fieldsOf(sendBackInner));
        check("nor does 'Send back'", (await status()) === "SUBMITTED", await status());
        await post(path, tokens.HEAD, fieldsOf(sendBackInner));
        check("the same 'Send back' replayed by the head DOES reopen it (the control: the forgery is well-formed)", (await status()) === "OPEN", await status());
      }
    }

    // --- 6. a teacher is not an IT admin ----------------------------------------------------------
    console.log("\nA teacher with no assignment cannot record here");
    const teacherPage = await get("/assessments", tokens.TEACHER);
    check("the Assessments page is refused to a teacher", teacherPage.status >= 300 && teacherPage.status < 400, `HTTP ${teacherPage.status} ${teacherPage.location}`);
    await enter(tokens.TEACHER, { [p1.id]: "1", [p2.id]: "2", [p3.id]: "3" });
    check("and a forged grid save from a teacher writes nothing", (await scoreOf(p1.id)) === 10 && (await scoreOf(p2.id)) === 7.5 && (await scoreOf(p3.id)) === null);
    const teacherCreate = await post("/assessments?new=1", tokens.TEACHER, createFields, {
      termId: term.id, classGroupId, subjectId: subject.id, type: "CLASS_TEST", title: `${title} teacher`, maxScore: "10", weight: "0", dueDate: "",
    });
    const forged = await withBypass(() => prisma.assessment.count({ where: { schoolId: school.id, title: `${title} teacher` } }));
    check("nor can a forged 'new assessment' from a teacher", forged === 0 && teacherCreate.status !== 200, `HTTP ${teacherCreate.status}`);

    // --- 7. the mark sheet: the same total, and a total an IT admin cannot move --------------------
    console.log("\nOn the mark sheet: the same total, and an IT admin cannot raise it");
    // The assessment is OPEN again (the head sent it back above).
    const sheetUrl = `/assessments/sheet?term=${term.id}&class=${classGroupId}&subject=${subject.id}`;
    const sheet = await get(sheetUrl, tokens.IT_ADMIN);
    const sheetInner = formWith(sheet.html, `name="score:${assessmentId}:${p1.id}"`);
    check("the sheet shows the assessment as a column", Boolean(sheetInner), `HTTP ${sheet.status}`);
    if (sheetInner) {
      const sheetFields = fieldsOf(sheetInner);
      const sheetOver = await post(sheetUrl, tokens.IT_ADMIN, sheetFields, { [`score:${assessmentId}:${p1.id}`]: "15" });
      check("a 15 out of 10 on the sheet is refused, naming pupil and component", /Nothing was saved/.test(sheetOver.html) && sheetOver.html.includes(p1.name) && sheetOver.html.includes(title), sheetOver.html.match(/Nothing was saved[^<]*/)?.[0]?.slice(0, 120) ?? "");
      check("and the saved mark is untouched", (await scoreOf(p1.id)) === 10);
      const forgedTotal = await post(sheetUrl, tokens.IT_ADMIN, sheetFields, {
        [`max:${assessmentId}`]: "100",
        [`score:${assessmentId}:${p1.id}`]: "80",
      });
      check("an IT admin forging a higher total to fit a mark is refused", /Nothing was saved/.test(forgedTotal.html) && /above the 10/.test(forgedTotal.html), forgedTotal.html.match(/Nothing was saved[^<]*/)?.[0]?.slice(0, 120) ?? "");
      check("the total is still 10", Number((await assessment())?.maxScore) === TOTAL);
      const sheetTeacher = await post(sheetUrl, tokens.TEACHER, sheetFields, { [`score:${assessmentId}:${p1.id}`]: "15" });
      check("a teacher with no assignment is turned away from the sheet before the total is looked at", !/above the 10/.test(sheetTeacher.html));
    }
  } finally {
    await withOwner(async (owner) => {
      if (assessmentId) {
        await owner.auditLog.deleteMany({ where: { entityId: assessmentId } });
      }
      await owner.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
      await owner.assessment.deleteMany({ where: { schoolId: school.id, title: { startsWith: `Probe test ${stamp}` } } });
      await owner.session.deleteMany({ where: { userId: { in: userIds } } });
      await owner.membership.deleteMany({ where: { userId: { in: userIds } } });
      await owner.user.deleteMany({ where: { id: { in: userIds } } });
    });
    const leftover = await withBypass(() => prisma.assessment.count({ where: { schoolId: school.id, title: { startsWith: `Probe test ${stamp}` } } }));
    const users = await withBypass(() => prisma.user.count({ where: { id: { in: userIds } } }));
    check("fixtures removed", leftover === 0 && users === 0, `${leftover} assessments, ${users} users left`);

    // Here, not after the try: an early `return` above (the create form missing, say) must not skip
    // the verdict. It once did, and a run that printed FAIL lines still exited 0, which CI reads as green.
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  }
}

await main();
await prisma.$disconnect();
