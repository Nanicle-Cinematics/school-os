/**
 * Taking a register with the server gone, in a real browser.
 *
 * `verify:offline-register` proves the rules and `verify:offline-sync` proves the route. Neither can see the
 * parts that only exist in a browser: that the service worker really answers /attendance with the offline
 * page when the network fails, that what a teacher taps survives a closed page, that the phone's copy goes
 * when they sign out or somebody else signs in, and that a register taken with no signal reaches the school
 * when the signal returns. An HTTP client has no service worker, no IndexedDB and no page to reload.
 *
 * It starts the BUILT app itself (the worker registers in production only) on its own port, and takes the
 * network away by stopping that server, which is the one way to take it from the service worker as well as
 * the page: CDP's offline switch applies to the page, and the worker's own fetches would go on succeeding.
 *
 *   npm run build && npm run verify:offline-browser
 *
 * Fixtures: two logins (OWNER, so every class is theirs), Basic 5 on two days of the first term. The rows the
 * run writes, and both logins, are removed at the end, also on a failed run.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { sleep, startBrowser } from "./chrome-cdp.mjs";

const PORT = Number(process.env.OFFLINE_GUARD_PORT ?? 3101);
const BASE = `http://localhost:${PORT}`;
const COOKIE = "school_os_session";

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
  if (ok) passed += 1;
  else failed += 1;
}

const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
async function db(fn) {
  // A database that is briefly unreachable (the development link drops connections) is tried a few times;
  // anything else is a real failure and is not retried.
  for (let attempt = 1; ; attempt++) {
    const client = new PrismaClient({ datasourceUrl: url });
    try {
      return await fn(client);
    } catch (error) {
      if (attempt >= 4 || error?.name !== "PrismaClientInitializationError") throw error;
      await sleep(5000 * attempt);
    } finally {
      await client.$disconnect();
    }
  }
}

// ── the server, which the guard starts and stops ────────────────────────────────────────────────────────
let server = null;
async function startServer() {
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
    env: process.env,
  });
  let log = "";
  server.stderr.on("data", (chunk) => { log += chunk; });
  for (let i = 0; i < 90; i++) {
    const ok = await fetch(`${BASE}/login`, { redirect: "manual" }).then((r) => r.status === 200, () => false);
    if (ok) return;
    await sleep(1000);
  }
  throw new Error(`the app never answered on ${BASE}\n${log.slice(-800)}`);
}
async function stopServer() {
  if (!server) return;
  try { process.kill(-server.pid, "SIGKILL"); } catch { try { server.kill("SIGKILL"); } catch {} }
  server = null;
  for (let i = 0; i < 20; i++) {
    if (!(await fetch(`${BASE}/login`, { redirect: "manual" }).then(() => true, () => false))) return;
    await sleep(250);
  }
  throw new Error("the server did not stop");
}

// ── helpers that run in the page ─────────────────────────────────────────────────────────────────────────
// ⚠️ indexedDB.open() on a database that does not exist CREATES it, empty and at version 1, and the app's own
// open (also version 1) would then never run its upgrade and have no stores. Look before opening.
const IDB = `(async () => {
  const dbs = (await indexedDB.databases?.()) ?? [];
  if (!dbs.some((d) => d.name === "school-os-offline")) return { rolls: [], registers: [], meta: [] };
  const db = await new Promise((res, rej) => { const r = indexedDB.open("school-os-offline"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const all = (store) => new Promise((res) => {
    if (!db.objectStoreNames.contains(store)) return res([]);
    const g = db.transaction(store).objectStore(store).getAll();
    g.onsuccess = () => res(g.result);
    g.onerror = () => res([]);
  });
  const out = { rolls: await all("rolls"), registers: await all("registers"), meta: await all("meta") };
  db.close();
  return out;
})()`;

let browser = null;
const ev = (expression) => browser.ev(expression);
async function waitFor(label, expression, budgetMs = 60_000) {
  const until = Date.now() + budgetMs;
  while (Date.now() < until) {
    if (await ev(expression)) return true;
    await sleep(500);
  }
  console.log(`  (gave up waiting for ${label})`);
  return false;
}
async function go(path) {
  await browser.send("Page.navigate", { url: BASE + path });
  await waitFor(`${path} to load`, "document.readyState === 'complete'", 120_000);
}
// A mark button, and only that: the theme and skin pickers also carry aria-pressed.
const MARK_BUTTONS = 'button[aria-pressed][aria-label*=": "]';
const HYDRATED = `(() => { const n = document.querySelector('${MARK_BUTTONS}'); return !!n && Object.keys(n).some((k) => k.startsWith('__reactProps$')); })()`;
const click = (matcher) => ev(`(() => { const b = [...document.querySelectorAll('button')].find((b) => ${matcher}); if (!b) return false; b.click(); return true; })()`);
const clickNth = (selector, n) => ev(`(() => { const b = document.querySelectorAll(${JSON.stringify(selector)})[${n}]; if (!b) return false; b.click(); return true; })()`);
const text = () => ev("document.body.innerText");
const marksOf = (entry) => Object.values(entry?.marks ?? {});
async function setSession(token) {
  await browser.send("Network.enable");
  await browser.send("Network.setCookie", { name: COOKIE, value: token, url: BASE, httpOnly: true });
}

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────────
const stamp = Date.now();
const emails = [`offlinebrowser-a-${stamp}@example.test`, `offlinebrowser-b-${stamp}@example.test`];
const tokens = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")];
const hash = (t) => createHash("sha256").update(t).digest("hex");
let fx = null;

async function cleanup() {
  await db(async (owner) => {
    if (fx) {
      await owner.attendanceDay.deleteMany({ where: { classGroupId: fx.classGroupId, date: new Date(`${fx.day}T00:00:00Z`) } });
      await owner.auditLog.deleteMany({ where: { schoolId: fx.schoolId, action: "attendance.register", entityId: fx.classGroupId, createdAt: { gte: new Date(stamp - 1000) } } });
      await owner.termResult.updateMany({ where: { termId: fx.termId, classGroupId: fx.classGroupId }, data: { daysPresent: null, daysTotal: null } });
    }
    const probes = (await owner.user.findMany({ where: { email: { startsWith: "offlinebrowser-" } }, select: { id: true } })).map((u) => u.id);
    await owner.auditLog.deleteMany({ where: { actorUserId: { in: probes } } });
    await owner.session.deleteMany({ where: { user: { email: { startsWith: "offlinebrowser-" } } } });
    await owner.membership.deleteMany({ where: { user: { email: { startsWith: "offlinebrowser-" } } } });
    await owner.user.deleteMany({ where: { email: { startsWith: "offlinebrowser-" } } });
  });
}

async function main() {
  await cleanup(); // a crashed run leaves its logins behind, and they are all ours
  fx = await db(async (owner) => {
    const school = await owner.school.findFirst({ where: { slug: { not: { startsWith: "qa-" } } }, orderBy: { createdAt: "asc" } });
    if (!school) throw new Error("No seeded school. Run `npm run db:seed`.");
    const term = await owner.term.findFirstOrThrow({ where: { schoolId: school.id, sequence: 1 }, select: { id: true, startDate: true, academicYearId: true } });
    const classGroup = await owner.classGroup.findFirstOrThrow({ where: { schoolId: school.id, level: { code: "B5" } }, select: { id: true } });
    const d = new Date(term.startDate);
    d.setUTCDate(d.getUTCDate() + 43);
    const day = d.toISOString().slice(0, 10);
    let userA = "";
    for (const [i, email] of emails.entries()) {
      const user = await owner.user.create({ data: { name: `Offline Browser ${i}`, email, passwordHash: "x", schoolId: school.id }, select: { id: true } });
      await owner.membership.create({ data: { schoolId: school.id, userId: user.id, role: "OWNER", status: "ACTIVE" } });
      await owner.session.create({ data: { userId: user.id, tokenHash: hash(tokens[i]), activeSchoolId: school.id, expiresAt: new Date(Date.now() + 3 * 3600e3) } });
      if (i === 0) userA = user.id;
    }
    return { schoolId: school.id, schoolName: school.name, termId: term.id, classGroupId: classGroup.id, day, userA };
  });
  // With the server down, the service worker answers /attendance with the offline page. With it up, ?online=1
  // says "I will wait" so a cold server (the first request after a restart is slow) is not mistaken for no signal.
  const path = `/attendance?class=${fx.classGroupId}&date=${fx.day}`;
  const online = `${path}&online=1`;
  const registerRows = () =>
    db((owner) =>
      owner.attendanceEntry.findMany({
        where: { attendanceDay: { classGroupId: fx.classGroupId, date: new Date(`${fx.day}T00:00:00Z`) } },
        select: { studentId: true, mark: true },
      }),
    );

  await startServer();
  browser = await startBrowser();

  console.log("Online first: the phone prepares itself");
  await setSession(tokens[0]);
  await go(online);
  check("the register opens and hydrates", await waitFor("hydration", HYDRATED, 120_000));
  const children = await ev(`document.querySelectorAll('${MARK_BUTTONS}').length / 4`);
  check("with a row for every child on the roll", children >= 4, `${children}`);
  check("the service worker takes charge of the page", await waitFor("the service worker", "!!navigator.serviceWorker.controller", 90_000));
  check("the offline page is in the cache", await waitFor("the cache", "caches.match('/attendance-offline', { ignoreVary: true }).then((r) => !!r)", 90_000));
  check("the class list is kept on the phone, for this person", await waitFor("the roll", `${IDB}.then((s) => s.rolls.length > 0)`, 60_000));
  const state = await ev(IDB);
  check("and it names the child, not just an id", state.rolls[0]?.rows?.length === children && /\S+, \S+/.test(state.rolls[0].rows[0].name ?? ""));
  check("and belongs to the person who signed in", state.rolls[0]?.userId === fx.userA && state.meta.some((m) => m.k === "owner" && m.userId === fx.userA));

  console.log("\nThe signal drops while the page is open");
  await click("/Everyone present/.test(b.textContent)");
  await clickNth('button[aria-label$=": Absent"]', 0); // the first child
  await sleep(900); // the autosave debounce
  const draft = (await ev(IDB)).registers[0];
  check("what was tapped is already kept on the phone, as a draft", draft?.status === "draft" && marksOf(draft).filter((m) => m === "ABSENT").length === 1);
  await stopServer();
  await click("/Save|Update/.test(b.textContent)");
  check("pressing Save says it is kept on the phone, not 'saved'", await waitFor("the notice", "/Kept on this phone/.test(document.body.innerText)", 60_000), (await text()).slice(-300));
  const queued = (await ev(IDB)).registers[0];
  check("and it is queued with the same marks", queued?.status === "queued" && marksOf(queued).filter((m) => m === "ABSENT").length === 1 && marksOf(queued).filter((m) => m === "PRESENT").length === children - 1);
  const absentChild = Object.entries(queued.marks).find(([, m]) => m === "ABSENT")?.[0];

  console.log("\nThe page is closed and opened again with no server");
  await go(path);
  check("/attendance still opens: the service worker answers with the offline register", await waitFor("the offline page", "/Registers you take here|Open the full Attendance page/.test(document.body.innerText)", 90_000), (await text()).slice(0, 200));
  check("it hydrates", await waitFor("hydration", HYDRATED, 60_000));
  check("with the same children", (await ev(`document.querySelectorAll('${MARK_BUTTONS}').length / 4`)) === children);
  check("it says the register is waiting to be sent", await waitFor("the banner", "/waiting to be sent/.test(document.body.innerText)", 30_000));
  check("and the marks are back", (await ev("document.querySelectorAll('button[aria-pressed=true][aria-label$=\": Absent\"]').length")) === 1);
  // The COPY the service worker keeps, not the live page (which shows names read from the phone): it must be
  // the same bytes for every school and every person.
  const cached = await ev("caches.match('/attendance-offline', { ignoreVary: true }).then((r) => r.text())");
  const names = state.rolls[0].rows.flatMap((r) => r.name.split(/,\s*/)).concat(fx.schoolName);
  check("the cached offline page names no school and no child", names.every((n) => n.length < 3 || !cached.includes(n)), names.find((n) => cached.includes(n)));

  await clickNth('button[aria-label$=": Late"]', 1); // the second child, so the first stays absent
  await sleep(900);
  await click("/Save/.test(b.textContent)");
  check("a correction made offline is kept too", await waitFor("kept", "/Kept on this phone/.test(document.body.innerText)", 30_000));
  const corrected = (await ev(IDB)).registers[0];
  check("still queued, with one child late now", corrected?.status === "queued" && marksOf(corrected).filter((m) => m === "LATE").length === 1 && corrected.marks[absentChild] === "ABSENT", JSON.stringify(corrected?.marks));
  check("nothing has reached the school yet", (await registerRows()).length === 0);

  console.log("\nThe signal returns");
  await startServer();
  await go(online);
  check("the queue empties by itself", await waitFor("the queue", `${IDB}.then((s) => s.registers.length === 0)`, 180_000));
  const rows = await registerRows();
  check("the school has the register, with the correction", rows.length === children && rows.find((r) => r.studentId === absentChild)?.mark === "ABSENT" && rows.filter((r) => r.mark === "LATE").length === 1, JSON.stringify(rows));
  const audit = await db((owner) => owner.auditLog.findFirst({ where: { schoolId: fx.schoolId, action: "attendance.register", entityId: fx.classGroupId, createdAt: { gte: new Date(stamp - 1000) } }, orderBy: { createdAt: "desc" } }));
  check("the audit trail says it came from a phone", audit?.after?.offline === true);

  console.log("\nSigning out takes it off the phone");
  await go(online);
  await waitFor("hydration", HYDRATED, 120_000);
  await waitFor("the roll", `${IDB}.then((s) => s.rolls.length > 0)`, 60_000);
  const clicked = await click("b.textContent.trim() === 'Sign out'");
  const left = await waitFor("sign-out", "location.pathname === '/login'", 90_000);
  if (!left) console.log(`  (sign-out button found: ${clicked}; page is ${await ev("location.href")}; says: ${(await text()).slice(0, 200).replace(/\s+/g, " ")})`);
  const afterSignOut = await ev(IDB);
  check("no class list, no register and no owner remain", afterSignOut.rolls.length === 0 && afterSignOut.registers.length === 0 && afterSignOut.meta.length === 0, JSON.stringify(afterSignOut.meta));

  console.log("\nSomebody else signing in finds nothing of the last person's");
  // Sign-out ended A's session; mint a fresh one.
  const second = randomBytes(32).toString("hex");
  await db((owner) => owner.session.create({ data: { userId: fx.userA, tokenHash: hash(second), activeSchoolId: fx.schoolId, expiresAt: new Date(Date.now() + 3 * 3600e3) } }));
  await setSession(second);
  await go(online);
  await waitFor("hydration", HYDRATED, 120_000);
  check("A's class list is on the phone again", await waitFor("the roll", `${IDB}.then((s) => s.rolls.some((r) => r.userId === '${fx.userA}'))`, 60_000));
  await click("b.textContent.trim() === 'Everyone present'");
  await sleep(900);
  check("with a draft", (await ev(IDB)).registers.length === 1);
  // The same browser, now B. (A's session cookie is replaced; A never signed out.)
  await setSession(tokens[1]);
  await go("/attendance?online=1");
  await waitFor("the page", "document.readyState === 'complete'", 60_000);
  check("B's page claims the phone: A's class list and draft are gone", await waitFor("the wipe", `${IDB}.then((s) => s.rolls.every((r) => r.userId !== '${fx.userA}') && s.registers.length === 0)`, 60_000));
  const owner = (await ev(IDB)).meta.find((m) => m.k === "owner");
  check("and the phone is B's", owner && owner.userId !== fx.userA);
}

try {
  await main();
} catch (error) {
  console.error(error);
  failed += 1;
} finally {
  try { browser?.close(); } catch {}
  await stopServer().catch(() => {});
  await cleanup().catch((e) => console.error("cleanup failed", e));
}
console.log(`\n${failed === 0 ? "All checks passed" : `${failed} FAILED`} (${passed} ok)`);
process.exit(failed === 0 ? 0 : 1);
