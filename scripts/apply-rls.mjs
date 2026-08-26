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

/** Auth tables are deliberately not tenant-scoped: sign-in happens before a
 *  tenant is known, and both are keyed by id/token rather than by school. */
const UNSCOPED = new Set(["User", "Session", "_prisma_migrations"]);

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

  // 2. Which tables are tenant-owned: anything carrying a schoolId column.
  const tenantTables = await prisma.$queryRawUnsafe(`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'schoolId'
    order by table_name
  `);

  const applied = [];
  for (const { table_name: table } of tenantTables) {
    if (UNSCOPED.has(table)) continue;
    await enable(table, `"schoolId"`);
    applied.push(table);
  }

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
