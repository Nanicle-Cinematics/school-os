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
          -- User carries a schoolId and is covered here like any tenant table;
          -- Session has none and is checked with it in authTables() below.
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
  await authTables(school.id);
}

/** Thrown to roll a probe back: the count it carries is the answer. */
class Rollback extends Error {
  constructor(readonly count: number) {
    super("rollback");
  }
}

/**
 * User and Session: a school sees its own people, and nobody else's.
 *
 * Until 2026-10-10 neither table had a policy, so from any school's context the app
 * role could read every login's password hash, TOTP secret and recovery-code hashes
 * and every session token hash in the database. Their policies are not the generic
 * `schoolId = current school` one (sign-in happens before a school is known), so the
 * sweep above leaves them out and they are proved separately, as the restricted role:
 *
 *   - a school sees exactly the logins that are its own (home school, or a membership
 *     there) and exactly their sessions, whoever else is in the table;
 *   - a school that does not exist sees none of either;
 *   - a school cannot read or change anyone else's login or sessions, and cannot
 *     create or move a session at all.
 *
 * What exists is read through the OWNER connection, for the reason the sweep does:
 * the truth must not depend on the policies under test. Every write is attempted
 * inside a transaction that is rolled back, so a missing policy cannot cost a real
 * login its sessions.
 */
async function authTables(schoolId: string) {
  console.log("\nLogins and sessions");
  if (!owner) {
    console.log("  --   no owner connection, so what each school should see cannot be established");
    return;
  }
  const ownerDb = owner;

  const covered = await retry(() =>
    ownerDb.$queryRawUnsafe<{ table: string; rls: boolean; forced: boolean; policies: number }[]>(`
      select c.relname as table, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
             (select count(*)::int from pg_policies p
               where p.schemaname = 'public' and p.tablename = c.relname) as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and c.relname in ('User', 'Session')
       order by c.relname
    `),
  );
  const gaps = covered.filter((row) => !row.rls || !row.forced || row.policies === 0);
  check(
    "User and Session carry RLS, FORCE and a policy",
    covered.length === 2 && gaps.length === 0,
    gaps.length ? `${gaps.map((g) => g.table).join(", ")} — run npm run db:rls` : "both",
  );

  const rowsOf = async (sql: string, ...args: string[]) =>
    new Set((await retry(() => ownerDb.$queryRawUnsafe<{ id: string }[]>(sql, ...args))).map((r) => r.id));
  const usersOf = (id: string) =>
    rowsOf(
      `select u.id from "User" u where u."schoolId" = $1
         or exists (select 1 from "Membership" m where m."userId" = u.id and m."schoolId" = $1)`,
      id,
    );
  const sessionsOf = (id: string) =>
    rowsOf(
      `select s.id from "Session" s where s."activeSchoolId" = $1
         or exists (select 1 from "Membership" m where m."userId" = s."userId" and m."schoolId" = $1)`,
      id,
    );

  const mineUsers = await usersOf(schoolId);
  const mineSessions = await sessionsOf(schoolId);
  const allUsers = await rowsOf(`select id from "User"`);
  const allSessions = await rowsOf(`select id from "Session"`);

  const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
  const idsOf = (rows: { id: string }[]) => new Set(rows.map((r) => r.id));

  const seenUsers = idsOf(await retry(() => tenant(schoolId, () => prisma.user.findMany({ select: { id: true } }))));
  const seenSessions = idsOf(await retry(() => tenant(schoolId, () => prisma.session.findMany({ select: { id: true } }))));
  check(
    "a school sees exactly its own logins",
    sameSet(seenUsers, mineUsers),
    `sees ${seenUsers.size}, owns ${mineUsers.size}, table holds ${allUsers.size}`,
  );
  check(
    "a school sees exactly its own people's sessions",
    sameSet(seenSessions, mineSessions),
    `sees ${seenSessions.size}, owns ${mineSessions.size}, table holds ${allSessions.size}`,
  );

  const strangerUsers = await retry(() => tenant("no-such-school-id", () => prisma.user.count()));
  const strangerSessions = await retry(() => tenant("no-such-school-id", () => prisma.session.count()));
  check("a school that does not exist sees no logins", strangerUsers === 0, `${strangerUsers} rows`);
  check("a school that does not exist sees no sessions", strangerSessions === 0, `${strangerSessions} rows`);

  const viaBypass = await retry(() => withBypass(() => prisma.user.count()));
  check("the bypass still sees every login", viaBypass === allUsers.size, `${viaBypass} of ${allUsers.size}`);

  // Not vacuous: with every login belonging to this school the checks above cannot
  // tell a policy from "there is nobody else here".
  const outsiders = [...allUsers].filter((id) => !mineUsers.has(id));
  const outsiderSessions = [...allSessions].filter((id) => !mineSessions.has(id));
  if (outsiders.length === 0) {
    console.log("  --   every login here belongs to this school, so separation from other logins was not tested");
  } else {
    const outsider = outsiders[0];
    const found = await retry(() => tenant(schoolId, () => prisma.user.findUnique({ where: { id: outsider } })));
    check("another school's login cannot be read by id", found === null);

    const probe = async (fn: (tx: TenantTxLike) => Promise<{ count: number }>) => {
      try {
        await tenantTransaction(schoolId, async (tx) => {
          throw new Rollback((await fn(tx)).count);
        });
      } catch (error) {
        if (error instanceof Rollback) return error.count;
        throw error;
      }
      return -1;
    };

    check(
      "another school's login cannot be changed",
      (await probe((tx) => tx.user.updateMany({ where: { id: outsider }, data: { name: "isolation probe" } }))) === 0,
    );
    if (outsiderSessions.length > 0) {
      check(
        "another school's sessions cannot be ended",
        (await probe((tx) => tx.session.deleteMany({ where: { id: { in: outsiderSessions } } }))) === 0,
      );
    } else {
      console.log("  --   no session belongs to another school here, so ending one was not tested");
    }
  }

  // A tenant never creates or moves a session. Tried with a REAL member's id, so the
  // refusal is the policy's and not a missing foreign key.
  const member = [...mineUsers][0];
  if (member) {
    const created = await (async () => {
      try {
        await tenantTransaction(schoolId, async (tx) => {
          await tx.session.create({
            data: { userId: member, tokenHash: `isolation-probe-${Date.now()}`, expiresAt: new Date(Date.now() + 60_000) },
          });
          throw new Rollback(1);
        });
      } catch (error) {
        return error instanceof Rollback;
      }
      return false;
    })();
    check("a school cannot create a session", !created);
  }

  // The legitimate path must still work, or every refusal above is a broken table
  // rather than a policy: a school can end its own member's sessions.
  if (member) {
    const token = `isolation-control-${Date.now()}`;
    const row = await retry(() =>
      ownerDb.session.create({ data: { userId: member, tokenHash: token, expiresAt: new Date(Date.now() + 60_000) } }),
    );
    try {
      const ended = await tenantTransaction(schoolId, async (tx) => {
        try {
          const gone = await tx.session.deleteMany({ where: { id: row.id } });
          throw new Rollback(gone.count);
        } catch (error) {
          if (error instanceof Rollback) return error.count;
          throw error;
        }
      });
      check("control: a school can end its own member's session", ended === 1, `${ended} of 1`);
    } finally {
      await ownerDb.session.deleteMany({ where: { id: row.id } });
    }
  }

  // Refused, not answered with nothing: Session has no schoolId, so it needed adding to
  // the guard's list by hand, and this is what notices if that is undone.
  let refused = false;
  try {
    await prisma.session.count();
  } catch (error) {
    refused = error instanceof TenantContextMissingError;
  }
  check("a session query with no tenant set is REFUSED, not answered with nothing", refused);
}

type TenantTxLike = Parameters<Parameters<typeof tenantTransaction>[1]>[0];

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
  // User and Session are scoped by their own policies, not this template, and are
  // proved separately in authTables() below.
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
