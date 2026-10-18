/**
 * Drive the seeded schools as hard as a bad day would, and report what it cost.
 *
 *   npm run load:run -- --scenario smoke        # one of everything: is the harness itself sound?
 *   npm run load:run                            # the peak: results published, term start, registers, an invoice run
 *   npm run load:run -- --scenario parents --parents 600 --duration 60
 *
 * Scenarios: smoke, parents, login, office, registers, marks, invoices, peak (all of them at once).
 *
 * WHAT IT MEASURES, and what it does not:
 *   - Latency per kind of request (p50 / p95 / p99), and the share that failed outright.
 *   - The database while it happens: connections by state, how many were waiting on a lock, and
 *     how close the total came to max_connections (sampled each second on its own connection).
 *   - The app server's CPU and memory, when it can find the process listening on the port.
 *   - Pool exhaustion in the server's own log (P2024, P2028), when `--server-log` is given.
 *     A starved pool shows to a user as a 500 or a hang, so it shows here as a failure too; the log
 *     is what says WHICH.
 *
 * ⚠️ On one laptop the runner, the server and the database share a CPU, so every number is
 * pessimistic about CPU and optimistic about the network (there is none). Trust the SHAPE (what
 * degrades first, what the pool does) and the ratios between runs. The numbers that decide a
 * hosting tier come from a production-shaped run: a deployed copy against a throwaway project of
 * the tier under test. See README.md in this folder.
 *
 * Sessions are minted straight into the database (as the other guards do), because 600 logins
 * through the real form would measure the hashing and nothing else. The `login` scenario is where
 * real sign-ins are measured. Every session it makes carries a marker and is removed afterwards.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync, openSync, readSync, closeSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { requireSafeTarget } from "./preflight.mjs";
import { Client, COOKIE_NAME, alerts, formHaving, forms, rng, sleep } from "./http.mjs";
import { DEFAULT_BUDGET, judge, summarise, type Budget, type Sample } from "./stats.mjs";
import { LOAD_PASSWORD, SESSION_MARK } from "./constants.mjs";

requireSafeTarget();

/* ── Arguments ────────────────────────────────────────────────────────────── */

const flag = (name: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const num = (name: string, fallback: number) => {
  const value = Number(flag(name));
  return Number.isFinite(value) && flag(name) !== undefined ? value : fallback;
};

type Mix = { parents: number; logins: number; officePerSchool: number; registerShare: number; marks: number; invoiceSchools: number; schools: number; duration: number };

const SCENARIOS: Record<string, Partial<Mix>> = {
  smoke: { schools: 1, parents: 2, logins: 1, officePerSchool: 1, registerShare: 0.1, marks: 1, invoiceSchools: 1, duration: 8 },
  parents: { logins: 0, officePerSchool: 0, registerShare: 0, marks: 0, invoiceSchools: 0 },
  login: { parents: 0, officePerSchool: 0, registerShare: 0, marks: 0, invoiceSchools: 0 },
  office: { parents: 0, logins: 0, registerShare: 0, marks: 0, invoiceSchools: 0 },
  registers: { parents: 0, logins: 0, officePerSchool: 0, marks: 0, invoiceSchools: 0 },
  marks: { parents: 0, logins: 0, officePerSchool: 0, registerShare: 0, invoiceSchools: 0 },
  invoices: { parents: 0, logins: 0, officePerSchool: 0, registerShare: 0, marks: 0 },
  peak: {},
};
const scenarioName = flag("scenario") ?? "peak";
if (!(scenarioName in SCENARIOS)) {
  console.error(`Unknown scenario "${scenarioName}". One of: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(1);
}
const BASE_MIX: Mix = { schools: 10, parents: 300, logins: 60, officePerSchool: 3, registerShare: 1, marks: 20, invoiceSchools: 2, duration: 120 };
const preset = SCENARIOS[scenarioName]!;
const mix: Mix = {
  schools: num("schools", preset.schools ?? BASE_MIX.schools),
  parents: num("parents", preset.parents ?? BASE_MIX.parents),
  logins: num("logins", preset.logins ?? BASE_MIX.logins),
  officePerSchool: num("office", preset.officePerSchool ?? BASE_MIX.officePerSchool),
  registerShare: num("registers", preset.registerShare ?? BASE_MIX.registerShare),
  marks: num("marks", preset.marks ?? BASE_MIX.marks),
  invoiceSchools: num("invoice-schools", preset.invoiceSchools ?? BASE_MIX.invoiceSchools),
  duration: num("duration", preset.duration ?? BASE_MIX.duration),
};
const budget: Budget = {
  pageP95Ms: num("page-p95", DEFAULT_BUDGET.pageP95Ms),
  actionP95Ms: num("action-p95", DEFAULT_BUDGET.actionP95Ms),
  loginP95Ms: num("login-p95", DEFAULT_BUDGET.loginP95Ms),
  errorRate: num("error-rate", DEFAULT_BUDGET.errorRate),
};
const BASE = (process.env.LOAD_BASE_URL ?? "").replace(/\/$/, "");
const SERVER_LOG = flag("server-log");
const rand = rng(num("seed", 7));
const db = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

/* ── What was measured ────────────────────────────────────────────────────── */

const samples: Sample[] = [];
const record = (sample: Sample) => samples.push(sample);
/** The distinct alert texts each action answered with, so a "failure" can be read rather than guessed at. */
const said = new Map<string, Map<string, number>>();
function remember(label: string, html: string) {
  const bucket = said.get(label) ?? new Map<string, number>();
  for (const text of alerts(html)) bucket.set(text.slice(0, 140), (bucket.get(text.slice(0, 140)) ?? 0) + 1);
  said.set(label, bucket);
}
/** Phrases an action uses to say it did NOT do what was asked. */
const REFUSED = /nothing was saved|only the|nobody|choose a|not inside|not a mark|not allowed|too many|could not|couldn't|failed|something went wrong|no structure|refus/i;
const refused = (html: string) => alerts(html).some((a) => REFUSED.test(a));

/* ── Who exists ───────────────────────────────────────────────────────────── */

type Plan = {
  id: string;
  slug: string;
  ownerUserId: string;
  term1Id: string;
  term2Id: string;
  classes: { id: string; formUserId: string | null }[];
  pairs: { userId: string; classId: string; subjectId: string }[];
  parents: { userId: string; phone: string }[];
};

async function discover(count: number, parentsPerSchool: number): Promise<Plan[]> {
  const schools = await db.school.findMany({ where: { slug: { startsWith: "load-" } }, orderBy: { slug: "asc" }, take: count, select: { id: true, slug: true } });
  if (schools.length === 0) throw new Error("No load-* schools in this database. Run `npm run load:seed` first.");
  const plans: Plan[] = [];
  for (const school of schools) {
    const owner = await db.membership.findFirstOrThrow({ where: { schoolId: school.id, role: "OWNER" }, select: { userId: true } });
    const terms = await db.term.findMany({ where: { schoolId: school.id }, select: { id: true, sequence: true } });
    const classes = await db.classGroup.findMany({
      where: { schoolId: school.id },
      select: { id: true, formTeacher: { select: { memberships: { where: { role: "TEACHER" }, select: { userId: true } } } } },
    });
    const assignments = await db.teachingAssignment.findMany({
      where: { schoolId: school.id },
      select: { classGroupId: true, subjectId: true, staff: { select: { memberships: { where: { role: "TEACHER" }, select: { userId: true } } } } },
    });
    const seen = new Set<string>();
    const pairs: Plan["pairs"] = [];
    for (const a of assignments) {
      const userId = a.staff.memberships[0]?.userId;
      if (!userId || seen.has(userId)) continue;
      seen.add(userId);
      pairs.push({ userId, classId: a.classGroupId, subjectId: a.subjectId });
    }
    const parents = await db.membership.findMany({
      where: { schoolId: school.id, role: "PARENT" },
      take: parentsPerSchool,
      select: { userId: true, user: { select: { phone: true } } },
    });
    plans.push({
      id: school.id,
      slug: school.slug,
      ownerUserId: owner.userId,
      term1Id: terms.find((t) => t.sequence === 1)!.id,
      term2Id: terms.find((t) => t.sequence === 2)!.id,
      classes: classes.map((c) => ({ id: c.id, formUserId: c.formTeacher?.memberships[0]?.userId ?? null })),
      pairs,
      parents: parents.map((p) => ({ userId: p.userId, phone: `0${(p.user.phone ?? "").slice(3)}` })),
    });
  }
  return plans;
}

/** One session per user, written in a single statement. The token is what the cookie carries. */
async function mintSessions(entries: { userId: string; schoolId: string }[]): Promise<Map<string, string>> {
  const tokens = new Map<string, string>();
  const rows: { userId: string; activeSchoolId: string; tokenHash: string; expiresAt: Date; userAgent: string }[] = [];
  for (const e of entries) {
    // A form teacher is often also the teacher the mark sheet picked: one session per person, not one per role.
    if (tokens.has(e.userId)) continue;
    const token = randomBytes(32).toString("hex");
    tokens.set(e.userId, token);
    rows.push({ userId: e.userId, activeSchoolId: e.schoolId, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 3 * 60 * 60 * 1000), userAgent: SESSION_MARK });
  }
  for (let i = 0; i < rows.length; i += 1000) await db.session.createMany({ data: rows.slice(i, i + 1000) });
  return tokens;
}

/* ── The people ───────────────────────────────────────────────────────────── */

const todayKey = new Date().toISOString().slice(0, 10);
const think = (low: number, high: number) => sleep(rand.between(low, high) * 1000);
const ipFor = (n: number) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
let ipCounter = 1;

/** A parent checking the portal after a text said the report is ready. */
async function parent(plan: Plan, who: Plan["parents"][number], tokens: Map<string, string>, delayMs: number) {
  await sleep(delayMs);
  const c = new Client(BASE, record, tokens.get(who.userId)!, ipFor(ipCounter++));
  const home = await c.get("/portal", "portal: home");
  if (home.status !== 200) return;
  const children = [...new Set([...home.html.matchAll(/href="\/portal\/([A-Za-z0-9_-]+)"/g)].map((m) => m[1]!))];
  if (children.length === 0) return;
  const child = rand.pick(children);
  await think(2, 6);
  await c.get(`/portal/${child}`, "portal: child");
  await think(2, 6);
  if (rand.next() < 0.5) {
    await c.get(`/portal/${child}/fees`, "portal: fees");
    await think(2, 5);
  }
  const results = await c.get(`/portal/${child}/results`, "portal: results list");
  const card = results.html.match(new RegExp(`href="/portal/${child}/results/([A-Za-z0-9_-]+)"`))?.[1];
  if (card) {
    await think(1, 4);
    await c.get(`/portal/${child}/results/${card}`, "portal: report card");
  }
}

/** A real sign-in through the form: this is what the hashing costs under a crowd. */
async function login(who: Plan["parents"][number], delayMs: number) {
  await sleep(delayMs);
  const ip = ipFor(ipCounter++);
  const anon = new Client(BASE, record, "", ip);
  const page = await anon.get("/login", "login: page");
  const form = forms(page.html).find((f) => f.fields.some((x) => x.name === "identifier"));
  if (!form) return;
  const reply = await anon.post("/login", form, { identifier: who.phone, password: LOAD_PASSWORD }, "login: sign in", "login", (r) => r.setCookie.some((c) => c.includes(`${COOKIE_NAME}=`)));
  const token = reply.setCookie.map((c) => c.match(new RegExp(`${COOKIE_NAME}=([^;]+)`))?.[1]).find(Boolean);
  if (!token) return;
  await new Client(BASE, record, token, ip).get("/portal", "portal: home (after sign-in)");
}

/** The office on an ordinary day: the heavy list pages, over and over. */
const OFFICE_PAGES: [string, string][] = [
  ["/dashboard", "office: dashboard"],
  ["/students", "office: students"],
  ["/students?q=Mensah", "office: student search"],
  ["/invoices", "office: invoices"],
  ["/debtors", "office: debtors"],
  ["/fees", "office: fees"],
  ["/results", "office: results"],
  ["/messages", "office: messages"],
  ["/attendance", "office: attendance"],
  ["/classes", "office: classes"],
  ["/chart-of-accounts", "office: chart of accounts"],
];
async function office(token: string, seconds: number, delayMs: number, sweep = false) {
  await sleep(delayMs);
  const c = new Client(BASE, record, token, ipFor(ipCounter++));
  // The smoke run opens every page exactly once, so "can the harness reach it" never depends on a dice roll.
  if (sweep) {
    for (const [path, label] of OFFICE_PAGES) await c.get(path, label);
    return;
  }
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const [path, label] = rand.pick(OFFICE_PAGES);
    await c.get(path, label);
    await think(3, 10);
  }
}

/** A form teacher taking the morning register: open the page, mark, save. */
async function register(plan: Plan, classId: string, token: string, delayMs: number) {
  await sleep(delayMs);
  const c = new Client(BASE, record, token, ipFor(ipCounter++));
  const path = `/attendance?class=${classId}&date=${todayKey}`;
  const page = await c.get(path, "register: open");
  const form = formHaving(page.html, (n) => n.startsWith("mark:"));
  if (!form) return;
  const marks = form.fields.filter((f) => f.name.startsWith("mark:"));
  const changed: Record<string, string> = {};
  for (let i = 0; i < Math.min(4, marks.length); i += 1) changed[rand.pick(marks).name] = rand.pick(["ABSENT", "LATE", "PRESENT"]);
  await think(1, 3);
  const reply = await c.post(path, form, changed, "register: save", "action", (r) => (r.status === 200 || r.status === 303) && !refused(r.html));
  remember("register: save", reply.html);
}

/** A teacher entering marks, which saves and then rolls the whole class up. The heaviest write in the app. */
async function marks(plan: Plan, pair: Plan["pairs"][number], token: string, delayMs: number) {
  await sleep(delayMs);
  const c = new Client(BASE, record, token, ipFor(ipCounter++));
  const path = `/assessments/sheet?term=${plan.term2Id}&class=${pair.classId}&subject=${pair.subjectId}`;
  const page = await c.get(path, "marks: open sheet");
  const form = formHaving(page.html, (n) => n.startsWith("score:"));
  if (!form) return;
  // Fill the blanks only, with a mark under every component's total (the smallest is 10), so nothing is refused.
  const blanks = form.fields.filter((f) => f.name.startsWith("score:") && f.value === "" && !f.disabled);
  const filled: Record<string, string> = {};
  for (const field of blanks.slice(0, 40)) filled[field.name] = String(1 + rand.int(8));
  await think(2, 6);
  const reply = await c.post(path, form, filled, "marks: save sheet", "action", (r) => (r.status === 200 || r.status === 303) && !refused(r.html) && /Saved \d+ mark/.test(r.html));
  remember("marks: save sheet", reply.html);
}

/** The bursar pressing "generate invoices" for the term that has none yet. */
async function invoiceRun(plan: Plan, token: string, delayMs: number) {
  await sleep(delayMs);
  const c = new Client(BASE, record, token, ipFor(ipCounter++));
  const page = await c.get("/invoices", "invoices: open");
  const form = formHaving(page.html, (n) => n === "termId");
  if (!form) return;
  const reply = await c.post("/invoices", form, { termId: plan.term2Id }, "invoices: generate for the term", "action", (r) => (r.status === 200 || r.status === 303) && !refused(r.html));
  remember("invoices: generate for the term", reply.html);
}

/* ── What the machines were doing ─────────────────────────────────────────── */

type DbPeak = { active: number; idleInTx: number; lockWaits: number; total: number; max: number };
const peak: DbPeak = { active: 0, idleInTx: 0, lockWaits: 0, total: 0, max: 0 };
async function sampleDatabase(stop: () => boolean) {
  while (!stop()) {
    try {
      const [row] = await db.$queryRaw<{ active: number; idle_tx: number; locks: number; total: number; max: number }[]>`
        select count(*) filter (where state = 'active')::int as active,
               count(*) filter (where state like 'idle in transaction%')::int as idle_tx,
               count(*) filter (where wait_event_type = 'Lock')::int as locks,
               count(*)::int as total,
               current_setting('max_connections')::int as max
        from pg_stat_activity where datname = current_database()`;
      if (row) {
        peak.active = Math.max(peak.active, row.active);
        peak.idleInTx = Math.max(peak.idleInTx, row.idle_tx);
        peak.lockWaits = Math.max(peak.lockWaits, row.locks);
        peak.total = Math.max(peak.total, row.total);
        peak.max = row.max;
      }
    } catch {
      // The database being too busy to answer is itself the finding; the requests will say so.
    }
    await sleep(1000);
  }
}

const run = (file: string, args: string[]) =>
  new Promise<string>((resolveRun) => execFile(file, args, (_error, stdout) => resolveRun(String(stdout ?? "").trim())));

const server = { cpu: 0, rssMb: 0, pid: "", cpuSeconds: 0 };

/** `ps -o time=` as seconds: "mm:ss.cc" or "h:mm:ss". */
const cpuTime = (text: string) => text.trim().split(":").reduce((total, part) => total * 60 + Number(part), 0);
async function sampleServer(stop: () => boolean) {
  const port = new URL(BASE).port || "80";
  server.pid = (await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])).split("\n")[0] ?? "";
  if (!server.pid) return;
  const first = cpuTime(await run("ps", ["-o", "time=", "-p", server.pid]));
  while (!stop()) {
    const [cpu, rss] = (await run("ps", ["-o", "%cpu=,rss=", "-p", server.pid])).split(/\s+/).map(Number);
    const used = cpuTime(await run("ps", ["-o", "time=", "-p", server.pid]));
    if (Number.isFinite(used)) server.cpuSeconds = Math.max(server.cpuSeconds, used - first);
    if (Number.isFinite(cpu)) server.cpu = Math.max(server.cpu, cpu!);
    if (Number.isFinite(rss)) server.rssMb = Math.max(server.rssMb, Math.round(rss! / 1024));
    await sleep(2000);
  }
}

function logOffset(): number {
  try {
    return SERVER_LOG ? statSync(SERVER_LOG).size : 0;
  } catch {
    return 0;
  }
}
function logSince(offset: number): { pool: number; tx: number } | null {
  if (!SERVER_LOG) return null;
  try {
    const fd = openSync(SERVER_LOG, "r");
    const size = statSync(SERVER_LOG).size;
    const buffer = Buffer.alloc(Math.max(0, size - offset));
    readSync(fd, buffer, 0, buffer.length, offset);
    closeSync(fd);
    const text = buffer.toString("utf8");
    return { pool: (text.match(/P2024|Timed out fetching a new connection/g) ?? []).length, tx: (text.match(/P2028|Transaction API error|Unable to start a transaction/g) ?? []).length };
  } catch {
    return null;
  }
}

/* ── Main ─────────────────────────────────────────────────────────────────── */

const spread = () => rand.next() * mix.duration * 1000;

async function main() {
  console.log(`\nScenario ${scenarioName}: ${JSON.stringify(mix)}\n`);

  try {
    await fetch(`${BASE}/login`, { signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new Error(`Nothing is answering at ${BASE}. Start the server first: npm run load:serve`);
  }

  await db.session.deleteMany({ where: { userAgent: SESSION_MARK } });
  // Size the parent list by the schools that EXIST, not the number asked for: asking for ten of three schools
  // once divided by ten and quietly ran a third of the crowd.
  const available = Math.min(mix.schools, await db.school.count({ where: { slug: { startsWith: "load-" } } }));
  if (available === 0) throw new Error("No load-* schools in this database. Run `npm run load:seed` first.");
  const plans = await discover(available, Math.max(1, Math.ceil((mix.parents + mix.logins) / available)));
  console.log(`Found ${plans.length} schools: ${plans.map((p) => p.slug).join(", ")}`);

  const want: { userId: string; schoolId: string }[] = [];
  for (const plan of plans) {
    want.push({ userId: plan.ownerUserId, schoolId: plan.id });
    for (const p of plan.parents) want.push({ userId: p.userId, schoolId: plan.id });
    for (const c of plan.classes) if (c.formUserId) want.push({ userId: c.formUserId, schoolId: plan.id });
    for (const p of plan.pairs) want.push({ userId: p.userId, schoolId: plan.id });
  }
  // The invoice run is idempotent ("all 200 students already have an invoice"), so a second run would
  // measure nothing. Clear the open term's invoices for the schools that will generate them. Term 2 is
  // seeded unbilled and unpaid, so this only ever removes what a previous run of this made.
  for (const plan of plans.slice(0, mix.invoiceSchools)) {
    const cleared = await db.invoice.deleteMany({ where: { schoolId: plan.id, termId: plan.term2Id } });
    if (cleared.count) console.log(`Cleared ${cleared.count} term-2 invoices at ${plan.slug} from an earlier run.`);
  }

  const tokens = await mintSessions(want);
  console.log(`Minted ${tokens.size} sessions.`);

  // Warm every route once so a cold start is not charged to the first unlucky request.
  const warm = new Client(BASE, () => {}, tokens.get(plans[0]!.ownerUserId)!);
  for (const [path] of OFFICE_PAGES) await warm.get(path, "warm-up");
  await new Client(BASE, () => {}, tokens.get(plans[0]!.parents[0]?.userId ?? "") ?? "").get("/portal", "warm-up");

  let finished = false;
  const stopped = () => finished;
  const before = logOffset();
  const started = Date.now();
  const watchers = [sampleDatabase(stopped), sampleServer(stopped)];

  const jobs: Promise<unknown>[] = [];
  const perSchoolParents = Math.ceil(mix.parents / plans.length);
  const perSchoolLogins = Math.ceil(mix.logins / plans.length);
  for (const plan of plans) {
    const people = plan.parents;
    for (const who of people.slice(0, perSchoolParents)) jobs.push(parent(plan, who, tokens, spread()));
    for (const who of people.slice(perSchoolParents, perSchoolParents + perSchoolLogins)) jobs.push(login(who, spread()));
    for (let i = 0; i < mix.officePerSchool; i += 1) jobs.push(office(tokens.get(plan.ownerUserId)!, mix.duration, spread() / 4, scenarioName === "smoke"));
    const formTeachers = plan.classes.filter((c) => c.formUserId);
    const takers = Math.round(formTeachers.length * mix.registerShare);
    for (const cls of formTeachers.slice(0, takers)) jobs.push(register(plan, cls.id, tokens.get(cls.formUserId!)!, spread()));
  }
  const markers = plans.flatMap((plan) => plan.pairs.map((pair) => ({ plan, pair }))).slice(0, mix.marks);
  for (const { plan, pair } of markers) jobs.push(marks(plan, pair, tokens.get(pair.userId)!, spread()));
  for (const plan of plans.slice(0, mix.invoiceSchools)) jobs.push(invoiceRun(plan, tokens.get(plan.ownerUserId)!, (mix.duration * 1000) / 3));

  const launched = {
    parents: plans.reduce((n, p) => n + Math.min(p.parents.length, perSchoolParents), 0),
    logins: plans.reduce((n, p) => n + Math.max(0, Math.min(p.parents.length, perSchoolParents + perSchoolLogins) - perSchoolParents), 0),
    office: plans.length * mix.officePerSchool,
    registers: plans.reduce((n, p) => n + Math.round(p.classes.filter((c) => c.formUserId).length * mix.registerShare), 0),
    marks: markers.length,
    invoiceRuns: Math.min(mix.invoiceSchools, plans.length),
  };
  console.log(`Launching: ${JSON.stringify(launched)}`);
  if (launched.parents < mix.parents || launched.logins < mix.logins) {
    console.log(`  note: asked for ${mix.parents} parents and ${mix.logins} sign-ins but the seeded schools hold fewer parent logins; seed more pupils or fewer parents.`);
  }

  await Promise.all(jobs);
  const elapsed = (Date.now() - started) / 1000;
  finished = true;
  await Promise.all(watchers);

  if (!process.argv.includes("--keep")) {
    const gone = await db.session.deleteMany({ where: { userAgent: SESSION_MARK } });
    console.log(`Removed ${gone.count} load sessions.`);
  }

  report(elapsed, logSince(before));
}

function report(elapsed: number, log: { pool: number; tx: number } | null) {
  const rows = summarise(samples, elapsed);
  const ms = (n: number) => String(Math.round(n)).padStart(7);
  console.log(`\n${"request".padEnd(40)}${"count".padStart(7)}${"failed".padStart(8)}${"p50".padStart(8)}${"p95".padStart(8)}${"p99".padStart(8)}${"max".padStart(8)}`);
  for (const r of rows) console.log(`${r.label.padEnd(40)}${String(r.count).padStart(7)}${String(r.failed).padStart(8)}${ms(r.p50)} ${ms(r.p95)} ${ms(r.p99)} ${ms(r.max)}`);
  const total = samples.length;
  const failed = samples.filter((s) => !s.ok).length;
  console.log(`\n${total} requests in ${elapsed.toFixed(0)}s (${(total / Math.max(1, elapsed)).toFixed(1)}/s), ${failed} failed.`);

  const statuses = new Map<number, number>();
  for (const s of samples.filter((x) => !x.ok)) statuses.set(s.status, (statuses.get(s.status) ?? 0) + 1);
  if (statuses.size) console.log(`Failures by status: ${[...statuses].map(([k, v]) => `${k === 0 ? "timeout/refused" : k}: ${v}`).join(", ")}`);
  for (const [label, texts] of said) {
    for (const [text, n] of texts) console.log(`  ${label} said (${n}x): ${text}`);
  }

  console.log(`\nDatabase peak: ${peak.active} active, ${peak.idleInTx} idle in transaction, ${peak.lockWaits} waiting on a lock; ${peak.total} of ${peak.max} connections.`);
  if (server.pid) {
    console.log(`Server (pid ${server.pid}) peak: ${server.cpu.toFixed(0)}% of one core, ${server.rssMb} MB resident.`);
    // CPU spent per request is the one figure that travels between machines: divide by a host's speed and it
    // says how many requests a core serves a second, which is what sizes instances and Active CPU billing.
    console.log(`Server CPU consumed: ${server.cpuSeconds.toFixed(0)} s over ${samples.length} requests = ${((server.cpuSeconds * 1000) / Math.max(1, samples.length)).toFixed(0)} ms of CPU per request on this machine.`);
  }
  else console.log("Server process not found on the port, so its CPU and memory were not sampled.");
  if (log) console.log(`Server log: ${log.pool} pool timeouts (P2024), ${log.tx} transaction failures (P2028).`);
  else console.log("No --server-log given, so pool timeouts could only be seen as failed requests.");

  const failures = judge(rows, budget);
  if (log && (log.pool > 0 || log.tx > 0)) failures.push(`the server log shows ${log.pool} pool timeouts and ${log.tx} transaction failures`);
  if (peak.max > 0 && peak.total / peak.max > 0.8) failures.push(`database connections reached ${peak.total} of ${peak.max} (over 80%)`);

  // The smoke run is not a performance test: it asks only whether every part of the harness reached the app.
  if (scenarioName === "smoke") {
    const labels = new Set(rows.filter((r) => r.failed < r.count).map((r) => r.label));
    for (const must of ["portal: home", "portal: child", "office: dashboard", "register: open", "register: save", "marks: open sheet", "marks: save sheet", "invoices: generate for the term", "login: sign in"]) {
      if (!labels.has(must)) failures.push(`"${must}" never succeeded, so the harness cannot drive it`);
    }
    const functional = failures.filter((f) => f.includes("never succeeded"));
    console.log(functional.length ? `\nSMOKE FAILED:\n${functional.map((f) => `  - ${f}`).join("\n")}` : "\nSMOKE OK: every part of the harness reached the app.");
    finish(rows, elapsed, functional);
    return;
  }

  console.log(failures.length ? `\nOVER BUDGET:\n${failures.map((f) => `  - ${f}`).join("\n")}` : `\nWITHIN BUDGET (page p95 ${budget.pageP95Ms} ms, action ${budget.actionP95Ms} ms, login ${budget.loginP95Ms} ms, errors ${budget.errorRate * 100}%).`);
  finish(rows, elapsed, failures);
}

function finish(rows: ReturnType<typeof summarise>, elapsed: number, failures: string[]) {
  const dir = resolve(import.meta.dirname, "../../load-results");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${scenarioName}.json`);
  writeFileSync(file, JSON.stringify({ scenario: scenarioName, mix, budget, elapsed, rows, database: peak, server, said: Object.fromEntries([...said].map(([k, v]) => [k, Object.fromEntries(v)])), failures }, null, 2));
  console.log(`\nWritten to ${file}`);
  process.exitCode = failures.length ? 1 : 0;
}

main()
  .catch((error) => {
    console.error(`\n${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (!process.argv.includes("--keep")) await db.session.deleteMany({ where: { userAgent: SESSION_MARK } }).catch(() => {});
    await db.$disconnect();
  });

