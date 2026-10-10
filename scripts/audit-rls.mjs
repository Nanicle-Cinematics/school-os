/**
 * Ask a database — usually PRODUCTION — whether every tenant table is actually
 * protected. Read-only: it runs no DDL and writes nothing.
 *
 * Why this exists separately from apply-rls.mjs. That script applies as well as
 * audits, which is the right tool at a terminal and the wrong one pointed at
 * production from CI: it would quietly "fix" drift and report success, so the
 * deploy that forgot `db:rls` would never be noticed. This one only reports, and
 * exits non-zero when something is unprotected — so a forgotten step stays
 * visible instead of being papered over.
 *
 * Why CI cannot answer this on its own database: CI runs `db:rls` every time, so
 * a newly added tenant table is always protected there. The failure being caught
 * is drift between the schema and PRODUCTION, and only production knows.
 *
 *   node --env-file=.env.prod scripts/audit-rls.mjs
 */

import { PrismaClient } from "@prisma/client";

const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Set DIRECT_URL (or DATABASE_URL) to the database to audit.");
  process.exit(2);
}

// Same exclusions as apply-rls.mjs: sign-in happens before a tenant is known,
// so the auth tables cannot be tenant-scoped.
const UNSCOPED = ["User", "Session", "_prisma_migrations"];

const prisma = new PrismaClient({ datasources: { db: { url } } });

try {
  // `School` is scoped by its own `id`, not by a `schoolId` column, so a query
  // that looks only for `schoolId` misses it — and it is the table holding the
  // tenant list. apply-rls.mjs protects it explicitly (`enable("School", "id")`),
  // which is also why its count is one higher than a schoolId-only count: the
  // 40 vs 41 that looked like drift on 2026-09-08 and was not.
  const rows = await prisma.$queryRawUnsafe(
    `
    select c.relname as table_name,
           c.relrowsecurity as rls,
           c.relforcerowsecurity as forced,
           (select count(*)::int from pg_policies p
             where p.schemaname = 'public' and p.tablename = c.relname) as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and c.relname <> all($1::text[])
       and (
         c.relname = 'School'
         or exists (
           select 1 from information_schema.columns col
            where col.table_schema = 'public'
              and col.table_name = c.relname
              and col.column_name = 'schoolId'
         )
       )
     order by c.relname
    `,
    UNSCOPED,
  );

  /**
   * Who else can reach these tables at all.
   *
   * ⚠️ Found on 2026-09-10, by a Supabase dialog rather than by anything here:
   * `anon` and `authenticated` — the roles PostgREST exposes to anyone holding
   * the project's publishable anon key — held DELETE, INSERT, SELECT, TRUNCATE
   * and UPDATE on every table in `public`, production included.
   *
   * RLS does not save you from that. Two reasons:
   *   - `User` and `Session` carry no schoolId, so they were never in the set
   *     this script checks — and INSERT on Session is account takeover, because
   *     the app authenticates by looking up sha256(cookie) there;
   *   - TRUNCATE is NOT subject to row security, so even a policy-protected
   *     table like Student could have been emptied.
   *
   * So the grant is the thing to watch, and it is watched here rather than
   * remembered: Supabase's default privileges re-grant on tables created later,
   * which is exactly how this would come back.
   */
  const exposed = await prisma.$queryRawUnsafe(
    `
    select table_name, grantee,
           string_agg(privilege_type, ',' order by privilege_type) as privileges
      from information_schema.role_table_grants
     where table_schema = 'public'
       and grantee in ('anon', 'authenticated')
     group by table_name, grantee
     order by table_name, grantee
    `,
  );

  /**
   * The audit trail and the ledger are append-only to the app role — see
   * apply-rls.mjs. Watched here because Supabase's default privileges re-grant on
   * every table and a later `grant … on all tables` would quietly undo it.
   */
  const appRole = process.env.APP_DB_ROLE ?? "school_os_app";
  const writable = await prisma.$queryRawUnsafe(
    `
    select table_name, string_agg(privilege_type, ',' order by privilege_type) as privileges
      from information_schema.role_table_grants
     where table_schema = 'public'
       and grantee = $1
       and table_name in ('AuditLog', 'JournalEntry', 'JournalLine')
       and privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE')
     group by table_name
    `,
    appRole,
  );
  if (writable.length > 0) {
    console.error("\nNOT APPEND-ONLY — the app role can rewrite history here:");
    for (const row of writable) {
      console.error(`  ${row.table_name} → ${appRole}: ${row.privileges}`);
    }
    console.error("\nFix: node --env-file=<env with DIRECT_URL> scripts/apply-rls.mjs");
    process.exitCode = 1;
  }

  /**
   * The role the app connects as must be one Postgres actually applies policies to.
   *
   * ⚠️ Everything above audits the POLICIES, and a policy is skipped entirely for
   * a superuser or any role with BYPASSRLS. If the deployment's APP_DATABASE_URL
   * ever named the owner, all of it would pass: policies present, forced, grants
   * clean, and not one of them applied. This asks about the role itself.
   *
   * It also fails a role that OWNS a table. FORCE makes an owner obey policies,
   * but an owner can `alter table … disable row level security` — so an app role
   * that owns anything is one injected statement from switching its own isolation
   * off. apply-rls.mjs creates the role owning nothing, and this keeps it so.
   */
  const roleRows = await prisma.$queryRawUnsafe(
    `select rolname, rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname = $1`,
    appRole,
  );
  const ownedTables =
    roleRows.length === 0
      ? []
      : await prisma.$queryRawUnsafe(
          `select tablename from pg_tables where schemaname = 'public' and tableowner = $1 order by tablename`,
          appRole,
        );
  const roleProblems = [];
  if (roleRows.length === 0) {
    roleProblems.push(`the role ${appRole} does not exist in this database`);
  } else {
    const role = roleRows[0];
    if (role.rolsuper) roleProblems.push("it is a SUPERUSER, which Postgres exempts from every policy");
    if (role.rolbypassrls) roleProblems.push("it has BYPASSRLS, which Postgres exempts from every policy");
    if (ownedTables.length > 0) {
      roleProblems.push(
        `it owns ${ownedTables.length} table(s) (${ownedTables.slice(0, 5).map((t) => t.tablename).join(", ")}), so it could switch row security off for them`,
      );
    }
  }
  if (roleProblems.length > 0) {
    console.error(`\nTHE APP ROLE DOES NOT ENFORCE ISOLATION — ${appRole}:`);
    for (const problem of roleProblems) {
      console.error(`  ${problem}`);
    }
    console.error(
      "\nFix: node --env-file=<env with DIRECT_URL> scripts/apply-rls.mjs forces\n" +
        "NOBYPASSRLS. A role that is a superuser or owns tables must be replaced, and the\n" +
        "deployment's APP_DATABASE_URL must name the replacement, never the owner.",
    );
    process.exitCode = 1;
  } else {
    console.log(`app role ${appRole}: no superuser, no BYPASSRLS, owns no tables`);
  }

  const gaps = rows.filter((r) => !r.rls || !r.forced || r.policies === 0);

  // Count the same way apply-rls.mjs reports it, so the two are comparable and
  // a mismatch means real drift rather than two different definitions.
  console.log(`tenant tables (incl. School): ${rows.length}`);
  console.log(`gaps: ${gaps.length}`);
  console.log(`tables reachable by anon/authenticated: ${exposed.length}`);

  if (gaps.length > 0) {
    console.error("\nUNPROTECTED — a school can read another school's rows here:");
    for (const g of gaps) {
      const missing = [
        !g.rls && "RLS not enabled",
        !g.forced && "not FORCEd",
        g.policies === 0 && "no policy",
      ].filter(Boolean);
      console.error(`  ${g.table_name}: ${missing.join(", ")}`);
    }
    console.error(
      "\nFix: node --env-file=<env with DIRECT_URL> scripts/apply-rls.mjs\n" +
        "This is what a deploy carrying a new tenant table forgets.",
    );
    process.exitCode = 1;
  } else {
    console.log(
      `every table with a schoolId is protected (deliberately excluded: ${UNSCOPED.join(", ")})`,
    );
  }

  if (exposed.length > 0) {
    console.error(
      "\nREACHABLE BY anon/authenticated — anyone with the project's anon key can do this:",
    );
    for (const row of exposed.slice(0, 20)) {
      console.error(`  ${row.table_name} → ${row.grantee}: ${row.privileges}`);
    }
    if (exposed.length > 20) {
      console.error(`  …and ${exposed.length - 20} more`);
    }
    console.error(
      "\nFix, in the Supabase SQL editor:\n" +
        "  revoke all on all tables in schema public from anon, authenticated;\n" +
        "  revoke all on all sequences in schema public from anon, authenticated;\n" +
        "  revoke all on all routines in schema public from anon, authenticated;\n" +
        "  revoke usage on schema public from anon, authenticated;\n" +
        "  alter default privileges in schema public revoke all on tables from anon, authenticated;\n" +
        "  alter default privileges in schema public revoke all on sequences from anon, authenticated;\n" +
        "  alter default privileges in schema public revoke all on routines from anon, authenticated;\n" +
        "\nNothing in School OS authenticates as either role — it connects as the\n" +
        "restricted app role over Postgres, and ships no Supabase client at all.",
    );
    process.exitCode = 1;
  } else {
    console.log("anon/authenticated hold nothing in public");
  }
} finally {
  await prisma.$disconnect();
}
