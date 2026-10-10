/**
 * Make tenant isolation real: a restricted role, RLS on every tenant table, and
 * a policy that reads the GUCs `src/lib/prisma.ts` already sets.
 *
 * Why a separate role. Prisma connects as `postgres`, which both OWNS the tables
 * and carries the BYPASSRLS attribute. Either alone defeats row security —
 * owners skip policies unless FORCE is set, and BYPASSRLS skips them even then.
 * So policies applied to that role are decoration. The app therefore gets its
 * own role that owns nothing and bypasses nothing, and connects through
 * APP_DATABASE_URL; `postgres` stays the owner for migrations, seeding and the
 * admin-side verify scripts, which should not be tenant-scoped.
 *
 * Idempotent: safe to re-run after adding tables.
 *
 *   npm run db:rls
 */

import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

// Connect as the owner: only it can create roles and policies.
const adminUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
const prisma = new PrismaClient({ datasources: { db: { url: adminUrl } } });

const APP_ROLE = process.env.APP_DB_ROLE ?? "school_os_app";

/** Tables the app may add to but never change. See the revoke below. */
const APPEND_ONLY = ["AuditLog", "JournalEntry", "JournalLine"];

/** Not application data at all. */
const UNSCOPED = new Set(["_prisma_migrations"]);

/**
 * The two auth tables. Sign-in happens before a tenant is known, so they cannot
 * use the generic `schoolId = current school` policy, and until 2026-10-10 they
 * had no policy at all: from any school's context the app role could read every
 * login's password hash, TOTP secret and recovery-code hashes, and every session
 * token hash in the database. They get policies of their own (see
 * enableAuthTables); every path that runs before a tenant is known already runs
 * under the bypass, which the policies honour like any other table's.
 */
const AUTH_TABLES = new Set(["User", "Session"]);

async function main() {
  const password = process.env.APP_DB_PASSWORD ?? randomBytes(18).toString("base64url");

  // 1. The restricted role.
  const exists = await prisma.$queryRawUnsafe(
    `select 1 from pg_roles where rolname = $1`,
    APP_ROLE,
  );
  if (exists.length === 0) {
    await prisma.$executeRawUnsafe(
      `create role "${APP_ROLE}" with login password '${password}' nobypassrls`,
    );
    console.log(`created role ${APP_ROLE}`);
    console.log(`\n  APP_DATABASE_URL password for ${APP_ROLE}:  ${password}\n`);
  } else {
    await prisma.$executeRawUnsafe(`alter role "${APP_ROLE}" with nobypassrls`);
    if (process.env.APP_DB_PASSWORD) {
      await prisma.$executeRawUnsafe(
        `alter role "${APP_ROLE}" with password '${password}'`,
      );
    }
    console.log(`role ${APP_ROLE} already exists (bypassrls forced off)`);
  }

  await prisma.$executeRawUnsafe(`grant usage on schema public to "${APP_ROLE}"`);
  await prisma.$executeRawUnsafe(
    `grant select, insert, update, delete on all tables in schema public to "${APP_ROLE}"`,
  );
  await prisma.$executeRawUnsafe(
    `grant usage, select on all sequences in schema public to "${APP_ROLE}"`,
  );
  // So tables added later are reachable without re-granting by hand.
  await prisma.$executeRawUnsafe(
    `alter default privileges in schema public grant select, insert, update, delete on tables to "${APP_ROLE}"`,
  );

  /**
   * Append-only records. The audit trail and the ledger are what an accountant or
   * a head relies on to say what happened, and the application never edits or
   * deletes a row of either — corrections are new rows (a reversal is a second
   * journal entry). So the role the app runs as is not GIVEN the power to, and a
   * bug, an injection or a stolen app credential cannot rewrite history. Rows
   * leave only with their school (cascade, run as the owner).
   */
  for (const table of APPEND_ONLY) {
    await prisma.$executeRawUnsafe(
      `revoke update, delete, truncate on "${table}" from "${APP_ROLE}"`,
    );
  }

  // 2. Which tables are tenant-owned: anything carrying a schoolId column.
  const tenantTables = await prisma.$queryRawUnsafe(`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'schoolId'
    order by table_name
  `);

  const applied = [];
  for (const { table_name: table } of tenantTables) {
    if (UNSCOPED.has(table) || AUTH_TABLES.has(table)) continue;
    await enable(table, `"schoolId"`);
    applied.push(table);
  }

  await enableAuthTables();
  applied.push(...AUTH_TABLES);

  // The School row itself is keyed by id, not schoolId.
  await enable("School", `"id"`);
  applied.push("School");

  // 3. Report, and refuse to look successful if something was missed.
  const summary = await prisma.$queryRawUnsafe(`
    select
      (select count(*)::int from pg_policies where schemaname = 'public') as policies,
      (select count(*)::int from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity) as rls_enabled,
      (select count(*)::int from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relforcerowsecurity) as rls_forced
  `);

  console.log(`\nprotected ${applied.length} tables`);
  console.log(
    `policies: ${summary[0].policies}  rls enabled: ${summary[0].rls_enabled}  forced: ${summary[0].rls_forced}`,
  );

  const unprotected = await prisma.$queryRawUnsafe(`
    select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join information_schema.columns col
        on col.table_name = c.relname and col.table_schema = 'public'
     where n.nspname = 'public' and c.relkind = 'r'
       and col.column_name = 'schoolId' and not c.relrowsecurity
       and c.relname <> all($1::text[])
  `, [...UNSCOPED]);
  if (unprotected.length > 0) {
    console.error(`\nSTILL UNPROTECTED: ${unprotected.map((r) => r.relname).join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log(
      `every table with a schoolId is protected (deliberately excluded: ${[...UNSCOPED].join(", ")})`,
    );
  }
}

/**
 * User and Session: visible to a school only through its own people.
 *
 * A school sees a login when it is that login's home school or the login holds a
 * membership there — which is what "this school's staff and parents" means, and is
 * how every tenant screen reaches users already (through Membership, itself under
 * RLS). It sees a session on the same terms, plus any session working in it, so
 * that ending a removed person's sessions still works after their membership has
 * gone.
 *
 * Sessions are never created or moved from a tenant: sign-in, school switching and
 * sign-out all run under the bypass, so WITH CHECK admits the bypass alone.
 *
 * ⚠️ A person who belongs to two schools has their sessions visible to both. That
 * is deliberate: a password reset or a suspension from either school must be able
 * to end every one of them, and either school can already reset that password.
 * What the policy removes is the other 99 per cent — logins and sessions of people
 * who have nothing to do with the school asking.
 */
async function enableAuthTables() {
  const bypass = `current_setting('app.bypass_rls', true) = 'on'`;
  const school = `current_setting('app.school_id', true)`;

  for (const table of AUTH_TABLES) {
    await prisma.$executeRawUnsafe(`alter table "${table}" enable row level security`);
    await prisma.$executeRawUnsafe(`alter table "${table}" force row level security`);
    await prisma.$executeRawUnsafe(`drop policy if exists tenant_isolation on "${table}"`);
  }

  const member = (userColumn) => `exists (
          select 1 from "Membership" m
           where m."userId" = ${userColumn} and m."schoolId" = ${school}
        )`;

  const userVisible = `
        ${bypass}
        or "schoolId" = ${school}
        or ${member(`"User"."id"`)}`;
  await prisma.$executeRawUnsafe(`
    create policy tenant_isolation on "User"
      using (${userVisible})
      with check (${userVisible})
  `);

  await prisma.$executeRawUnsafe(`
    create policy tenant_isolation on "Session"
      using (
        ${bypass}
        or "activeSchoolId" = ${school}
        or ${member(`"Session"."userId"`)}
      )
      with check (${bypass})
  `);
}

async function enable(table, column) {
  await prisma.$executeRawUnsafe(`alter table "${table}" enable row level security`);
  // FORCE so the owner is subject to it too; BYPASSRLS still wins for postgres,
  // which is what keeps migrations and seeding working.
  await prisma.$executeRawUnsafe(`alter table "${table}" force row level security`);
  await prisma.$executeRawUnsafe(`drop policy if exists tenant_isolation on "${table}"`);
  // current_setting(..., true) yields NULL when unset, so an un-scoped session
  // matches no row rather than every row: deny by default.
  await prisma.$executeRawUnsafe(`
    create policy tenant_isolation on "${table}"
      using (
        current_setting('app.bypass_rls', true) = 'on'
        or ${column} = current_setting('app.school_id', true)
      )
      with check (
        current_setting('app.bypass_rls', true) = 'on'
        or ${column} = current_setting('app.school_id', true)
      )
  `);
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
