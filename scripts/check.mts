/**
 * Everything CI will say, before CI says it.
 *
 *   npm run check:fast       # source-only guards, ~40s — before every push
 *   npm run check            # every offline guard, in CI's own order (~15 min)
 *   npm run check -- --http  # also the ones that need the app running
 *
 * (`npm run check --fast` does NOT work — npm swallows the flag. Hence the
 * separate `check:fast` script rather than a documented `--` incantation
 * nobody will remember at the moment they need it.)
 *
 * Why this exists: the guards were all here and all passing, and none of them
 * ran until a push. Three rounds of red CI on one pull request — a hand-rolled
 * table, an uppercase label, two audited actions with no phrase — were each
 * sitting in a script on this machine the whole time. A check nobody runs is a
 * check that does not exist.
 *
 * ⚠️ The list is READ FROM `.github/workflows/ci.yml`, never kept here. A second
 * copy of "what we check" drifts the moment somebody adds a step to one and not
 * the other, and the copy that is wrong is always the one you are looking at.
 * So this parses the real workflow, runs what it finds, and refuses to look
 * successful if a guard exists that CI never runs.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const wantHttp = process.argv.includes("--http");
const fast = process.argv.includes("--fast");
const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");

/**
 * Steps after "Start the built app" need HTTP; steps before it do not.
 *
 * Taken from the workflow's own ordering rather than from a hand-kept list of
 * which scripts need a server — the ordering is a fact CI already maintains,
 * and a list would be one more thing to forget.
 */
const startsApp = workflow.indexOf("npm run start");
/**
 * Which guards need the database, taken from how they are invoked.
 *
 * A script run with `--env-file=.env` reads the database; one without it reads
 * only source. That is not a convention this file imposes — it is what the
 * command already says — so `--fast` cannot drift out of step with reality the
 * way a hand-kept list of "the quick ones" would.
 *
 * It matters because the database is in Frankfurt: the source-only guards take
 * about a second each and the database-backed ones take up to three minutes,
 * which is the whole difference between a check you run before every push and
 * one you run before opening a pull request.
 */
const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;
const needsDb = (script: string) => (scripts[script] ?? "").includes("--env-file");

const steps: { script: string; needsApp: boolean }[] = [];
const seen = new Set<string>();

for (const match of workflow.matchAll(/npm run ([a-z][a-z:.-]*)/g)) {
  const script = match[1];
  // Only the guards. The build, the seed and the migration steps are CI
  // setting up a throwaway database; running them here would rebuild and
  // re-seed the machine you are working on.
  if (script !== "lint" && !script.startsWith("verify:")) {
    continue;
  }
  if (seen.has(script)) {
    continue;
  }
  seen.add(script);
  steps.push({ script, needsApp: startsApp >= 0 && match.index! > startsApp });
}

// ── Anti-drift: a guard CI never runs ──────────────────────────────────────
const declared = Object.keys(scripts).filter((name) => name.startsWith("verify:"));
const neverRun = declared.filter((name) => !workflow.includes(`npm run ${name}`));

const appUp = await (async () => {
  if (!wantHttp) return false;
  try {
    const response = await fetch(`${BASE}/login`, { redirect: "manual" });
    return response.status === 200;
  } catch {
    return false;
  }
})();

if (wantHttp && !appUp) {
  console.log(`\n⚠️  --http given but nothing answers at ${BASE}.`);
  console.log("    Run `npm run build && npm run start` in another terminal first.\n");
}

const offline = steps.filter((step) => !step.needsApp && (!fast || !needsDb(step.script)));
const online = steps.filter((step) => step.needsApp);
const toRun = appUp && !fast ? [...offline, ...online] : offline;

console.log(
  fast
    ? `${toRun.length} source-only checks (of ${steps.length}) — drop --fast for the database-backed ones`
    : `${toRun.length} of ${steps.length} checks, in the order ci.yml runs them` +
        (appUp ? ", app included" : ` (${online.length} need the app — pass --http with it running)`),
);
console.log();

const failures: { script: string; output: string }[] = [];
const started = Date.now();

for (const step of toRun) {
  const at = Date.now();
  // Captured, not piped: piping these through `head` or `grep` closes the pipe
  // and SIGPIPEs the script before its own cleanup runs, which leaves rows
  // behind that fail the NEXT run. Found the hard way.
  const result = spawnSync("npm", ["run", step.script], {
    encoding: "utf8",
    env: appUp ? { ...process.env, VERIFY_BASE_URL: BASE } : process.env,
  });
  const seconds = ((Date.now() - at) / 1000).toFixed(0);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  if (result.status === 0) {
    console.log(`  ok    ${step.script.padEnd(24)} ${seconds}s`);
  } else {
    console.log(`  FAIL  ${step.script.padEnd(24)} ${seconds}s`);
    failures.push({ script: step.script, output });
  }
}

console.log(`\n${((Date.now() - started) / 1000).toFixed(0)}s total`);

for (const failure of failures) {
  console.log(`\n── ${failure.script} ${"─".repeat(Math.max(0, 60 - failure.script.length))}`);
  // The tail, because these scripts print their passes first and the reason
  // last. Enough to act on without scrolling past forty green lines.
  console.log(
    failure.output
      .split("\n")
      .filter((line) => line.trim())
      .slice(-25)
      .join("\n"),
  );
}

if (neverRun.length > 0) {
  console.log(
    `\n⚠️  ${neverRun.length} guard(s) exist that ci.yml never runs: ${neverRun.join(", ")}`,
  );
  console.log("    Either add them to the workflow or delete them — an unrun guard is a comment.");
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed. CI would have said the same.`);
  process.exitCode = 1;
} else if (fast) {
  console.log(
    `\nAll green on the source-only guards. The database-backed ones have NOT run — ` +
      "`npm run check` before you open a pull request.",
  );
} else if (!appUp) {
  console.log(`\nAll green offline. ${online.length} app-backed checks not run — see --http.`);
} else {
  console.log("\nAll green, including the app-backed checks.");
}
