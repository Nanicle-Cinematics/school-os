/**
 * What an unauthenticated route may spend: the budget, and that every public route is inside it.
 *
 * Pure: no database, no server. The HTTP half (a real crest, a real flood) is verify:school-icon.
 *
 * Two things are pinned. The BUDGET (`createLimiter` with a bounded queue, `publicLookup`): at most
 * two lookups at once, a short queue, and everything past it refused at once without leaking a slot.
 * And the SHAPE of the routes, read from source with comments stripped (this codebase explains its
 * mistakes at length, and the words would satisfy a search): every route handler that reads the
 * database with no session must go through the budget, which is what stops the NEXT public route
 * being written without one.
 *
 * Run: npm run verify:public-routes
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLimiter, LimiterFull } from "@/lib/concurrency";
import {
  PUBLIC_LOOKUPS,
  PUBLIC_QUEUE,
  busyResponse,
  isBusy,
  looksLikeSchoolId,
  MISS_CACHE_CONTROL,
} from "@/lib/public-route";

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}
const code = (path: string) =>
  readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

console.log("The limiter's bounded queue");
{
  const run = createLimiter(2, { maxWaiting: 3 });
  let running = 0;
  let peak = 0;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const task = async () => {
    running += 1;
    peak = Math.max(peak, running);
    await hold;
    running -= 1;
    return "done";
  };
  const calls = Array.from({ length: 8 }, () => run(task).then((v) => v, (e) => e));
  await tick();
  check("two run at once", running === 2, `${running}`);
  release();
  const results = await Promise.all(calls);
  const done = results.filter((r) => r === "done").length;
  const refused = results.filter((r) => r instanceof LimiterFull).length;
  check("two running plus three queued are served: five of eight", done === 5, `${done}`);
  check("and the other three are turned away at once with LimiterFull", refused === 3, `${refused}`);
  check("never more than two at once", peak === 2, `peak ${peak}`);

  // A refusal must not eat a slot: after the burst, two fresh calls must both start immediately.
  let started = 0;
  let free!: () => void;
  const gateTwo = new Promise<void>((resolve) => (free = resolve));
  const after = [run(async () => { started += 1; await gateTwo; }), run(async () => { started += 1; await gateTwo; })];
  await tick();
  check("a refused call leaks no slot: two new calls start straight away", started === 2, `${started}`);
  free();
  await Promise.all(after);

  const unbounded = createLimiter(1);
  let ok = 0;
  await Promise.all(Array.from({ length: 20 }, () => unbounded(async () => { ok += 1; })));
  check("without maxWaiting the queue is still unbounded (a campaign send relies on it)", ok === 20);

  const zero = createLimiter(1, { maxWaiting: 0 });
  let blocker!: () => void;
  const first = zero(() => new Promise<void>((resolve) => (blocker = resolve)));
  await tick();
  check("maxWaiting 0 means nothing may queue", await zero(async () => "x").then(() => false, (e) => e instanceof LimiterFull));
  blocker();
  await first;
  check("a bad maxWaiting is refused outright", (() => { try { createLimiter(1, { maxWaiting: -1 }); return false; } catch { return true; } })());
}

console.log("\nThe budget, as set");
check("two public lookups at once, which leaves two of the app role's four connections for everything else", PUBLIC_LOOKUPS === 2 && PUBLIC_LOOKUPS < 4);
check("a queue of eight: an install's manifest and three icons arrive together and must all be served", PUBLIC_QUEUE === 8 && PUBLIC_QUEUE >= 4);
check("isBusy recognises a full queue and nothing else", isBusy(new LimiterFull()) && !isBusy(new Error("x")) && !isBusy(null));
const busy = busyResponse();
check("a refusal is a 503 telling the caller to retry", busy.status === 503 && busy.headers.get("Retry-After") === "5");
check("and is never cached", busy.headers.get("Cache-Control") === "no-store");
check("a miss is cached publicly, so the CDN absorbs repeats", /public/.test(MISS_CACHE_CONTROL) && /max-age=300/.test(MISS_CACHE_CONTROL) && /s-maxage=300/.test(MISS_CACHE_CONTROL));

console.log("\nWhat can be a school id");
const real = "cmv6rypbh0001ta02wm0rzxgd";
check("a real cuid", looksLikeSchoolId(real));
check("a different id format is not locked out", looksLikeSchoolId("school_2026-demo") && looksLikeSchoolId("a1b2c3d4e5"));
for (const [label, value] of [
  ["empty", ""],
  ["too short", "abc"],
  ["a path", "../../etc/passwd"],
  ["a path with a valid-looking tail", "x/cmv6rypbh0001ta02wm0rzxgd"],
  ["spaces", "cmv6rypbh 0001ta02wm0rzxgd"],
  ["a null byte", "cmv6rypbh0001ta02wm0rzxgd%00"],
  ["a quote", "cmv6rypbh0001ta02wm0rzxg'"],
  ["too long", "a".repeat(41)],
  ["megabytes of junk", "a".repeat(2_000_000)],
  ["unicode", "cmv6rypbh0001ta02wm0rzxgé"],
] as const) {
  check(`${label} is refused before any query`, !looksLikeSchoolId(value));
}

console.log("\nEvery public route is inside the budget");
function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? routes(path) : /^route\.tsx?$/.test(name) ? [path] : [];
  });
}
const AUTH = /requireAuth|requireRole|activeSchoolId|getSessionUser|requireGuardian|requirePlatform/;
const all = routes("src/app");
const publicRoutes = all.filter((path) => {
  const src = code(path);
  return /prisma\./.test(src) && !AUTH.test(src);
});
check("the survey found the two public routes, not zero (a scan that finds nothing proves nothing)", publicRoutes.length >= 2, publicRoutes.join(", "));
for (const path of publicRoutes) {
  check(`${path} reads the database only through publicLookup`, /publicLookup\(/.test(code(path)));
}
check("every route that reads the database without a session is covered by the line above", publicRoutes.every((p) => /publicLookup\(/.test(code(p))));

console.log("\nThe icon route");
const icon = code("src/app/api/school-icon/[schoolId]/[variant]/route.ts");
const at = (needle: string) => icon.indexOf(needle);
check("a malformed id is refused BEFORE the budget or any query", at("looksLikeSchoolId(schoolId)") !== -1 && at("looksLikeSchoolId(schoolId)") < at("publicLookup("));
check("an unknown variant is refused before them too", at("!spec") !== -1 && at("!spec") < at("publicLookup("));
check("the blob read is INSIDE the budget", at("publicLookup(") !== -1 && at("publicLookup(") < at("prisma.schoolAsset"));
check("so is the decode and encode (the render call)", at("publicLookup(") < at("render(asset.bytes"));
check("a full queue answers 503", /isBusy\(error\)/.test(icon) && /busyResponse\(\)/.test(icon));
check("a miss is a cached 404", /status:\s*404[\s\S]{0,120}MISS_CACHE_CONTROL/.test(icon));
check("a real icon stays cached for a year, immutable", /public, max-age=31536000, immutable/.test(icon));

console.log("\nThe manifest route");
const manifest = code("src/app/api/manifest/route.ts");
const m = (needle: string) => manifest.indexOf(needle);
check("a missing or malformed school is sent to the static manifest before any query", m("looksLikeSchoolId(schoolId)") !== -1 && m("looksLikeSchoolId(schoolId)") < m("publicLookup("));
check("the school lookup is inside the budget", m("publicLookup(") !== -1 && m("publicLookup(") < m("prisma.school.findUnique"));
check("a full queue answers 503", /isBusy\(error\)/.test(manifest) && /busyResponse\(\)/.test(manifest));
check("the redirect to the static manifest is cached (Response.redirect cannot carry a header)", !/Response\.redirect/.test(manifest) && /MISS_CACHE_CONTROL/.test(manifest));

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
