/**
 * The load test must not be pointable at anything that matters.
 *
 *   npm run verify:load-guard
 *
 * Pure: no database, no server. A guard that has only ever said "yes" proves nothing, so the
 * first check is a target it MUST accept, and every refusal after it is the same target with ONE
 * thing made wrong, so a refusal that fires for the wrong reason cannot hide behind another.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assessTarget, dbIdentity, forbiddenFromEnvText, projectRef, type GuardInput } from "./load/guard.mjs";
import { DEFAULT_BUDGET, judge, percentile, summarise, type Sample } from "./load/stats.mjs";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}
const root = resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");
/** Source with comments removed: this codebase explains its own mistakes at length, and a word in a comment is not a call. */
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// What dev and production look like, as this checkout's env files hold them.
const DEV_POOLER = "postgresql://postgres.devref12345:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true";
const DEV_DIRECT = "postgresql://postgres:pw@db.devref12345.supabase.co:5432/postgres";
const PROD_POOLER = "postgresql://postgres.prodref67890:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres";
const FORBIDDEN = [DEV_POOLER, DEV_DIRECT, PROD_POOLER, "https://www.schoolosafrica.com", "http://localhost:3000"];

const LOCAL = "postgresql://postgres:postgres@localhost:5432/school_os_load";
const GOOD: GuardInput = {
  databaseUrl: LOCAL,
  directUrl: LOCAL,
  appDatabaseUrl: "postgresql://school_os_app:x@localhost:5432/school_os_load?connection_limit=4",
  baseUrl: "http://localhost:3100",
  forbiddenUrls: FORBIDDEN,
  allowRemote: undefined,
  confirmTarget: undefined,
  smsDryRun: "1",
};
const with_ = (change: Partial<GuardInput>): GuardInput => ({ ...GOOD, ...change });
const refuses = (change: Partial<GuardInput>, fragment: RegExp) => {
  const verdict = assessTarget(with_(change));
  return !verdict.ok && verdict.problems.some((p) => fragment.test(p));
};

console.log("A throwaway is accepted");
check("a local database named for the purpose, a local server, SMS dry-run", assessTarget(GOOD).ok, assessTarget(GOOD).problems.join(" | "));

console.log("\nEach refusal, on its own");
check("a local database that is not NAMED as a throwaway", refuses({ databaseUrl: "postgresql://postgres:postgres@localhost:5432/school_os", directUrl: "postgresql://postgres:postgres@localhost:5432/school_os", appDatabaseUrl: "postgresql://a:b@localhost:5432/school_os" }, /throwaway one so it says/));
check("dev's pooler, by its pooler URL", refuses({ databaseUrl: DEV_POOLER }, /own env files use/));
check("dev's direct host when only its POOLER is on file: the same project under its other name", refuses({ directUrl: DEV_DIRECT, forbiddenUrls: [DEV_POOLER] }, /own env files use/));
check("and the pooler when only the direct host is on file", refuses({ databaseUrl: DEV_POOLER, forbiddenUrls: [DEV_DIRECT] }, /own env files use/));
check("production, even with the remote switch and a matching confirmation", refuses({ databaseUrl: PROD_POOLER, allowRemote: "yes", confirmTarget: "prodref67890" }, /own env files use/));
check("dev, even with the remote switch and a matching confirmation", refuses({ appDatabaseUrl: DEV_DIRECT, forbiddenUrls: [DEV_POOLER], allowRemote: "yes", confirmTarget: "devref12345" }, /own env files use/));
const FRESH = "postgresql://postgres:pw@db.freshref00000.supabase.co:5432/postgres";
check("a remote database without LOAD_ALLOW_REMOTE", refuses({ databaseUrl: FRESH, directUrl: FRESH, appDatabaseUrl: FRESH }, /not on this machine/));
check("a remote database with the switch but no confirmation", refuses({ databaseUrl: FRESH, directUrl: FRESH, appDatabaseUrl: FRESH, allowRemote: "yes" }, /does not say so/));
check("a remote database confirmed with the WRONG ref", refuses({ databaseUrl: FRESH, directUrl: FRESH, appDatabaseUrl: FRESH, allowRemote: "yes", confirmTarget: "devref12345" }, /does not say so/));
check("a remote database that is not Supabase has no ref to confirm, so it is refused", refuses({ databaseUrl: "postgresql://a:b@db.example.com:5432/x", directUrl: "postgresql://a:b@db.example.com:5432/x", appDatabaseUrl: "postgresql://a:b@db.example.com:5432/x", allowRemote: "yes", confirmTarget: "x" }, /no project ref/));
check("a remote database, switched on and confirmed, IS accepted", assessTarget(with_({ databaseUrl: FRESH, directUrl: FRESH, appDatabaseUrl: FRESH, allowRemote: "yes", confirmTarget: "freshref00000", baseUrl: "https://load-preview.example.vercel.app" })).ok);
check("a missing DATABASE_URL", refuses({ databaseUrl: undefined }, /DATABASE_URL is missing/));
check("a missing APP_DATABASE_URL (the server would fall back to the owner and skip row security)", refuses({ appDatabaseUrl: undefined }, /APP_DATABASE_URL is missing/));
check("the three URLs naming different databases", refuses({ appDatabaseUrl: "postgresql://a:b@localhost:5432/school_os_load_two" }, /different databases/));
check("a server that is production", refuses({ baseUrl: "https://www.schoolosafrica.com", allowRemote: "yes" }, /production/));
check("a server on a subdomain of production", refuses({ baseUrl: "https://app.schoolosafrica.com", allowRemote: "yes" }, /production/));
check("a remote server without the switch", refuses({ baseUrl: "https://load.example.com" }, /not on this machine/));
check("no server address", refuses({ baseUrl: undefined }, /LOAD_BASE_URL is missing/));
check("SMS not forced to a dry run", refuses({ smsDryRun: undefined }, /SMS_DRY_RUN/));
check("SMS_DRY_RUN set to anything but 1", refuses({ smsDryRun: "0" }, /SMS_DRY_RUN/));

console.log("\nProject refs and identities");
check("the pooler and the direct host of one project give the SAME ref", projectRef(DEV_POOLER) === "devref12345" && projectRef(DEV_DIRECT) === "devref12345");
check("a local URL has no ref", projectRef(LOCAL) === null);
check("identity ignores credentials and query, and is case-blind", dbIdentity("postgresql://u:p@LocalHost:5432/Db?x=1") === dbIdentity("postgresql://other:q@localhost/db"));

console.log("\nReading env files");
const sample = [
  'DATABASE_URL="postgresql://u:p@host:6543/postgres?pgbouncer=true"',
  "DIRECT_URL=postgresql://u:p@host:5432/postgres",
  'APP_DATABASE_URL="postgresql://school_os_app.<ref>:<password>@host/db"',
  'SMS_API_KEY="secret-that-is-not-a-place"',
  "export APP_URL=http://localhost:3000",
].join("\n");
const found = forbiddenFromEnvText(sample);
check("takes the keys that name a place, quotes and `export` and all", found.length === 3 && found.includes("http://localhost:3000"), JSON.stringify(found));
check("ignores a placeholder (.env.example) and unrelated keys", !found.some((f) => f.includes("<ref>")) && !found.some((f) => f.includes("secret")));

console.log("\nThe env template is itself a valid target");
{
  const text = read(".env.load.example");
  const get = (key: string) => text.match(new RegExp(`^${key}="?([^"\\n]*)"?\\s*$`, "m"))?.[1];
  const verdict = assessTarget({
    databaseUrl: get("DATABASE_URL"),
    directUrl: get("DIRECT_URL"),
    appDatabaseUrl: get("APP_DATABASE_URL"),
    baseUrl: get("LOAD_BASE_URL"),
    forbiddenUrls: FORBIDDEN,
    allowRemote: get("LOAD_ALLOW_REMOTE"),
    confirmTarget: get("LOAD_CONFIRM_TARGET"),
    smsDryRun: get("SMS_DRY_RUN"),
  });
  check(".env.load.example passes the guard as written", verdict.ok, verdict.problems.join(" | "));
  check("and does not enable the remote switch", get("LOAD_ALLOW_REMOTE") === undefined);
}

console.log("\nStatistics");
check("nearest-rank percentiles", percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50) === 5 && percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95) === 10 && percentile([], 95) === 0);
{
  const fast: Sample[] = Array.from({ length: 20 }, () => ({ label: "fast page", kind: "page", ms: 100, status: 200, ok: true }));
  const slow: Sample[] = Array.from({ length: 20 }, () => ({ label: "slow page", kind: "page", ms: 9000, status: 200, ok: true }));
  check("a page over its p95 budget is named", judge(summarise([...fast, ...slow], 10), DEFAULT_BUDGET).some((f) => f.startsWith("slow page")));
  check("a page inside it is not", !judge(summarise(fast, 10), DEFAULT_BUDGET).length);
  const broken = [...fast, ...Array.from({ length: 5 }, () => ({ label: "fast page", kind: "page", ms: 100, status: 500, ok: false }) as Sample)];
  check("an error rate over budget fails the run", judge(summarise(broken, 10), DEFAULT_BUDGET).some((f) => /failed/.test(f)));
  check("a run that made no requests is a failure, not a pass", judge(summarise([], 10), DEFAULT_BUDGET).length > 0);
}

console.log("\nWiring");
{
  const pkg = JSON.parse(read("package.json")).scripts as Record<string, string>;
  const load = Object.entries(pkg).filter(([name]) => name.startsWith("load:"));
  check("the load scripts exist", ["seed", "run", "clean", "serve", "build", "migrate", "rls", "preflight"].every((n) => pkg[`load:${n}`]));
  const readsOtherEnv = (cmd: string) => /(--env-file=|with-env\.mjs\s+)\.env(?!\.load\b)/.test(cmd);
  check("none of them reads .env or .env.prod (only .env.load)", load.every(([, cmd]) => !readsOtherEnv(cmd)), load.filter(([, c]) => readsOtherEnv(c)).map(([n]) => n).join(", "));
  check("the ones that start the app load .env.load without --env-file (Next's workers reject the flag)", ["build", "serve"].every((n) => /with-env\.mjs \.env\.load/.test(pkg[`load:${n}`]!) && !/--env-file/.test(pkg[`load:${n}`]!)));
  check("every script that touches the app or the schema runs the preflight first", ["migrate", "rls", "build", "serve"].every((n) => /load:preflight/.test(pkg[`load:${n}`]!)));
  check("the seed and the runner call the guard themselves", /requireSafeTarget\(\)/.test(code("scripts/load/seed.mts")) && /requireSafeTarget\(\)/.test(code("scripts/load/run.mts")));
  const ignore = read(".gitignore");
  check(".env.load is ignored and only the example is not", /^\.env\*$/m.test(ignore) && /^!\.env\.load\.example$/m.test(ignore) && !/^!\.env\.load$/m.test(ignore));
  check("results are ignored", /^\/load-results\/$/m.test(ignore));
  check("the server is started on a port that is not the dev server's", /next start -p 3100/.test(pkg["load:serve"]!));
}

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
