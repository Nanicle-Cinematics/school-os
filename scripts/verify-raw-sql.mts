/**
 * No string-built SQL anywhere in the app, except the two statements prisma.ts owns.
 *
 * Why this is a guard and not a convention. Row-level security binds a query to a
 * school through two transaction-local settings, `app.school_id` and
 * `app.bypass_rls`, and the policy reads the second one: `bypass_rls = 'on'`
 * passes every row. Any code path that can run an arbitrary SQL string can
 * therefore lift isolation for itself in one statement —
 * `select set_config('app.bypass_rls', 'on', true)` — and then read every school.
 * Row security defends against a query that forgot its `where schoolId`. It does
 * not defend against an injected statement, and the only way to keep that true
 * cheaply is for no statement to be built from a string.
 *
 * So today's raw SQL is 3 tagged templates (advisory locks), where Prisma binds
 * every `${}` as a parameter, and 2 fixed strings inside src/lib/prisma.ts (the
 * setting itself, and the question about the connected role). This fails on
 * anything else: `$queryRawUnsafe`, `$executeRawUnsafe` or `Prisma.raw`. A
 * deliberate new use belongs in prisma.ts, where it is reviewed with the code
 * that sets the bypass, or earns an exception here with a reason.
 *
 * Scripts are not scanned: they run as an operator, on purpose, against a database
 * chosen by the operator.
 *
 *   npm run verify:raw-sql
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The only file allowed to build SQL from a string. Fixed strings, no input. */
const ALLOWED = new Set([join("src", "lib", "prisma.ts")]);

const FORBIDDEN = [
  { pattern: /\$queryRawUnsafe\b/, name: "$queryRawUnsafe" },
  { pattern: /\$executeRawUnsafe\b/, name: "$executeRawUnsafe" },
  { pattern: /\bPrisma\s*\.\s*raw\b/, name: "Prisma.raw" },
];

/**
 * Code with the COMMENTS TAKEN OUT — the same function, for the same reason, as
 * scripts/verify-settings.mts. This codebase comments heavily enough that the
 * paragraph explaining why a call is dangerous names the call, and a scan that
 * reads comments would fail on its own explanation (or, worse, be satisfied by it).
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(path)) {
      out.push(path);
    }
  }
  return out;
}

const files = sourceFiles("src");
const found: string[] = [];

for (const path of files) {
  if (ALLOWED.has(path)) {
    continue;
  }
  const lines = code(readFileSync(path, "utf8")).split("\n");
  lines.forEach((line, index) => {
    for (const { pattern, name } of FORBIDDEN) {
      if (pattern.test(line)) {
        found.push(`${path}:${index + 1}  ${name}`);
      }
    }
  });
}

// Not vacuous: a scan that read no files, or could not see the allowed file's own
// calls, would pass whatever the source says.
const prismaText = code(readFileSync(join("src", "lib", "prisma.ts"), "utf8"));
const sawOwn = /\$executeRawUnsafe\b/.test(prismaText) && /\$queryRawUnsafe\b/.test(prismaText);

console.log(`scanned ${files.length} files under src/`);
if (files.length < 100 || !sawOwn) {
  console.error(
    `FAIL the scan is not seeing the source (${files.length} files; prisma.ts calls visible: ${sawOwn}). ` +
      "A guard that reads nothing passes everything.",
  );
  process.exitCode = 1;
} else if (found.length > 0) {
  console.error("\nSTRING-BUILT SQL OUTSIDE src/lib/prisma.ts:");
  for (const hit of found) {
    console.error(`  ${hit}`);
  }
  console.error(
    "\nUse a tagged template ($queryRaw`… ${value} …`), where Prisma binds every value,\n" +
      "or the Prisma client's own methods. See the comment at the top of this script for why.",
  );
  process.exitCode = 1;
} else {
  console.log("ok   no $queryRawUnsafe, $executeRawUnsafe or Prisma.raw outside src/lib/prisma.ts");
}
