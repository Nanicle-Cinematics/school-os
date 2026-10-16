/**
 * The owner's production scripts must not pick up dev's APP_DATABASE_URL.
 *
 * `npm run platform:prod` failed with "APP_DATABASE_URL and DATABASE_URL point at different Supabase
 * projects" because constructing a PrismaClient loads `.env` over the gaps `.env.prod` leaves. See
 * `scripts/owner-env.mts`. This runs a child process shaped like that script (production
 * DATABASE_URL in the environment, no APP_DATABASE_URL, then a PrismaClient is built) and asks which
 * project each URL names afterwards.
 *
 * Run: npm run verify:owner-env   (no database; source and a child process only)
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}
const ref = (url: string) => url.match(/^postgresql:\/\/[^.:]+\.([a-z0-9]+):/)?.[1] ?? "none";
const code = (path: string) =>
  readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const PROD = "postgresql://postgres.prodrefprodrefprodref:x@h.example:5432/postgres";

function run(preamble: boolean) {
  const probe = "scripts/_owner-env-probe.mts";
  writeFileSync(
    probe,
    `${preamble ? 'import "./owner-env.mts";\n' : ""}import { PrismaClient } from "@prisma/client";\nnew PrismaClient();\nconsole.log(JSON.stringify({ app: process.env.APP_DATABASE_URL ?? "", owner: process.env.DATABASE_URL ?? "" }));\n`,
  );
  try {
    const env = { ...process.env, DATABASE_URL: PROD } as NodeJS.ProcessEnv;
    delete env.APP_DATABASE_URL;
    const out = spawnSync("node_modules/.bin/tsx", [probe], { env, encoding: "utf8" });
    const line = out.stdout.trim().split("\n").pop() ?? "{}";
    return JSON.parse(line) as { app: string; owner: string };
  } finally {
    unlinkSync(probe);
  }
}

console.log("The preamble");
const without = run(false);
const leaks = without.app !== "" && ref(without.app) !== ref(without.owner);
// Positive control: where this machine's .env sets APP_DATABASE_URL, a bare PrismaClient really does
// put it in the environment, and that is what the preamble has to beat. Elsewhere (CI has none)
// there is nothing to leak, which is said rather than passed over.
console.log(`  ..    without the preamble, a client leaves the app URL as: ${without.app ? `project ${ref(without.app)} (owner is ${ref(without.owner)})` : "unset (no APP_DATABASE_URL in .env here, so the leak cannot be reproduced on this machine)"}`);
const withIt = run(true);
check("with it, the app URL names the SAME project as the owner URL, after a client is built", ref(withIt.app) === ref(withIt.owner) && ref(withIt.owner) === "prodrefprodrefprodref", `${ref(withIt.app)} vs ${ref(withIt.owner)}`);
if (leaks) check("(control) without it, the dev URL does leak in on this machine", leaks);

console.log("\nWho uses it");
const imports = (file: string) => code(file).split("\n").filter((l) => l.startsWith("import "))[0] ?? "";
check("platform.mts imports it before anything else", imports("scripts/platform.mts").includes("owner-env"));
check("recompute-results.mts imports it before anything else", imports("scripts/recompute-results.mts").includes("owner-env"));
check("it only fills a MISSING app URL (a deliberate one is left alone)", /!process\.env\.APP_DATABASE_URL/.test(code("scripts/owner-env.mts")));
check("prisma.ts still refuses a mismatch", /point at different Supabase projects/.test(code("src/lib/prisma.ts")));

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
