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

import { Prisma, PrismaClient } from "@prisma/client";
import { ROLE_ATTRIBUTES_SQL, roleProblem, type RoleAttributes } from "@/lib/db-role";
import { prisma, tenantTransaction, TenantContextMissingError } from "@/lib/prisma";
import { runWithTenantContext, withBypass } from "@/lib/tenant-context";
import { demoSchool } from "./fixture.mjs";

let passed = 0;
let failed = 0;

/** The owner's connection, when there is one: exempt from policies by design. */
let owner = null as PrismaClient | null;

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

  // The role itself, before any policy. Every check below is meaningless if the
  // connection is one Postgres exempts from policies: `APP_DATABASE_URL is set`
  // is satisfied by the owner's string just as well as by the restricted role's.
  const appRows = await retry(() =>
    withBypass(() => prisma.$queryRawUnsafe<RoleAttributes[]>(ROLE_ATTRIBUTES_SQL)),
  );
  const appProblem = roleProblem(appRows[0]);
  check(
    "the app connects as a role that obeys row security",
    appProblem === null,
    appProblem ?? `${appRows[0].name}: no superuser, no BYPASSRLS`,
  );

  // And the same test must FLAG the owner, or "no problem found" proves nothing:
  // a verdict that cannot say no passes whatever it is shown. The owner connection
  // is also the sweep's source of truth below, so it stays open until the end.
  // Skipped, and said so, when there is no separate owner connection to try.
  const ownerUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!ownerUrl || ownerUrl === process.env.APP_DATABASE_URL) {
    console.log("  --   no separate owner connection, so the verdict is not tried against one");
  } else {
    owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
    const ownerRows = await retry(() => owner!.$queryRawUnsafe<RoleAttributes[]>(ROLE_ATTRIBUTES_SQL));
    check(
      "the same test flags the OWNER role",
      roleProblem(ownerRows[0]) !== null,
      `${ownerRows[0]?.name}: superuser=${ownerRows[0]?.rolsuper}, bypassrls=${ownerRows[0]?.rolbypassrls}`,
    );
  }

  // Coverage first. Every check below proves isolation for the tables it names,
  // and proves nothing about a table added since. This is how AssessmentTemplate
  // shipped unprotected: `npm run db:rls` enumerates tables dynamically, so it
  // was never wrong — it simply was not re-run after the migration that added
  // one, and every school's settings screen then listed every other school's
  // assessment components.
  const unprotected = await retry(() =>
    withBypass(() =>
      prisma.$queryRawUnsafe<{ table: string; rls: boolean; forced: boolean; policies: bigint }[]>(`
        select c.relname as table,
               c.relrowsecurity as rls,
               c.relforcerowsecurity as forced,
               (select count(*) from pg_policies p
                 where p.schemaname = 'public' and p.tablename = c.relname) as policies
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join information_schema.columns col
          on col.table_schema = 'public'
         and col.table_name = c.relname
         and col.column_name = 'schoolId'
        where n.nspname = 'public' and c.relkind = 'r'
          -- Same exclusions as scripts/apply-rls.mjs: sign-in happens before a
          -- tenant is known, so the auth tables cannot be tenant-scoped.
          and c.relname not in ('User', 'Session')
          and (not c.relrowsecurity or not c.relforcerowsecurity
               or (select count(*) from pg_policies p
                    where p.schemaname = 'public' and p.tablename = c.relname) = 0)
        order by c.relname
      `),
    ),
  );
  check(
    "every table with a schoolId carries RLS, FORCE and a policy",
    unprotected.length === 0,
    unprotected.length === 0
      ? "no gaps"
      : `${unprotected.map((row) => row.table).join(", ")} — run npm run db:rls`,
  );

  const schools = await retry(() =>
    withBypass(() => prisma.school.findMany({ select: { id: true, name: true } })),
  );
  check("the bypass path can read across tenants", schools.length > 0, `${schools.length} schools`);
  if (schools.length === 0) {
    return;
  }

  // ⚠️ Never `schools[0]`: the list is unordered, and a development database
  // collects empty qa-* schools, so the first row is a coin flip between the
  // seeded school and an empty shell. See scripts/fixture.mts.
  const school = await demoSchool();
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

  /**
   * ⚠️ This used to assert that a query with NO tenant set "sees nothing", and
   * seeing nothing is exactly what kept the failure invisible: an empty context
   * makes every policy fail to match, so the answer is an empty result that
   * reads as "this school has none". src/lib/prisma.ts now refuses such a query
   * outright, and the refusal is the stronger property — an unscoped read is
   * never a legitimate thing to have asked for.
   */
  let unscopedRefused = false;
  let unscopedRows = -1;
  try {
    unscopedRows = await prisma.student.count({ where: { deletedAt: null } });
  } catch (error) {
    unscopedRefused = error instanceof TenantContextMissingError;
  }
  check(
    "a query with no tenant set is REFUSED, not answered with nothing",
    unscopedRefused,
    unscopedRefused ? "TenantContextMissingError" : `answered with ${unscopedRows} rows`,
  );

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

  await sweepEveryTable(school.id);
}

/**
 * Every tenant table, not the three above.
 *
 * The checks before this prove the policy TEMPLATE behaves on Student, Guardian
 * and Invoice. Every table's policy is generated from that one template, so that
 * is strong evidence — and still only evidence: coverage (the first check) says a
 * policy EXISTS on the other 55, not that it does anything. This asks each one
 * the two questions that matter, as the restricted role:
 *
 *   - school A sees exactly the rows whose owner is A, however many rows other
 *     schools hold in the same table;
 *   - a school that does not exist sees none.
 *
 * Counts are taken inside ONE transaction per school, so the GUC is set once and
 * the sweep costs 3 round trips of setup plus one cheap query per table, rather
 * than a transaction per table.
 */
async function sweepEveryTable(schoolId: string) {
  // The same exclusions as apply-rls.mjs: sign-in happens before a tenant is
  // known, so User and Session cannot be scoped (see CLAUDE.md, Tenancy).
  const tables = Prisma.dmmf.datamodel.models
    .filter((m) => m.name === "School" || m.fields.some((f) => f.name === "schoolId"))
    .filter((m) => m.name !== "User" && m.name !== "Session")
    .map((m) => ({ table: m.dbName ?? m.name, column: m.name === "School" ? "id" : "schoolId" }));

  const sweep = { timeout: 180_000, maxWait: 30_000 };

  const visibleTo = (id: string) =>
    retry(() =>
      tenantTransaction(
        id,
        async (tx) => {
          const counts = new Map<string, number>();
          for (const { table } of tables) {
            const rows = await tx.$queryRawUnsafe<{ n: number }[]>(
              `select count(*)::int as n from "${table}"`,
            );
            counts.set(table, rows[0].n);
          }
          return counts;
        },
        sweep,
      ),
    );

  /**
   * What exists, by owner of the row.
   *
   * ⚠️ Read through the OWNER connection, which Postgres exempts from policies, and
   * not through the app role with the bypass lifted. The first version did the
   * latter, and forcing it red showed the flaw: a policy rewritten to drop its
   * bypass clause hid the rows from the "what exists" count as well, so "sees 0,
   * owns 0" agreed with itself and the broken table passed. The source of truth
   * must not depend on the policies under test.
   */
  const countOwners = async (table: string, column: string) => {
    const sql = `select count(*) filter (where "${column}" = $1)::int as mine,
                        count(*) filter (where "${column}" <> $1)::int as others
                   from "${table}"`;
    const rows = owner
      ? await owner.$queryRawUnsafe<{ mine: number; others: number }[]>(sql, schoolId)
      : await withBypass(() =>
          tenantTransaction(
            schoolId,
            (tx) => tx.$queryRawUnsafe<{ mine: number; others: number }[]>(sql, schoolId),
            sweep,
          ),
        );
    return rows[0];
  };
  if (!owner) {
    console.log(
      "  --   no owner connection: the expected counts come through the bypass, which depends on the policies under test",
    );
  }
  const truth = new Map<string, { mine: number; others: number }>();
  for (const { table, column } of tables) {
    truth.set(table, await retry(() => countOwners(table, column)));
  }

  const seenByMe = await visibleTo(schoolId);
  const seenByStranger = await visibleTo("no-such-school-id");

  const leaks = tables
    .filter(({ table }) => seenByMe.get(table) !== truth.get(table)?.mine)
    .map(({ table }) => `${table} (sees ${seenByMe.get(table)}, owns ${truth.get(table)?.mine})`);
  const strangers = tables
    .filter(({ table }) => seenByStranger.get(table) !== 0)
    .map(({ table }) => `${table} (${seenByStranger.get(table)} rows)`);

  check(
    "every tenant table: a school sees exactly its own rows",
    leaks.length === 0,
    leaks.length === 0 ? `${tables.length} tables` : leaks.join(", "),
  );
  check(
    "every tenant table: a school that does not exist sees none",
    strangers.length === 0,
    strangers.length === 0 ? `${tables.length} tables` : strangers.join(", "),
  );

  // Not vacuous: a sweep over empty tables passes whatever the policies say.
  const populated = tables.filter(({ table }) => (truth.get(table)?.mine ?? 0) > 0).length;
  check(
    "the sweep had rows to protect",
    populated >= 10,
    `${populated} of ${tables.length} tables hold rows for this school`,
  );

  // Said, not hidden: with one school in the database the first check above
  // cannot tell a policy from "there is nobody else here". Not a failure.
  const crossed = tables.filter(({ table }) => (truth.get(table)?.others ?? 0) > 0).length;
  console.log(
    crossed > 0
      ? `  --   ${crossed} of ${tables.length} tables also hold another school's rows, so separation was tested there`
      : "  --   only one school holds data here, so separation from other schools rests on the second check alone",
  );
}

try {
  await main();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
} finally {
  await owner?.$disconnect();
  await prisma.$disconnect();
}
