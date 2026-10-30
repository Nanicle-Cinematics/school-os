/**
 * Taking a register with no signal: the rules, and the shape of the code around them.
 *
 *   npm run verify:offline-register
 *
 * No database and no server. The rules are the pure functions in
 * `src/lib/offline-register.ts`, which the phone and the sync route both run;
 * the shape checks read the source (comments stripped, since this codebase
 * explains its mistakes at length and a comment naming a rule would satisfy a
 * check that the rule is not there).
 *
 * `verify:offline-sync` drives the real route against the database and
 * `verify:offline-browser` takes a register in a real browser with the network
 * cut. This one is the cheap half that runs in `check:fast`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ROLL_MAX_AGE_DAYS,
  SYNC_MAX_CHILDREN,
  SYNC_MAX_ITEMS,
  applyResults,
  belongsTo,
  describe,
  isDay,
  parseSyncBody,
  registerKey,
  rollIsFresh,
  toSyncItems,
  type OfflineEntry,
  type SyncItem,
} from "@/lib/offline-register";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail.slice(0, 300)}` : ""}`);
  if (!ok) failures += 1;
}

const root = resolve(import.meta.dirname, "..");
const code = (file: string) =>
  readFileSync(resolve(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

const base = { classGroupId: "c1", date: "2026-10-20", marks: { s1: "PRESENT", s2: "" }, markedAt: "2026-10-20T07:50:00.000Z" };
const item = (over: Record<string, unknown> = {}) => ({ ...base, ...over });
const parse = (items: unknown[]) => parseSyncBody({ items });

console.log("What the server will read from a phone");
{
  const ok = parse([item()]);
  check("a well-formed register is accepted", ok.ok && ok.items.length === 1 && ok.items[0]!.key === "c1|2026-10-20");
  check("a blank mark is kept as 'not marked'", ok.ok && ok.items[0]!.marks.s2 === "");
  check("not an object, no items, items not a list: refused", !parseSyncBody(null).ok && !parseSyncBody({}).ok && !parseSyncBody({ items: "x" }).ok);
  check("an empty list is refused", !parse([]).ok);
  check(`more than ${SYNC_MAX_ITEMS} registers is refused`, !parse(Array.from({ length: SYNC_MAX_ITEMS + 1 }, (_, i) => item({ date: `2026-10-${String(i + 1).padStart(2, "0")}` }))).ok);
  check(`exactly ${SYNC_MAX_ITEMS} is accepted`, parse(Array.from({ length: SYNC_MAX_ITEMS }, (_, i) => item({ date: `2026-09-${String(i + 1).padStart(2, "0")}` }))).ok);
  check("the same class and day twice is refused, not merged", !parse([item(), item()]).ok);
  check("a mark that is not one of the four is refused", !parse([item({ marks: { s1: "HERE" } })]).ok);
  check("a lowercase mark is refused", !parse([item({ marks: { s1: "present" } })]).ok);
  check("2026-02-31 is not a day", !isDay("2026-02-31") && !parse([item({ date: "2026-02-31" })]).ok);
  check("a timestamp is not a day", !isDay("2026-10-20T00:00:00Z"));
  check("no class is refused", !parse([item({ classGroupId: "" })]).ok);
  check("an oversized id is refused", !parse([item({ classGroupId: "x".repeat(65) })]).ok);
  check("no marks at all is refused", !parse([item({ marks: {} })]).ok);
  check("marks as a list are refused", !parse([item({ marks: ["PRESENT"] })]).ok);
  check("a bad time is refused", !parse([item({ markedAt: "yesterday" })]).ok);
  const huge = Object.fromEntries(Array.from({ length: SYNC_MAX_CHILDREN + 1 }, (_, i) => [`s${i}`, "PRESENT"]));
  check(`more than ${SYNC_MAX_CHILDREN} children in one register is refused`, !parse([item({ marks: huge })]).ok);
  const withNotes = parse([item({ marks: { s1: "EXCUSED" }, notes: { s1: "x".repeat(500), ghost: "for nobody", s2: "" } })]);
  check(
    "a note is cut to 200 characters, and one for a child not in the register is dropped",
    withNotes.ok && withNotes.items[0]!.notes.s1?.length === 200 && !("ghost" in withNotes.items[0]!.notes),
  );
  check("a note that is not text is refused", !parse([item({ notes: { s1: 5 } })]).ok);
}

console.log("\nWhat to keep after the server answers");
{
  const entry = (key: string, status: OfflineEntry["status"], updatedAt = "2026-10-20T07:50:00.000Z"): OfflineEntry => ({
    key, classGroupId: key.split("|")[0]!, date: key.split("|")[1]!, status, marks: { s1: "PRESENT" }, notes: {}, updatedAt, error: null,
  });
  const queued = [entry("c1|2026-10-20", "queued"), entry("c1|2026-10-21", "queued", "2026-10-21T07:50:00.000Z"), entry("c1|2026-10-22", "draft"), entry("c1|2026-10-23", "failed")];
  const sent = toSyncItems(queued);
  check("only queued registers are sent: not a draft, not a refused one", sent.length === 2 && sent.every((i) => i.key !== "c1|2026-10-22" && i.key !== "c1|2026-10-23"));
  check("oldest first", sent[0]!.key === "c1|2026-10-20");
  check(`at most ${SYNC_MAX_ITEMS} per post`, toSyncItems(Array.from({ length: 50 }, (_, i) => entry(`c1|2026-09-${String((i % 28) + 1).padStart(2, "0")}-${i}`, "queued"))).length === SYNC_MAX_ITEMS);

  const afterSave = applyResults(queued, sent, sent.map((i) => ({ key: i.key, ok: true as const, message: "ok" })));
  check("a saved register is dropped", !afterSave.some((e) => e.key === "c1|2026-10-20" || e.key === "c1|2026-10-21"));
  check("a draft and an earlier refusal are left alone", afterSave.length === 2 && afterSave.some((e) => e.key === "c1|2026-10-22") && afterSave.some((e) => e.key === "c1|2026-10-23"));

  const refused = applyResults(queued, sent, [
    { key: sent[0]!.key, ok: false, error: "not inside any term" },
    { key: sent[1]!.key, ok: true, message: "ok" },
  ]);
  const kept = refused.find((e) => e.key === "c1|2026-10-20");
  check("a refused register is kept, marked failed, with the server's words", kept?.status === "failed" && kept.error === "not inside any term" && Object.keys(kept.marks).length === 1);

  const blip = applyResults(queued, sent, [{ key: sent[0]!.key, ok: false, error: "try again", retry: true }, { key: sent[1]!.key, ok: true, message: "ok" }]);
  check("a database blip leaves the register queued, to try again", blip.find((e) => e.key === "c1|2026-10-20")?.status === "queued");

  const edited = queued.map((e) => (e.key === "c1|2026-10-20" ? { ...e, updatedAt: "2026-10-20T08:15:00.000Z", marks: { s1: "ABSENT" as const } } : e));
  const raced = applyResults(edited, sent, sent.map((i) => ({ key: i.key, ok: true as const, message: "ok" })));
  check("marks changed while the post was in flight are NOT thrown away", raced.find((e) => e.key === "c1|2026-10-20")?.marks.s1 === "ABSENT");
  check("a missing answer keeps the register", applyResults(queued, sent, []).length === queued.length);
  check("an answer for a register that was never sent is ignored", applyResults(queued, [], [{ key: "c1|2026-10-22", ok: true, message: "x" }]).length === queued.length);
  const items: SyncItem[] = [];
  check("nothing queued means nothing sent", toSyncItems([entry("c1|2026-10-22", "draft")]).length === 0 && items.length === 0);
}

console.log("\nWho the phone's copy belongs to, and for how long");
{
  const now = new Date("2026-10-27T08:00:00Z");
  const days = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  check(`a class list is good for ${ROLL_MAX_AGE_DAYS} days`, rollIsFresh({ savedAt: days(ROLL_MAX_AGE_DAYS) }, now));
  check("and not a minute longer", !rollIsFresh({ savedAt: new Date(now.getTime() - (ROLL_MAX_AGE_DAYS * 86_400_000 + 60_000)).toISOString() }, now));
  check("an unreadable date is not fresh", !rollIsFresh({ savedAt: "never" }, now));
  check("it belongs to the person and school that saved it", belongsTo({ userId: "u1", schoolId: "s1" }, { userId: "u1", schoolId: "s1" }));
  check("not to another person", !belongsTo({ userId: "u1", schoolId: "s1" }, { userId: "u2", schoolId: "s1" }));
  check("nor to the same person at another school", !belongsTo({ userId: "u1", schoolId: "s1" }, { userId: "u1", schoolId: "s2" }));
  check("registerKey is class|day", registerKey("c", "2026-10-20") === "c|2026-10-20");
  const c = describe({ marks: { a: "PRESENT", b: "LATE", c: "ABSENT", d: "EXCUSED", e: "" } });
  check("the banner's counts: late is in school, excused is away", c.inSchool === 2 && c.away === 2 && c.unmarked === 1);
}

console.log("\nThe shape of the code");
{
  const reg = code("src/lib/register-save.ts");
  const route = code("src/app/api/attendance/sync/route.ts");
  const action = code("src/lib/attendance-actions.ts");
  const sw = code("public/sw.js");
  const shellPage = code("src/app/attendance-offline/page.tsx") + code("src/app/attendance-offline/offline-register-app.tsx");
  const layout = code("src/app/(app)/layout.tsx");

  check("the online form speaks for the whole roll", /scope:\s*"all"/.test(action));
  check("the sync route speaks only for the children the phone listed", /scope:\s*"listed"/.test(route) && !/scope:\s*"all"/.test(route));
  check(
    "a 'listed' save removes only the entries it was told were cleared, never everyone else's",
    /input\.scope === "all"[\s\S]{0,200}notIn[\s\S]{0,120}:\s*\{[^}]*studentId:\s*\{\s*in:\s*cleared/.test(reg),
  );
  check("both callers go through the one function", /saveRegisterFor\(/.test(action) && /saveRegisterFor\(/.test(route) && !/attendanceEntry\.upsert/.test(action + route));
  check("the rules (form teacher, term, roll) are in that function", /mayMark\(auth, classGroupId\)/.test(reg) && /termForDate\(date\)/.test(reg) && /enrollment\.findMany/.test(reg));
  check("a register that came from a phone says so in the audit trail", /offline:\s*true/.test(reg) && /offline:\s*\{\s*markedAt/.test(route));
  check("the route checks the role BEFORE it reads the body", route.indexOf("requireRole(ATTENDANCE)") > 0 && route.indexOf("requireRole(ATTENDANCE)") < route.indexOf("request.text()"));
  check("and sets the tenant before saving", route.indexOf("setTenantContext(auth.tenant)") > 0 && route.indexOf("setTenantContext(auth.tenant)") < route.indexOf("saveRegisterFor("));
  check("it refuses a body that is not JSON, or from another site", /415/.test(route) && /sec-fetch-site/.test(route));
  check("it is a route, not a server action (an action id would not survive a deploy)", !/^"use server"/.test(code("src/lib/offline-register.ts")) && !/"use server"/.test(route));
  check("the pure rules import nothing from the server", !/from "@\/lib\/(prisma|auth|tenant-context)"/.test(code("src/lib/offline-register.ts")) && !/server-only/.test(code("src/lib/offline-register.ts")));

  // The service worker may cache exactly one page.
  const cachePuts = sw.match(/cache\.put\(([^,]+),/g) ?? [];
  check("the service worker puts exactly two kinds of thing in the cache: the build files and the offline page", cachePuts.length === 2 && cachePuts.some((p) => /SHELL/.test(p)) && cachePuts.some((p) => /request/.test(p)), cachePuts.join(" | "));
  const matches = sw.match(/caches\.match\(([^,)]+)/g) ?? [];
  check(
    "the only things read back from the cache are a build file by its own request and the offline page",
    matches.length === 3 && matches.filter((m) => /SHELL/.test(m)).length === 2 && matches.filter((m) => /\(request$/.test(m)).length === 1,
    matches.join(" | "),
  );
  check("the shell is answered network-first (an unhashed url must not go stale)", /async function shell\(request\)[\s\S]{0,400}Promise\.race\(\[fetch\(request\)/.test(sw));
  check("it never caches a redirect or an error as the shell", /response\.ok && !response\.redirected/.test(sw));
  check("only /attendance and /login hand over to it, and only for a full-page load", /request\.mode === "navigate"/.test(sw) && /"\/attendance"/.test(sw) && /"\/login"/.test(sw) && !/"\/students"|"\/fees"|"\/results"|"\/dashboard"|"\/portal"/.test(sw));
  check(
    "the offline page's link to the full page says ?online=1, and the worker then waits for the network instead of handing back to it",
    /searchParams\.has\("online"\)\s*\?\s*0/.test(sw) && /online=1/.test(shellPage),
  );
  check("the cache name was bumped when the rules changed", /school-os-v([3-9]|\d\d)/.test(sw));

  // The cached page must carry nothing about anybody.
  check(
    "the offline page reads no session, no database and no school or person",
    !/requireAuth|requireRole|getSessionUser|prisma|schoolName|auth\.|cookies\(/.test(shellPage),
  );
  check("it sits outside both layouts that print the school's name", !/\(app\)|\(portal\)/.test("src/app/attendance-offline/page.tsx"));

  // The phone's copy is wiped when it should be.
  check("signing out wipes the phone", /wipeAll\(\)/.test(code("src/app/sign-out-button.tsx")) && /SignOutButton/.test(layout) && !/action=\{logout\}/.test(layout));
  check("a different person signing in wipes it first", /stored\.userId !== who\.userId[\s\S]{0,120}wipeAll\(\)/.test(code("src/lib/offline-store.ts")));
  check("the signed-in layout claims the phone for the person using it", /OfflineSync[\s\S]{0,200}who=\{\{\s*userId:\s*auth\.userId,\s*schoolId:\s*auth\.schoolId/.test(layout));
  check("unsent work is never pruned, only abandoned drafts", /status === "draft"/.test(code("src/lib/offline-store.ts")));
}

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
