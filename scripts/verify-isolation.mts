/**
 * Prove tenant isolation, using the app's own client and context modules.
 *
 * This is the check that would have caught the hole: for a long time the schema
 * carried `schoolId` everywhere and the code carried "RLS will scope this"
 * comments, while Postgres had no policies at all and every tenant could read
 * every other tenant's rows.
 *
 * It deliberately imports src/lib/prisma.ts and src/lib/tenant-context.ts rather
 * than reimplementing them, so it fails if either regresses — including the two
 * subtle ways this has already broken:
 *   - the GUC issued through a different client than the query, so they never
 *     share a transaction and set_config(..., true) is invisible;
 *   - the storage scope exited before the lazy Prisma promise executed, so the
 *     extension read an empty context.
 *
 * Requires DB_RLS=on and APP_DATABASE_URL pointing at the restricted role;
 * it says so rather than passing vacuously if they are missing.
 *
 *   npm run verify:isolation
 */

import { prisma } from "@/lib/prisma";
import { runWithTenantContext, withBypass } from "@/lib/tenant-context";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** The link here drops constantly; a dropped connection is not a verdict. */
async function retry<T>(fn: () => Promise<T>, tries = 8): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw last;
}

function tenant<T>(schoolId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, async () => await fn());
}

async function main() {
  if (process.env.DB_RLS !== "on") {
    console.error("DB_RLS is not 'on' — isolation is not being enforced. Nothing to verify.");
    process.exitCode = 1;
    return;
  }
  if (!process.env.APP_DATABASE_URL) {
    console.error(
      "APP_DATABASE_URL is unset, so the app connects as the owner, which bypasses RLS.",
    );
    process.exitCode = 1;
    return;
  }

  const schools = await retry(() =>
    withBypass(() => prisma.school.findMany({ select: { id: true, name: true } })),
  );
  check("the bypass path can read across tenants", schools.length > 0, `${schools.length} schools`);
  if (schools.length === 0) {
    return;
  }

  const [school] = schools;
  const foreign = "no-such-school-id";

  const mine = await retry(() =>
    tenant(school.id, () => prisma.student.count({ where: { deletedAt: null } })),
  );
  check("a tenant sees its own students", mine > 0, `${mine} in ${school.name}`);

  const theirs = await retry(() =>
    tenant(foreign, () => prisma.student.count({ where: { deletedAt: null } })),
  );
  check("a foreign tenant sees no students", theirs === 0, `${theirs} rows`);

  const guardians = await retry(() =>
    tenant(foreign, () => prisma.guardian.count({ where: { deletedAt: null } })),
  );
  check("a foreign tenant sees no guardians", guardians === 0, `${guardians} rows`);

  const invoices = await retry(() => tenant(foreign, () => prisma.invoice.count()));
  check("a foreign tenant sees no invoices", invoices === 0, `${invoices} rows`);

  const unscoped = await retry(() => prisma.student.count({ where: { deletedAt: null } }));
  check("a request with no tenant set sees nothing", unscoped === 0, `${unscoped} rows`);

  // WITH CHECK: writing a row into someone else's school must be refused, not
  // silently accepted and then invisible.
  let refused = false;
  try {
    await tenant(foreign, () =>
      prisma.house.create({ data: { schoolId: school.id, name: `isolation probe ${Date.now()}` } }),
    );
  } catch {
    refused = true;
  }
  check("writing into another tenant is refused", refused);

  const leaked = await retry(() =>
    withBypass(() => prisma.house.count({ where: { name: { startsWith: "isolation probe" } } })),
  );
  check("no probe row was written", leaked === 0, `${leaked} rows`);
}

try {
  await main();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
