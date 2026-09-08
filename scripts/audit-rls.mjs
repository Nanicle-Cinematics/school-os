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

  const gaps = rows.filter((r) => !r.rls || !r.forced || r.policies === 0);

  // Count the same way apply-rls.mjs reports it, so the two are comparable and
  // a mismatch means real drift rather than two different definitions.
  console.log(`tenant tables (incl. School): ${rows.length}`);
  console.log(`gaps: ${gaps.length}`);

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
} finally {
  await prisma.$disconnect();
}
