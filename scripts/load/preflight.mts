/**
 * Refuse to run unless the load test's target is provably a throwaway.
 *
 * Every `load:*` script goes through this FIRST, and the seed and the runner call
 * `requireSafeTarget()` themselves as well, so running one of them directly with `tsx` skips
 * nothing. See guard.mts for what is refused and why.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assessTarget, forbiddenFromEnvText } from "./guard.mjs";

const ROOT = resolve(import.meta.dirname, "../..");

/** Every place this checkout knows about that must never be loaded. */
export function forbiddenTargets(): string[] {
  const found: string[] = [];
  for (const file of [".env", ".env.prod", ".env.local", ".env.production"]) {
    const path = resolve(ROOT, file);
    if (existsSync(path)) found.push(...forbiddenFromEnvText(readFileSync(path, "utf8")));
  }
  return found;
}

export function requireSafeTarget(): void {
  const verdict = assessTarget({
    databaseUrl: process.env.DATABASE_URL,
    directUrl: process.env.DIRECT_URL,
    appDatabaseUrl: process.env.APP_DATABASE_URL,
    baseUrl: process.env.LOAD_BASE_URL,
    forbiddenUrls: forbiddenTargets(),
    allowRemote: process.env.LOAD_ALLOW_REMOTE,
    confirmTarget: process.env.LOAD_CONFIRM_TARGET,
    smsDryRun: process.env.SMS_DRY_RUN,
  });
  for (const note of verdict.notes) console.log(`  note  ${note}`);
  if (!verdict.ok) {
    console.error("\nThe load test will not run against this target:\n");
    for (const problem of verdict.problems) console.error(`  - ${problem}`);
    console.error("\nIt writes a great deal and drives the app as hard as it can. Point .env.load at a throwaway database and a local server.\n");
    process.exit(1);
  }
  console.log("  ok    the target is a throwaway: not dev, not production");
}

if (process.argv[1] && /preflight\.mts$/.test(process.argv[1])) {
  requireSafeTarget();
}
