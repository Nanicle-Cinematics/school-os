/**
 * The mark grids, in a real browser: what a person sees, and what the page then sends.
 *
 * verify:assessment-entry posts the real forms over HTTP and reads the rows back. It cannot see what
 * happens in the BROWSER once an action returns, and two bugs lived exactly there:
 *
 *   - After a save React resets a form's fields, and a CONTROLLED checkbox is not put back, so a pupil's
 *     "absent" tick vanished from the screen while the state behind it still held it. The next save sent
 *     no absence, and "Saved 3 scores" was followed by two rows in the database.
 *   - The mark sheet DISABLED a pupil's mark box once they were ticked absent. A browser does not submit a
 *     disabled input, and the server only looked for absences among the marks it received, so an absence
 *     typed on the mark sheet was never saved, from the day the sheet was written.
 *
 * Both passed every other check in this repo, because an HTTP client never resets a form and never skips
 * a disabled input. So this drives the real pages: it types, ticks and presses Save, waits for the result,
 * then asks the page what it shows and the database what it holds.
 *
 * The promotions form has the same trap: its class ticks are controlled, and a completed action (a refusal
 * included) reset them while the button went on saying "Roll 11 classes". It is tested through a REFUSAL, forced
 * by pointing the target year at the source year, so nothing is ever promoted: a whole-school promotion moves
 * pupils between classes, and a test must not do that.
 *
 * Fixtures: a login, an open assessment out of 10 for a class with no results at all (so the recompute a
 * mark-sheet save triggers can be removed exactly), all deleted at the end, also on a failed run.
 *
 *   npm run dev   (or a built server on VERIFY_BASE_URL)
 *   npm run verify:grid-browser
 */
import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { sleep, startBrowser } from "./chrome-cdp.mjs";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const SAVE_BUDGET_MS = 300_000;

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) passed += 1;
  else failed += 1;
}

// One short-lived client per use: a client left open starves the server under test when the pool is one.
const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
async function db(fn) {
  const client = new PrismaClient({ datasourceUrl: url });
  try {
    return await fn(client);
  } finally {
    await client.$disconnect();
  }
}

const stamp = Date.now();
const email = `gridbrowser-${stamp}@example.test`;
const title = `Browser probe ${stamp}`;
const fixtures = { userId: "", assessmentId: "", termId: "", classGroupId: "" };
let browser = null;

async function removeFixtures() {
  await db(async (owner) => {
    await owner.auditLog.deleteMany({ where: { OR: [{ entityId: fixtures.assessmentId || "none" }, { actorUserId: fixtures.userId || "none" }] } });
    // The mark-sheet save recomputes the class. The class had no results when it was chosen, so removing every
    // result for the term and class puts it back exactly.
    if (fixtures.termId && fixtures.classGroupId) {
      await owner.subjectResult.deleteMany({ where: { termId: fixtures.termId, classGroupId: fixtures.classGroupId } });
      await owner.termResult.deleteMany({ where: { termId: fixtures.termId, classGroupId: fixtures.classGroupId } });
    }
    await owner.assessment.deleteMany({ where: { title: { startsWith: "Browser probe " }, createdAt: { gte: new Date(stamp - 1000) } } });
    await owner.academicYear.deleteMany({ where: { name: { startsWith: "Browser probe " }, createdAt: { gte: new Date(stamp - 1000) } } });
    await owner.session.deleteMany({ where: { userId: fixtures.userId || "none" } });
    await owner.membership.deleteMany({ where: { userId: fixtures.userId || "none" } });
    await owner.user.deleteMany({ where: { OR: [{ id: fixtures.userId || "none" }, { email: { startsWith: "gridbrowser-" } }] } });
  });
}

async function main() {
  if (!(await fetch(BASE, { redirect: "manual" }).catch(() => null))) {
    console.log(`Nothing answers at ${BASE}: start the app first (npm run dev).`);
    process.exitCode = 1;
    return;
  }

  // --- fixtures ---------------------------------------------------------------------------------------
  // Stale ones first: a crashed run leaves its login behind, and it is all ours (`gridbrowser-`).
  await db(async (owner) => {
    // A crashed run also leaves its assessment, and the results a mark-sheet save recomputed in its class. They
    // would make that class look used, so the next run would pick another and the leftovers would pile up.
    const stale = await owner.assessment.findMany({ where: { title: { startsWith: "Browser probe " } }, select: { id: true, termId: true, classGroupId: true } });
    for (const pair of new Map(stale.map((a) => [`${a.termId}:${a.classGroupId}`, a])).values()) {
      await owner.subjectResult.deleteMany({ where: { termId: pair.termId, classGroupId: pair.classGroupId } });
      await owner.termResult.deleteMany({ where: { termId: pair.termId, classGroupId: pair.classGroupId } });
    }
    await owner.auditLog.deleteMany({ where: { entityId: { in: stale.map((a) => a.id) } } });
    await owner.assessment.deleteMany({ where: { id: { in: stale.map((a) => a.id) } } });
    await owner.academicYear.deleteMany({ where: { name: { startsWith: "Browser probe " } } });
    await owner.session.deleteMany({ where: { user: { email: { startsWith: "gridbrowser-" } } } });
    await owner.membership.deleteMany({ where: { user: { email: { startsWith: "gridbrowser-" } } } });
    await owner.user.deleteMany({ where: { email: { startsWith: "gridbrowser-" } } });
  });

  const token = randomBytes(32).toString("hex");
  const setup = await db(async (owner) => {
    // The same pick as demoSchool() in fixture.mts, which a plain .mjs cannot import.
    const school = await owner.school.findFirst({ where: { slug: { not: { startsWith: "qa-" } } }, orderBy: { createdAt: "asc" } });
    if (!school) throw new Error("No seeded school in this database. Run `npm run db:seed`.");
    const term = await owner.term.findFirstOrThrow({ where: { schoolId: school.id, isCurrent: true }, select: { id: true, academicYearId: true } });
    let classGroupId = "";
    for (const c of await owner.classGroup.findMany({ where: { schoolId: school.id }, select: { id: true } })) {
      const results = await owner.termResult.count({ where: { termId: term.id, classGroupId: c.id } });
      const roll = await owner.enrollment.count({ where: { schoolId: school.id, academicYearId: term.academicYearId, classGroupId: c.id, status: { not: "WITHDRAWN" } } });
      if (results === 0 && roll >= 3) { classGroupId = c.id; break; }
    }
    if (!classGroupId) throw new Error("no class with three pupils and no results");
    const subject = await owner.subject.findFirstOrThrow({ where: { schoolId: school.id }, select: { id: true } });
    const user = await owner.user.create({ data: { name: "Grid Browser IT Admin", email, passwordHash: "x", schoolId: school.id }, select: { id: true } });
    await owner.membership.create({ data: { schoolId: school.id, userId: user.id, role: "IT_ADMIN", status: "ACTIVE" } });
    await owner.session.create({
      data: { userId: user.id, tokenHash: createHash("sha256").update(token).digest("hex"), activeSchoolId: school.id, expiresAt: new Date(Date.now() + 3 * 3600e3) },
    });
    const assessment = await owner.assessment.create({
      data: { schoolId: school.id, termId: term.id, classGroupId, subjectId: subject.id, type: "CLASS_TEST", title, maxScore: 10, weight: 0, status: "OPEN" },
      select: { id: true },
    });
    // A later year to promote INTO, so the whole-school form is offered. Nothing is ever promoted into it.
    const probeYear = await owner.academicYear.create({
      data: { schoolId: school.id, name: `Browser probe ${stamp}`, startDate: new Date("2099-09-01"), endDate: new Date("2100-07-31") },
      select: { id: true },
    });
    return { userId: user.id, assessmentId: assessment.id, termId: term.id, classGroupId, subjectId: subject.id, sourceYearId: term.academicYearId, probeYearId: probeYear.id, schoolId: school.id };
  });
  Object.assign(fixtures, setup);
  const gridPath = `/assessments/${setup.assessmentId}`;
  const sheetPath = `/assessments/sheet?term=${setup.termId}&class=${setup.classGroupId}&subject=${setup.subjectId}`;
  const rows = () => db((owner) => owner.score.findMany({ where: { assessmentId: setup.assessmentId }, select: { studentId: true, rawScore: true, isAbsent: true } }));

  try {
    browser = await startBrowser();
    const { send, ev } = browser;
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Network.enable");
    await send("Network.setCookie", { name: "school_os_session", value: token, domain: new URL(BASE).hostname, path: "/" });
    const open = async (path, selector = 'input[name^="score:"]') => {
      await send("Page.navigate", { url: BASE + path });
      for (let i = 0; i < 240; i += 1) {
        await sleep(500);
        // ⚠️ HYDRATED, not merely present. The server renders every input, so one exists the moment the page
        // arrives; React attaches its handlers later (on a cold dev server, seconds later), and an event
        // dispatched in between is lost. Typing into an un-hydrated page reads as the validation being
        // broken, which it is not. React marks a node it controls with a `__reactProps$…` key.
        if ((await ev(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});return String(document.readyState === "complete" && !!el && Object.keys(el).some((k)=>k.startsWith("__reactProps")))})()`)) === "true") return true;
      }
      return false;
    };
    /** Poll until an expression is "true". */
    const until = async (expr, budget = SAVE_BUDGET_MS) => {
      const end = Date.now() + budget;
      while (Date.now() < end) {
        if ((await ev(`String(${expr})`)) === "true") return true;
        await sleep(750);
      }
      return false;
    };
    // Typing, the way React hears it: through the native setter, then an input event.
    const type = (selector, value) =>
      ev(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
    const click = (selector) => ev(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const read = async (expr) => JSON.parse((await ev(`JSON.stringify(${expr})`)) ?? "null");

    // --- the score grid ----------------------------------------------------------------------------------
    console.log("\nThe score grid");
    check("the page opens with its grid", await open(gridPath));
    const ids = await read(`[...document.querySelectorAll('input[name^="score:"]')].map(i=>i.name.slice(6))`);
    check("with at least three pupils to work with", Array.isArray(ids) && ids.length >= 3, `${ids?.length} pupils`);
    const [a, b, c] = ids;
    const box = (id) => `input[name="score:${id}"]`;
    const tick = (id) => `input[name="absent:${id}"]`;
    const saveBtn = `[...document.querySelectorAll("button")].find(x=>/Save all scores/.test(x.textContent))`;

    await type(box(a), "15");
    await sleep(400);
    check("a mark above the total marks the cell as invalid as you type", (await ev(`document.querySelector(${JSON.stringify(box(a))}).getAttribute("aria-invalid")`)) === "true");
    check("says why, beside it", (await ev(`String(/15 is above the 10/.test(document.body.innerText))`)) === "true");
    check("and Save is disabled", (await ev(`String(${saveBtn}.disabled)`)) === "true");
    await type(box(a), "8");
    await sleep(400);
    check("corrected, the flag clears and Save is enabled again", (await ev(`String(!document.querySelector('input[aria-invalid="true"]') && !${saveBtn}.disabled)`)) === "true");

    await type(box(c), "99");
    await click(tick(c));
    await sleep(400);
    check("an absent pupil's box is not judged, whatever is in it", (await ev(`String(!document.querySelector('input[aria-invalid="true"]') && !${saveBtn}.disabled)`)) === "true");
    check("and is read-only, not disabled (a disabled box is not submitted)", (await ev(`(()=>{const e=document.querySelector(${JSON.stringify(box(c))});return String(e.readOnly && !e.disabled)})()`)) === "true");

    await ev(`${saveBtn}.click()`);
    const saved = await until(`/Saved \\d+ scores/.test(document.body.innerText)`);
    check("Save completes", saved);
    await sleep(1500); // the form reset lands after the result renders
    check("the absent tick is STILL ticked after the save (React resets the form, and a controlled checkbox is not put back)", (await ev(`String(document.querySelector(${JSON.stringify(tick(c))}).checked)`)) === "true");
    let stored = await rows();
    check("and it was stored", stored.some((r) => r.studentId === c && r.isAbsent === true && r.rawScore === null));

    await ev(`${saveBtn}.click()`);
    const savedAgain = await until(`/Saved \\d+ scores/.test(document.body.innerText) && !${saveBtn}.disabled && /Save all scores/.test(${saveBtn}.textContent)`);
    await sleep(1500);
    stored = await rows();
    check("saving AGAIN does not lose the absence (it used to: the tick was gone from the form, so the next save sent none)", savedAgain && stored.some((r) => r.studentId === c && r.isAbsent === true), `${stored.length} rows`);

    // --- the mark sheet ----------------------------------------------------------------------------------
    console.log("\nThe mark sheet");
    check("the page opens with its grid", await open(sheetPath));
    const colTick = (id) => `input[name="absent:${setup.assessmentId}:${id}"]`;
    const colBox = (id) => `input[name="score:${setup.assessmentId}:${id}"]`;
    check("the absence saved above is shown, ticked", (await ev(`String(!!document.querySelector(${JSON.stringify(colTick(c))}) && document.querySelector(${JSON.stringify(colTick(c))}).checked)`)) === "true");
    check("and that pupil's mark box is read-only, NOT disabled", (await ev(`(()=>{const e=document.querySelector(${JSON.stringify(colBox(c))});return String(e.readOnly && !e.disabled)})()`)) === "true");
    await click(colTick(b));
    await sleep(500);
    check("ticking another pupil absent ticks it", (await ev(`String(document.querySelector(${JSON.stringify(colTick(b))}).checked)`)) === "true");
    const sheetSave = `[...document.querySelectorAll("button")].find(x=>/Save the sheet/.test(x.textContent))`;
    await ev(`${sheetSave}.click()`);
    check("Save completes", await until(`/Saved \\d+ marks?/.test(document.body.innerText)`));
    await sleep(1500);
    check("both ticks are STILL ticked after the save", (await ev(`String(document.querySelector(${JSON.stringify(colTick(b))}).checked && document.querySelector(${JSON.stringify(colTick(c))}).checked)`)) === "true");
    stored = await rows();
    check("and both absences are stored (a disabled box sent none, and the sheet saved nothing for them)", stored.filter((r) => r.isAbsent).map((r) => r.studentId).sort().join() === [b, c].sort().join(), stored.map((r) => `${r.rawScore === null ? "-" : Number(r.rawScore)}${r.isAbsent ? "A" : ""}`).join(" "));
    check("beside the mark that was already there", stored.some((r) => r.studentId === a && Number(r.rawScore) === 8));

    // --- the promotions form -----------------------------------------------------------------------------
    console.log("\nThe promotions form");
    check("the whole-school form opens", await open(`/promotions?from=${setup.sourceYearId}&to=${setup.probeYearId}`, 'input[type="checkbox"][name="class"]'));
    const states = () => read(`[...document.querySelectorAll('input[type="checkbox"][name="class"]')].map(b=>({v:b.value,c:b.checked,d:b.disabled}))`);
    const before0 = await states();
    const enabled = before0.filter((b) => !b.d);
    check("with at least two classes that can be ticked", enabled.length >= 2, `${enabled.length} classes`);
    // Untick one: the state now differs from the default, which is what a reset would lose.
    await ev(`document.querySelector('input[type="checkbox"][name="class"][value="${enabled[0].v}"]').click()`);
    await sleep(500);
    const before = await states();
    check("unticking a class unticks it, and the rest stay ticked", before.find((b) => b.v === enabled[0].v)?.c === false && before.filter((b) => !b.d && b.v !== enabled[0].v).every((b) => b.c));
    // Force a REFUSAL: promote the source year into itself. The action refuses before it reads or writes anything.
    await ev(`document.querySelector('input[name="targetYearId"]').value = document.querySelector('input[name="sourceYearId"]').value`);
    await ev(`[...document.querySelectorAll("button")].find((x)=>/^Roll /.test(x.textContent.trim())).click()`);
    check("the action refuses, and says why", await until(`/cannot be promoted into the year it is already in/.test(document.body.innerText)`, 120_000));
    await sleep(1500); // the form reset lands after the result renders
    const after = await states();
    check("every tick is where it was before the action (React resets the form; a controlled checkbox is not put back)", JSON.stringify(after) === JSON.stringify(before), `${after.filter((b) => b.c).length} ticked of ${after.length}`);
    const buttonSays = await ev(`(()=>{const b=[...document.querySelectorAll("button")].find((x)=>/^Roll /.test(x.textContent.trim()));return b?b.textContent.trim():""})()`);
    check("and the button's count agrees with the boxes on screen", new RegExp(`^Roll ${after.filter((b) => b.c).length} class`).test(buttonSays ?? ""), buttonSays ?? "");
    const placed = await db((owner) => owner.enrollment.count({ where: { academicYearId: setup.probeYearId } }));
    check("and nothing was promoted: the target year has no enrolments", placed === 0, `${placed} enrolments`);
  } finally {
    if (browser) browser.close();
    await removeFixtures();
    const left = await db((owner) => owner.user.count({ where: { email: { startsWith: "gridbrowser-" } } }));
    check("fixtures removed", left === 0, `${left} left`);
    // Here, not after the try: a throw above must not skip the verdict.
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  }
}

await main();
