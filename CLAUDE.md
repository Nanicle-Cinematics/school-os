# School OS

Multi-tenant school management SaaS for the Ghanaian market (KG–JHS/SHS, three
terms, GES conventions, GHS, mobile money). Sold to many schools from one
codebase under the Nanicle brand.

## Stack

- Next.js 16 (App Router) + React 19 + Tailwind 4
- Prisma 6 (**pinned** — see gotcha below) + Postgres on Supabase
- Own auth (scrypt via `node:crypto`, no native modules)

## Scope

Shipping Phases 1–3 plus SMS:

1. **Foundation & people** — school setup, academic years/terms, levels, classes,
   subjects, students, guardians, staff, RBAC
2. **Money** — fee structures, invoices, payments, receipts, debtors, expenditure
3. **Academics** — assessments, score entry, results computation, report cards
4. **SMS** — bulk campaigns (by class, level, debtors) and transactional triggers

Plus **attendance** — a daily register per class, feeding the report card.

Not modelled yet: timetable, admissions, library, boarding, transport, health,
payroll. Single-campus by design — there is no `Branch` model.

## Gotchas

- **Only `main` builds on Vercel.** `vercel.json`'s `ignoreCommand` skips the build for every
  other branch, so a PR gets no preview deployment (CI is GitHub Actions and still runs). It was
  added on 2026-10-03 after the free team hit 100% of its 10 GB Function Storage: school-os alone
  had made 342 deployments in six weeks and each one stores its own copy of the server bundle.
  Put `[preview]` in a commit message to get a preview for that push (careful: even a message
  that merely MENTIONS it counts). A skipped build is not an error, and the "Vercel" check on a PR
  will say so.

- **Prisma is pinned to v6.** Bare `npx prisma …` pulls v7, which rejects the
  `url = env("DATABASE_URL")` datasource syntax (P1012). Always go through the
  npm scripts (`npm run db:push`) or the local binary
  (`node_modules/.bin/prisma`) — never bare `npx`.
- **Supabase needs both URLs.** `DATABASE_URL` is the transaction pooler (6543,
  `?pgbouncer=true&connection_limit=1`); `DIRECT_URL` is the direct connection
  (5432) and is what `prisma migrate` uses. Omitting `directUrl` makes migrations
  hang or fail with prepared-statement errors.
- **Seeding.** `npm run db:seed` works because npm puts `node_modules/.bin` on
  PATH; calling `prisma db seed` directly fails to find `tsx`.
- **The network here is very slow.** npm's default fetch timeouts cause
  `ERR_SOCKET_TIMEOUT` mid-install. Config already raised globally
  (`fetch-timeout=900000`, `fetch-retries=8`). Run long installs in the
  background rather than assuming they hang.
- **Every transaction needs a generous timeout.** Prisma's interactive-transaction
  default is 5s; the database is in Frankfurt and one payment makes ~6 round
  trips, so ordinary writes died with `P2028` ("transaction not found").
  `tenantTransaction` now defaults to `TX_OPTS` (30s / 15s maxWait); bulk work
  like invoice generation passes its own larger budget.
- **`tenantTransaction` callbacks take `TenantTx`, not `Prisma.TransactionClient`.**
  The extended client's tx type is not assignable to the plain one — any helper
  taking a `tx` must import `TenantTx` from `@/lib/prisma` or the build fails
  with a wall of unreadable variance errors.
- **Don't fan a page's queries out with `Promise.all`.** `DATABASE_URL` pins
  `connection_limit=1` (pgBouncer transaction mode), so parallel queries do not
  run in parallel — they queue for the single connection, and on this link the
  tail of a 4–5 query fan-out blows past Prisma's 10s pool timeout and the page
  500s with P2024 ("Timed out fetching a new connection from the connection
  pool"). Await them in sequence: same wall time, no queue to time out. This
  bites detail pages hardest, and it looks like a flaky network until you notice
  the list pages always succeed while the detail page never does.
- **Number sequences can fall behind their data.** `nextNumber()` takes an
  optional `isTaken` probe (see `takenProbes`) and walks forward past
  collisions. Needed because seeded/imported rows are numbered without touching
  the counter, and the unique constraint then rejects every new write.
- **Disk is tight** (~12 GB free). A corrupted `node_modules` from a full disk
  shows up as esbuild `EBADMACHO` / errno 88; fix with
  `rm -rf node_modules package-lock.json && npm cache clean --force && npm install`.
- ⚠️ **React RESETS a form's fields once its action completes, and making an
  input CONTROLLED does not stop it.** The re-render carries the same `value`
  prop as before, React sees no change, and the reset DOM node is left alone —
  so a field silently returns to its default while the card above still reports
  what the *previous* value produced. On `/guardians/invites` that meant a screen
  reading "Create 3 logins" whose select had gone back to "Every class": pressing
  it invited all 43 guardians in the school. **A second action in the same form
  must never re-read a field for its audience.** Take it from the state the first
  action returned, `formData.set` it in a wrapper around the dispatch, and have
  the action refuse if the count no longer matches what was shown. Re-apply the
  value to the DOM in an effect as well, or the screen goes on lying about what
  it is about to do.

## The GES curriculum is the onboarding baseline

Every school is provisioned with the national curriculum already set up —
11 levels (KG 1 to JHS 3), 18 subjects and 104 level-subject offerings — rather
than an empty ladder. `src/lib/ges-curriculum.ts` holds it as ground truth;
`applyGesCurriculum` is idempotent, so it also fills gaps for a school created
earlier (offered on Settings → School structure).

The transitions are the part a hand-built list gets wrong, and the reason this is
data rather than documentation:

- **KG is not subjects.** Four thematic areas — Numeracy, Literacy, Creative
  Arts, Our World Our People. Mathematics and Science must never appear there.
- **OWOP and History** run B1–B6 only; at B7 they merge into **Social Studies**.
- **Creative Arts** (B1–B6) becomes **Creative Arts and Design** at JHS.
- **French and Computing** start at **B4**, not B1.
- **Arabic and Career Technology** are JHS-only.
- **PE** is "Physical Education" (B1–B6) and "Physical Health" (B7–B9) — one
  lineage, two names, so continuity checks must treat them as the same subject.

Counts to assert against: KG 4, B1–B3 9, B4–B6 11, B7–B9 12. A school whose local
practice differs edits it afterwards — the structure is a baseline, and a
deviation is a customisation rather than an error.

**Fee items and expense headings are provisioned the same way**, from
`src/lib/finance-defaults.ts` (7 of each, idempotent on `code`). This is not
cosmetic: a `FeeStructure` is priced *per `FeeCategory`*, so a school with none
gets a fee form with no fields at all — a heading, a hint and nothing to type
into. Both lists are editable on `/fees`, where the gap is discovered. Deleting
an item is refused once it is priced or billed (the FK cascades and would take
the structure lines with it), but renaming always works, because `code` is the
stable handle and is derived only on create.

## Tenancy — enforcement is LIVE

`DB_RLS="on"` and the app connects through `APP_DATABASE_URL` as the restricted
`school_os_app` role. 40 tables have RLS enabled and FORCED with a
`tenant_isolation` policy; `npm run db:rls` (re)applies them and is idempotent.
Verified by `npm run verify:isolation` (14/14) and `npm run verify:actions`.

Four things had to be true at once, and each was broken:

- **The role, not just the policies.** `postgres` owns the tables *and* has
  `rolbypassrls`; policies applied to it are decoration. FORCE covers ownership,
  a separate NOBYPASSRLS role covers the attribute. `DATABASE_URL` stays the
  owner connection for the Prisma CLI, the seed and the admin-side verify
  scripts, which must not be tenant-scoped.
- **One client for the GUC and the query.** The extension issued `set_config`
  through the unextended client while `query(args)` belonged to the extended one,
  so they never shared a transaction and the transaction-local setting was
  invisible.
- **Await inside the storage scope.** Prisma promises are lazy, so
  `storage.run()` returning an un-awaited promise let the query execute after the
  scope had exited. See `runAsync` in tenant-context.ts.
- **Set the context in the frame that needs it.** `enterWith` inside
  `requireAuth` does NOT reach the caller's continuation. Every server action
  therefore calls `setTenantContext({ schoolId: auth.schoolId })` itself, right
  after `requireRole`, and `tenantTransaction(schoolId, …)` takes the school as
  an argument rather than inferring it.

✅ **A tenant query with no tenant context is now REFUSED** (`assertTenantContext`
in prisma.ts). Without it the GUC was set to the empty string and the query ran:
every policy failed to match, nothing came back, and the caller could not tell
"this school has none" from "nobody said which school". The models it covers are
read off the Prisma DMMF — anything with a `schoolId`, plus `School` by its own
`id` — so the set cannot go stale. It throws in production too: a page that tells
a school it has nothing is worse than one that says what went wrong. Both intents
are already written everywhere they belong (actions call `setTenantContext`,
session.ts uses `withBypass`), so it only fires where neither was said.

`verify:isolation` asserts the refusal rather than the old "sees nothing", which
was the weaker half of the same property.

**Empty reads make guards pass, not fail.** Before that last fix, an action's
pre-transaction reads returned nothing under RLS, so `assertEditable` concluded
"nothing in the way" and a forged band write onto a frozen grading scale
*succeeded*. If you add an action, set the context in it — a guard that reads
zero rows is indistinguishable from a guard with nothing to find.

**Adding `schoolId` to a `where` clause does not substitute for this.** Under RLS
the policy filters first: `updateUserRoles` already filtered by `schoolId`
explicitly and still saw nothing when the GUC was empty.

**The connected role is asked about, not assumed.** `verifyRestrictedRole` in
prisma.ts asks Postgres once per process whether the role behind
`APP_DATABASE_URL` is a superuser or has BYPASSRLS, and in production refuses to
serve if it is. The boot guard only proved the variable was SET, and the owner's
connection string satisfies that exactly as well as the restricted role's: with
the owner every policy is skipped while the site boots, every page renders and
every test passes. The daily `audit:rls` asks the same of `school_os_app` and also
fails a role that OWNS tables, because an owner can `alter table … disable row
level security` on them. `verify:isolation` proves the verdict flags the owner
(a verdict that cannot say no proves nothing) and then counts every tenant table
as the restricted role, once as the school and once as a school that does not
exist, instead of the three tables it used to name.

⚠️ **What row security does NOT defend against** (audited 2026-10-10). It is a net
under a query that forgot its school. It is not a wall around a process that has
been subverted, and "enforcement is LIVE" should not be read as one:

- **The bypass is a setting any statement can change.** The policy passes every
  row when `app.bypass_rls` is `'on'`, and that is a plain `set_config`, so code
  that can run an arbitrary SQL string can lift isolation for itself. On a
  development database one such statement took a session scoped to a school of
  44 pupils to all 110 in the database. Raw SQL today is 3 tagged templates
  (advisory locks) and 2 fixed strings in `prisma.ts`; `npm run verify:raw-sql`
  (source-only, in CI) fails on `$queryRawUnsafe`, `$executeRawUnsafe` or
  `Prisma.raw` anywhere else in `src/`. A second database role for the bypass
  would close it properly, at the cost of a second connection pool that this
  instance cannot spare.
- **`User` and `Session` have no policy.** Sign-in happens before a school is
  known, so from any school's context the app role can read every login's password
  hash, encrypted TOTP secret, recovery-code hashes and every session token hash
  (16 users across 4 schools and 29 sessions on the same development database).
  The only protection is that tenant code reaches users through `Membership`,
  which is under RLS; one unfiltered `user.findMany` in tenant code would expose
  all of them. Policies on these two tables are feasible, since sign-in already
  uses the bypass, and are proposed rather than built.
- **Foreign-reference constraints ignore row security.** A school can insert a
  row pointing at another school's id and Postgres accepts it. The row cannot be
  read back through a join, so the harm is untidy data and a way to learn that an
  id exists — and, where a uniqueness index has no school in it or a RESTRICT
  constraint points at the row, obstruction of the OTHER school: a journal line on
  another school's account makes that account undeletable while its owner sees no
  line, and an assessment on another school's term, class and subject claims a
  title in `(term, class, subject, title)` so the owner's own sheet then fails.

  ⚠️ **An id taken from a request must be read back through the tenant client
  before it is written into a referencing column.** The sentence that stood here
  until 2026-10-10, "actions re-read ids server-side before writing", was false:
  an audit found sixteen actions that did not. `ownsAll` and `ownsSheet` in
  `src/lib/ownership.ts` are the read. The ledger mappings (`saveCoreAccounts`,
  `setFeeCategoryAccount`, `setExpenseCategoryAccount`) and the assessment entry
  points (`createAssessment`, `openSheet`) use them, and `verify:actions` posts
  another school's real ids to each (the grading-band actions and `saveClassGroup`
  have their own reads). Added 2026-10-10 on the audit's second pass: admitting,
  editing and enrolling pupils (class, house, programme), `addGuardianToStudent`,
  linking a guardian, `addTeachingAssignment`, `recordExpense`, `recordVendorBill`,
  `setBudget`, `saveSubjectLevels`, a campaign's `templateId` and the default grading
  scale in Settings, all through the one-line readers at the foot of `ownership.ts`.
  `placementGuards` in `verify:actions` posts another school's ids to the ones whose forms
  render on the page (enrolling, linking and adding a guardian, teaching assignments,
  subject levels, budgets, the default grading scale); **`recordExpense`,
  `recordVendorBill`, `sendCampaign` and the house/programme on a pupil sit behind a
  click or an edit page and are not driven yet**, and none of it has been run against a
  database. Audited and left alone because they read the
  row before writing: `saveFeeStructure`, `createPlan`, `recordPayment`,
  `saveMockSheet`, `saveRecordedMarks`, `saveEarlierClasses`, the register, `saveRemarks`
  and the promotion actions. A failure that is only a server error (an update by a
  posted id that row security hides, so Prisma throws P2025) writes nothing and
  is a lower priority.

**`connection_limit`**: with RLS on, every model op becomes a transaction, which
`connection_limit=1` cannot serve (P2024). The app role's URL uses **4**.

⚠️ **It used to be 10, and the dev project went Unhealthy under it** on
2026-09-11 — **CPU 80%, RAM 85%, on fourteen requests in an hour**, then hours
unreachable. Not paused: that is a different failure with a different message
(the pooler says `FATAL: (ENOTFOUND) tenant/user … not found`), and the project's
API gateway answered 401 throughout.

**The limiter was DISK IO and COMPUTE at 100%, not memory.** A free-tier
`t4g.nano` runs on burst credits for both; spend them and the instance crawls
while every client above it times out — which is exactly the progression seen:
pool checkout timeouts, then authentication timeouts, then "Can't reach database
server". Connections were what spent them: a dev server holding ten, a second dev
server more than once, a dozen verify scripts each opening their own client,
headless-Chrome screenshot runs, and scripts killed mid-run whose connections the
pooler reaps slowly.

⚠️ **A restart does NOT refill burst credits** — they recover with idle time. It
clears stuck connections and open transactions, and that is all. After the
restart here, `select 1` still took **6.2 seconds**.

Two things measured afterwards, both worth knowing before diagnosing this again:

- **Supabase's own services hold ~6 connections before the app opens one** —
  PostgREST ×2, Supavisor, postgres_exporter, Storage API, pg_cron. `max_connections`
  is 60 and `shared_buffers` 224 MB. Ten for one dev server was not a rounding
  error on that instance.
- ⚠️ **80 MB of WAL is NOT a leak, and there was no replication slot.**
  `min_wal_size` is **128 MB** here, so Postgres keeps at least that preallocated
  for reuse and 80 MB sits below the floor. A WAL directory larger than the
  database looks alarming on a 31 MB dev database and means nothing. Do not go
  hunting `pg_replication_slots` for it, as this file's author did — the query
  came back empty.

So: **one dev server at a time**, prefer finishing a script to killing it, and if
it happens again restart from **Settings → General → Project availability**
(*not* Infrastructure, which only shows the readouts), then leave it alone for an
hour. To tell a client problem from a platform one:

```sql
select state, count(*) from pg_stat_activity group by state order by count desc;
select coalesce(application_name, '(none)') as app, count(*)
  from pg_stat_activity group by app order by count desc;
```

A pile of `idle` rows under your own application name means the client left them.
Idle connections belonging to PostgREST, Supavisor or pg_cron are the platform's
baseline and are not yours to fix.

**`verify:onboarding` ASSERTS, and CI runs it** against the built app, in the job
that already boots one for the role and action guards. A redirect is a failure, a
non-200 outside the three deliberate 404s is a failure, and so is a screen that
renders no form, button or link at all. Until 2026-09-10 it only printed, so
27 consecutive `307 -> /account/password` responses read as a healthy report —
each screen still had a title and no affordances, which is exactly what an
onboarding dead end looks like. Its first honest run found three real ones:
`/dashboard`, `/results` and `/fees` all told a day-one school to "set a term in
Settings" in plain prose, with nothing to click.

⚠️ **A long-lived `next dev` can lose the tenant context**, and the symptom is
not an error. After ~8 hours and many Fast Refreshes, every tenant-scoped read
returned EMPTY — `/students` said "0 on roll" for a 44-pupil school, and
`/settings` answered **404**, because its `if (!school) notFound()` is the only
place an empty read is checked rather than rendered as "nothing here yet". The
database, the policies and the role were all fine: the same queries through
`src/lib/prisma.ts` in a script returned everything. Restart before believing a
tenancy bug that a script cannot reproduce.

**Restarting `next dev` is a trap.** It detects a running server and silently
serves the old one — including its old `.env` — printing "You can access the
existing server". `pkill -f "next dev"` does not match the listener. Kill by port
(`lsof -nP -iTCP:3000 -sTCP:LISTEN -t`) and check the log does not say "existing
server", or you will spend an hour measuring stale code.

## Tenancy

Every tenant-owned table carries `schoolId` and is indexed on it. A table without
`schoolId` is a tenancy bug.

`src/lib/tenant-context.ts` holds a per-request `AsyncLocalStorage` context;
`src/lib/prisma.ts` extends the client so each operation sets the
`app.school_id` / `app.bypass_rls` GUCs transaction-locally, which is what
Postgres RLS policies read. Use
`tenantTransaction()` for any multi-statement tenant write (invoice generation,
results computation, number-sequence increments) so the GUC and the writes share
one transaction.

**A new table is not protected until `npm run db:rls` is re-run.** The script
enumerates tables from the database rather than from a list, so it is never out
of date — but nothing runs it for you, and a migration that adds a tenant table
ships that table with no row security at all. This has already happened **twice**:

- `AssessmentTemplate` arrived with the mark sheet and went unprotected, so every
  school's Settings → Assessment components listed every other school's
  components (the count read 18 across three schools instead of 6).
- `SchoolAsset` arrived with the crest and signature on 2026-08-28 and was still
  unprotected in production on 2026-09-07 — ten days, noticed only because the
  prod table count had gone 40 → 41. Nothing failed in between, which is the
  whole problem: the production guard in `src/lib/prisma.ts` checks only that
  `APP_DATABASE_URL` and `DB_RLS=on` are **set**, never that a policy exists, so
  a site that boots proves nothing about coverage.

`verify:isolation` fails on any table that has a `schoolId` but no RLS, FORCE and
policy. The check is first in that suite deliberately: every other assertion
proves isolation for the tables it names and proves nothing about a table added
since.

**CI runs it on every PR**, against the throwaway service container — `db:rls`
then `verify:isolation`, after the other suites (which deliberately exercise an
unprotected database) and before the build.

⚠️ **That job cannot catch a newly added tenant table, and must not be trusted
to.** CI runs `db:rls` every time, and the script enumerates tables from the
database, so a new model is created and protected in the same run and the
coverage check passes. Verified by pushing a canary tenant table on 2026-09-08:
the run stayed green at 42 tables. What that job does protect is the
*machinery* — the Prisma extension, the GUCs, `tenant-context`, `apply-rls.mjs`
itself — which has broken before, four ways in one afternoon.

⚠️ **RLS is not the only way in — the GRANTS matter more.** On 2026-09-10 a
Supabase dialog (not anything in this repo) turned up that `anon` and
`authenticated` — the roles PostgREST exposes to anyone holding the project's
publishable anon key — held DELETE, INSERT, SELECT, TRUNCATE and UPDATE on every
table in `public`, production included. Two things that protection did not cover:

- **`User` and `Session` carry no `schoolId`**, so they were never in the set the
  audit checks. `INSERT` on `Session` is account takeover: the app authenticates
  by looking up `sha256(cookie)` there, so a row with a chosen `tokenHash` and any
  `userId` signs you in as that person, no password involved.
- **TRUNCATE is not subject to row security.** Policies govern
  SELECT/INSERT/UPDATE/DELETE only, so `Student` and `Guardian` could have been
  emptied despite being correctly protected.

Nothing in School OS authenticates as either role — there is no Supabase client
in the codebase at all — so the privileges were pure inheritance from Supabase's
defaults. Revoked in production the same day, **including the default privileges**,
which is what would otherwise re-grant them on every table created later:

```sql
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all routines in schema public from anon, authenticated;
revoke usage on schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on routines from anon, authenticated;
```

`audit:rls` now fails when either role holds any privilege in `public`, so the
nightly job catches a re-grant rather than a dialog box catching it a year later.
⚠️ A table created in the Supabase SQL editor still needs its own
`GRANT … TO school_os_app` and, if it is not tenant-scoped, `ENABLE ROW LEVEL
SECURITY` plus a policy for that role — see `PasswordReset`.

**The `prod-rls` job is the one that catches the real bug.** Both incidents were
drift between the schema and PRODUCTION: a `db push` by hand with no `db:rls`
after it. Only production knows, so that job asks production — daily, and on
every push to main — via `npm run audit:rls` (`scripts/audit-rls.mjs`). It is
read-only by design: it reports and fails rather than quietly applying, because a
run that repaired drift and reported success would hide the forgotten step
exactly as before. It needs the `PROD_DIRECT_URL` secret; without it the step
skips rather than fails.

Running `apply-rls.mjs` against prod after a deploy that carries a new tenant
table is still the fix. The daily audit bounds how long forgetting it goes
unnoticed; it does not remove the step.

**The same job also checks for SCHEMA drift**, and it is still worth having now
that migrations exist: `prisma migrate diff --exit-code` compares production to
`prisma/schema.prisma` and fails if they disagree, whatever the cause.

## Changing the schema

⚠️ **Migrations, since 2026-09-12. Do NOT `db push` at a database anyone else
uses, and do not hand-write SQL into the Supabase editor.** Both were the old
way, and both went wrong in one day: the same file was run against the dev
project twice while production stayed untouched (caught only because the drift
job refused a merge), and a hand-written `Plan` enum migration needed its cast
rewritten by hand because Prisma's own `("plan"::text::"Plan_new")` errors on
every existing row.

The flow:

```bash
npm run db:migrate            # prisma migrate dev — writes prisma/migrations/<name>
npm run db:status             # what this database has applied, and what is pending
```

Commit the generated SQL. It is reviewed in the pull request like any other code,
which is the point: the enum cast above would have been caught in review rather
than in a browser tab.

**Production is migrated by the `Migrate production` workflow**, by hand on
purpose:

```
gh workflow run migrate.yml --ref <branch> -f action=status   # what prod has, and what is pending
gh workflow run migrate.yml --ref <branch> -f action=deploy   # apply, in order
```

`--ref <branch>` is what makes "before merging" possible: it runs the migrations
sitting on that branch. GitHub still resolves `migrate.yml` itself on the DEFAULT
branch, so a dispatch is a 404 until the workflow file is on main — which is why
this one PR had to merge before it could be baselined, and why a later PR does
not.

⚠️ **Which side of the merge the migration goes on depends on the change.** The
running code and the live schema have to be compatible at every instant, and
Vercel deploys main the moment it is pushed — so there is always a window where
one of the two is ahead of the other, and the only question is which one it is
safe for.

- **ADDING** — a new column, table, or nullable field — migrates **BEFORE the
  merge** (`--ref <branch>`). Old code ignores a column it has never heard of;
  new code cannot run without it. Migrating after would leave the deployment
  racing the schema, which is an outage on every page that touches the new field.
- **REMOVING** — dropping a column or table, tightening a constraint — merges
  **FIRST, and migrates after the deploy has landed.** Backwards: the live code
  is still SELECTing that column, and Prisma names columns explicitly, so
  dropping it first breaks every read of the table until the deploy catches up.

This rule was written the wrong way round — "deploy BEFORE merging" with no
exception — and the very first schema change after it was a DROP, which would
have taken `/settings`, the report cards and the bills down together. The drift
job is the backstop either way, and it has already stopped two merges that would
have been outages.

⚠️ **A destructive change therefore turns main's drift job RED for a few
minutes**, between the merge and the migration, because main is ahead of
production by exactly one DROP. That is the ordering working, not a failure. Run
the migration, re-run the job, and check it goes green — a drift that outlives
that window is the real thing.

**CI builds its database from the migrations** (`db:deploy`, not `db push`) and
then asserts the result matches `prisma/schema.prisma`. Applying cleanly is not
the same as arriving at the right shape — a migration edited by hand can succeed
and still leave a column behind.

⚠️ **`0_init` is a BASELINE, not a history.** Production and dev were built by
`db push` and hand-written SQL before any of this existed, so they hold the tables
with no record of how they got them. `0_init` is the whole schema as it stood on
2026-09-12, marked applied rather than run (`action=baseline`, once per database).
Running `deploy` against such a database without baselining it first would try to
CREATE TABLE over live data and fail. **Both databases are baselined** — dev and
production, 2026-09-12; `action=baseline` is done and should never be run again.

A red `status` run is an ANSWER, not a breakage: `migrate status` exits 1 when
production has something pending, and that exit code is deliberately not
swallowed. "Database schema is up to date!" in the log is the all-clear.

**A school is provisioned with a CALENDAR** — the current academic year on the
standard Ghanaian September–July shape, split into three terms by
`splitIntoTerms`, with the term containing today marked current. Added
2026-09-10, because its absence was the reason three screens were dead ends:
fees are priced per term, results are computed per term and the dashboard reports
on one, so `/fees`, `/results` and `/dashboard` all refused to render and told a
new school, in prose with nothing to click, to go and build a year by hand. The
dates are a starting point exactly as the fee items and the GES ladder are —
`/settings/terms` says so and is where they are corrected.

⚠️ **"Needs your attention" was silent on day one**, which is when it matters
most. All four of its rules count things a new school does not have yet —
unfinished sheets, unpublished results, classes short of teachers, families
owing — so a school with no calendar, no classes and no pupils was told "nothing
is waiting on you" on the first screen it ever sees. Three setup rules now run
ahead of those and disappear as each is done. `verify:onboarding` asserts the
day-one dashboard never claims nothing is waiting, because a card that reassures
wrongly is worse than one that is empty.

**A school is provisioned with its standard MESSAGES too**, from
`src/lib/message-defaults.ts` (4 templates, idempotent on `name`) — added
2026-09-10, after the invite screen's write-up pointed at the hole it fixes.
Provisioning created none, and a `MessageTemplate` is found by **name**, so
`queueTransactionalSms` met every real school with a missing template and
returned: **no school outside the demo seed has ever sent a payment receipt, and
nothing anywhere said so.** The compose screen's "start from a template" picker
was empty for the same reason — the visible half of the same gap.

Three things keep it fixed, and the middle one is the important one:

- `provisionSchool` applies them, and `/messages` offers them to a school created
  before this existed (idempotent, so it also restores one that was deleted).
- **`queueTransactionalSms` falls back to the packaged wording** when the school
  has no template of that name. Silence is the failure that cannot be noticed: a
  parent does not chase a receipt they were never promised.
- `verify:sms` reads every `templateName: "…"` literal out of `src/lib` and fails
  on one that is not shipped — a misspelled name is indistinguishable from having
  no templates. Prefer the `TRANSACTIONAL` constants to a literal.

**Publishing a class texts its parents**, obeying Settings → SMS. Only the pupils
that run actually publishes are told: `setResultsStatus` reads which `TermResult`
rows are not yet PUBLISHED *before* it updates them, because publishing is
idempotent and a head may press it twice — a second "your child's report is
ready" is a second bill and a confused parent. A partly-published class therefore
texts only the pupils newly added to it.

⚠️ **`notifyOnPayment` and `notifyOnResultPublish` were dead switches.** The
settings form wrote them and showed them back, and nothing read either — so a
school that unticked "text a receipt when a payment is recorded" went on texting
receipts. `queueTransactionalSms` now takes the `gate` it obeys, as a required
argument, so a new automatic text cannot forget to have one.

⚠️ **And four more were dead, found 2026-09-12 by auditing the whole model.**
`blockReportOnArrears` promised "Withhold report cards from students in arrears"
and withheld nothing — a head who ticked it would have learnt at vacation, with
the term's fees already gone. `showClassPosition` and `showSubjectPosition`
printed regardless. `reportCardTemplate` offered a "Compact" layout that was
never built; the picker and the column are both gone.

**`npm run verify:settings` is what stops the fifth.** It takes the field list
from the Prisma DMMF — never a list kept by hand, which would go stale exactly
when it mattered — and fails on any `SchoolSettings` field that `/settings`
writes and no other file reads. Two things it learnt the hard way, both found by
forcing it red rather than by reasoning:

- **Comments are stripped before scanning.** The first forced-red run passed with
  the field unwired, because the comment explaining the bug named the field. This
  codebase comments heavily enough that nearly every dead field would be "read"
  by the paragraph describing how dead it is.
- **A read must LOOK like a read** — `.field`, a `field:` key, or a `"field"`
  literal (the SMS gates are reached as `settings[gate]`, never `.notifyOn…`).
  The second forced-red run passed on a leftover `const showClassPosition = true`.

It also runs the hold against real invoices, because source-reading proves a word
is present, not that a card is withheld.

**The arrears hold itself lives in `src/lib/report-access.ts`**, one rule for
four call sites. A card is held only when the school has actually ASKED — no
invoice, a DRAFT one or a CANCELLED one is never arrears, or the software would
punish a family for the office's backlog. Parents are held, the class print run
is held and NAMES who was left out on the sheet, and staff are not: the office
must be able to open the card to have the conversation. There is deliberately no
"print them anyway" button on the batch — a head who must release one card prints
that child's page, which is a decision rather than a click that quietly undoes
the policy for forty children.

⚠️ **A verify script must never pick its school with a bare `findFirst()`.**
Use `demoSchool()` from `scripts/fixture.mts`. A development database collects
schools — the onboarding walk provisions a `qa-<stamp>` one on every run and
deliberately leaves it behind (`verify:onboarding --clean <slug>` removes it) —
and Postgres returns rows in no particular order, so an unscoped pick is a coin
flip between the seeded school and an empty shell.

`verify:teacher` built its fixture from FOUR separate unscoped `findFirst`
calls: a school, a current year, a current term and a class, each found
independently. On a machine with two schools it paired a teacher in one school
with another school's term and class. The mark sheet then correctly had nothing
to show, and the failure read **"0 score inputs"** — which names neither the
cause nor the school. CI never saw it, because CI seeds exactly one school and
every coin lands the same way. Four other scripts had the same bare call.

⚠️ **A guard that is not in CI is not a guard.** `verify:attention`,
`verify:collections`, `verify:activity` and `verify:search` existed, passed, and
ran nowhere — so `school.subscription.paid` and `data.export` both reached the
dashboard's activity feed as raw strings ("data export · Activity · Grace
Amoah") while `verify:activity` sat in package.json with the answer in it. All
four are in CI now. The same lesson as forcing a guard red before trusting it:
a check nobody observes is a check that does not exist.

And then it happened twice more, which is why `check.mts` now derives the list
from the workflow rather than trusting anyone to remember. `verify:platform:sql`
was the worse of the two: it proves the generated delete-a-school SQL takes the
school's own logins and nothing else. Re-introducing the first draft's bug — a
sweep of every orphan in the database — fails two of its checks, and one of them
is **the platform admin's own account**.

`verify:activity` also only walked `src/lib`, so an audit written from a ROUTE
was invisible to it — which is exactly how `data.export` slipped past. It walks
`src/app` too now.

**A school can get its own data back out** — `/export`, added 2026-09-12. Until
then data only ever went IN: `/students/import` took a CSV and nothing anywhere
produced one, so a school could hand over its whole register, its fees and three
years of results and take back nothing. No GES return, nothing for an auditor,
no way to leave. For a vendor holding a school's records that is a trust
question before it is a feature.

Six datasets (`src/lib/export-data.ts`), each declaring its own roles: an export
is a bulk read of the entire school in one click, which is a different act from
opening a page. A TEACHER and a PARENT get nothing; an ACCOUNTANT gets the money
and not the children; results are leadership only. Every download is written to
the audit trail with who, what and how many rows.

⚠️ **Escaping happens once, in `toCsv`, never in a loader.** It was the other way
round first — every loader called a `cell()` helper — and that is a rule a new
dataset can forget, silently: the file only breaks from the first row containing
a comma, which in a school is the first address. It also made the escaping
untestable through the front door, and the first version of the test fed in
hand-quoted strings and proved nothing but that the parser works.

⚠️ **Phone columns must be declared in `textColumns`.** `0244123456` opened in
Excel becomes the NUMBER 244123456, so a school that exports its contacts, tidies
them in a spreadsheet and imports them back has just texted the wrong numbers. A
leading tab keeps it text, and `parseCsv` trims every cell so it still
round-trips through our own importer. The field is REQUIRED on every dataset, so
a new one has to decide rather than inherit a default that loses zeros.

**The students export is an import file** — same headers, same order as
`TEMPLATE_HEADERS`. `verify:export` feeds a real export through the real
importer, because "same headers" is a claim that rots the first time either side
is edited alone.

**`verify:export:route` needs a dev server** and covers what the loaders cannot:
the role refusal, the file headers, the audit row, and that the CSV has rows
under the header. It runs in CI against the built app, in the phase that already
boots one. Forced red by disabling the role check: a teacher was handed all six
datasets with a 200, and 7 of its 53 assertions failed. Two of its checks were vacuous when first written and both were
caught by forcing them red — the audit count passed with auditing removed because
28 rows from earlier runs already satisfied it, so it now counts only rows
created since the run began.

⚠️ **An invoice's stored status records an EVENT; lateness is DERIVED.**
`invoiceStatusFor` used to return OVERDUE once the due date had passed, and its
only caller is `recalcInvoice` — a payment, a reversal, an edited line. Nothing
runs when a date passes, so an invoice that simply sat there unpaid stayed
ISSUED for ever: dev held **zero** OVERDUE rows and 26 unpaid invoices all due
on one day, while `/invoices` offered an OVERDUE filter that returned nothing —
which an office reads as "nobody is late". The printed bill had been deriving it
correctly at read time all along, two inches from the column that was wrong.

Now: the stored status is ISSUED / PARTIALLY_PAID / PAID / CANCELLED, all
event-driven, and `isOverdue`, `displayStatus`, `daysOverdue` and
`statusFilterWhere` (all in `invoice-engine.ts`) answer lateness on every read.
`statusFilterWhere` is pure so `verify:invoicing` can prove the filter never
looks up `status: "OVERDUE"` again without needing a database. The money paths
were never wrong — the dashboard's debtor count and the SMS debtor audience both
select on `balance > 0` — it was the reporting that lied.

**The general rule: never persist a value that changes by itself.** A stored
field that rots with the calendar is the same animal as a switch nothing reads,
and it fails the same way — silently, and in the direction that reassures.

⚠️ **Send in bulk or don't send.** The obvious per-parent loop took **27 seconds
for two parents** on this link — no gateway configured, all of it round trips —
because each recipient re-read the template and wrote its row alone. Read the
template once, `createMany` the rows, and put the outcomes back with two updates:
7 queries whatever the class size, so only the gateway calls scale.

⚠️ **Anything the app sends by itself belongs in `transactional-sms.ts`, not in a
`"use server"` module.** `queueTransactionalSms` lived in message-actions.ts,
which made it a registered server action taking a school id, a phone number and a
body, with no `requireRole` of its own — every caller had one, so nothing looked
wrong. It also could not be imported by a verify script, because the module
reaches `next/navigation`.

**Provisioning must stay bulk.** A school is handed 11 levels, 18 subjects, 104
offerings, 14 finance categories and 6 assessment components, all inside one
transaction. Written row-at-a-time with an existence check each — as it first
was — that is ~300 sequential round trips over the single pooled connection
`DATABASE_URL` pins, which took 465s here and blew the transaction's own 180s
budget. Worse than slow: the work had already committed, so the console reported
failure while the school existed, and the retry then failed on a taken URL key.
Read-then-`createMany` brought it to ~56s on this link. Keep new provisioning
steps batched, and keep them idempotent on their natural key.

## A term is marked out of something, and the year decides who moves up

Every subject is worth **100** — the class and exam weights are defined to make
100 between them — so a term's total has an obvious denominator: the number of
subjects the class sits, times 100. Upper primary offers nine, so the term is
out of **900** and the year is out of **2700**.

`TermResult` now freezes that denominator (`subjectsOffered`, `possibleMarks`,
`percentage`) instead of printing a bare numerator a parent has to be told how
to read. Frozen, not derived, for the same reason positions are: a level's
subject list gets edited, and a card reprinted next year must still read the 900
the child was actually marked against.

**The denominator is the level's curriculum, not what happened to get marked.**
A subject nobody entered scores nothing and pulls the total down, so the hole
shows up on the broadsheet instead of being divided away — which is exactly the
kind of gap an end-of-year total must not hide. Two deliberate exceptions:
electives count only for the children who actually sat them, and a class with
nothing marked at all stays blank rather than declaring everyone scored 0 of 900
in a term whose marking has not started. A school with no curriculum set up
falls back to the assessed subjects, which is what the engine did before.

⚠️ **`average` changed meaning with it.** It is now the mark per *offered*
subject, so it agrees with the total printed beside it: 624 of 900 is an average
of 69.3, not the 78 that dividing by the eight marked subjects used to print.
Mid-term, a partly-entered class reads low on purpose.

**The teacher never presses Compute.** `saveSheet` rolls the class up itself,
in its own transaction after the marks have committed — the totals are derived
and can always be recomputed, so a slow roll-up must never cost anybody their
typing. Leadership's `/results` Compute button still exists for a whole-class
recompute.

**The third term decides the year.** `applyYearPromotion` runs at the end of
`computeClassResults` when `term.sequence === 3`: marks across all three terms
over the marks available across all three terms, against
`SchoolSettings.promotionPassPercent` (default **45**, GES practice). Below it
the child repeats; at or above it they are promoted, or graduated where there is
no rung above. The verdict is written to the third term's
`TermResult.promotionStatus`, which is where `/promotions` already looks — so
the promotion screen opens with every row already defaulted, the year mark shown
beside it, and the office free to change any of them. It is a default, not a
verdict.

The year, not the term, because a child who fell apart in one term and recovered
has not failed the year, and judging them on the term they happened to be ill in
is not something a head can defend to a parent. Terms with nothing computed
contribute to neither side of the fraction, so a school that adopts the system
in the second term is still judged on what it actually marked. A PUBLISHED card
is never re-decided behind the office's back.

`npm run verify:results` covers all of it, including the forced red: raising the
pass mark above the best mark in the class must repeat the whole class, and the
first term must leave every row `PENDING`.

## A term's roll is the term's YEAR, never the class today

A `ClassGroup` is a stream that outlives its pupils — "JHS 1 Gold" holds a new
cohort every September — so "who is in this class" means nothing until a year is
named. `rosterWhere(academicYearId, classGroupId)` in `src/lib/class-roster.ts` is
the one answer: that year's enrolments in the class, in any state but
`WITHDRAWN` (a finished year's rows read COMPLETED or REPEATED once the promotion
has run, and they are still the children who sat it), deleted pupils excluded.

⚠️ Until 2026-10-07 three rules disagreed. The mark sheet and remarks screen read
`Student.currentClassGroupId` — the class TODAY — so a 2024/25 sheet listed this
year's pupils; `computeClassResults` read every ACTIVE enrolment with no year, so
recomputing last year's third term after the promotion rolled up the new cohort
into it; and the save actions scoped by year but only to ACTIVE, so a finished
year's saves were silently dropped. Use `rosterWhere` for anything term-scoped.
`verify:results` builds a 1990 year with one of today's pupils in it and asserts
the engine computes that child alone — on the old engine it computed all four.

## Earlier years come from the school's paper records

GES expects a JHS 3 candidate's record to run back to JHS 1, and a school that
adopts School OS in a pupil's final year holds JHS 1 and JHS 2 only on paper.
`/results/records` (LEADERSHIP) takes them, in two steps:

1. **Earlier classes** (`/results/records/classes`) — for one of today's classes
   and an earlier year, which class each pupil sat in then. Written as an
   `Enrollment` for that year (status COMPLETED), so the term's roll is
   `rosterWhere` like any other. Each row is pre-filled with
   `proposeEarlierClass`: the level that many rungs down, same stream. It is a
   guess, labelled as one on every unsaved row; the office corrects repeaters,
   stream changes and late joiners. A pupil whose earlier year already holds
   results keeps their placement.
2. **Results from records** (`/results/records`) — one subject's TERM figures
   for that class: class score and exam score, or a total out of 100 when that
   is all the paper holds. Blank is no record, never zero. They go straight into
   `SubjectResult` with `source: RECORDS`, graded on the school's scale, and
   `rollUpRecords` derives the `TermResult` (same arithmetic as the engine: out
   of the level's curriculum, positions shared on ties), also `source: RECORDS`,
   status APPROVED.

⚠️ **Only a year that ENDED before the current one began takes records**
(`isEarlierYear`), re-checked in the action. The current year is marked on the
mark sheet, and two sources claiming one term is the bug this avoids.

⚠️ **Three guards keep RECORDS rows out of the computed path**, each with a test
in `verify:results` that fails when it is removed:

- `computeClassResults` treats a pupil with a RECORDS term as settled — there are
  no marks behind it, so a recompute would blank it — and never deletes a
  RECORDS subject line;
- `applyYearPromotion` never reads a RECORDS third term — that year's promotions
  were decided by people, years ago;
- `setResultsStatus` only ever moves COMPUTED rows, so records are never
  published, never shown in the portal and never texted to a parent.

A refused sheet hands back what was typed (`RecordsState.values`): React resets
the form when the action completes, and a refusal over one bad mark must not
wipe the thirty-nine good ones.

**The JHS cumulative record** (`/results/[studentId]/cumulative`, LEADERSHIP,
linked as "JHS record" from the pupil's page) prints every subject, every term,
JHS 1 to JHS 3, on one landscape A4 sheet on the letterhead. The grid is
`assembleCumulativeRecord` in `src/lib/cumulative.ts` — pure, pinned by
`verify:results`. A JHS level the pupil sat is shown with all three terms (a term
with nothing in it prints a dash, never disappears); a level BELOW theirs with no
enrolment is shown as "not recorded at this school"; a level above theirs is left
out; a repeated level shows both years. A column is marked R when its term came
from paper records and * when it is not yet approved, because a transcribed mark
and a computed one look identical once printed. No derived SBA figure yet: that
waits on the exact GES/WAEC rule.

**The JHS 1–3 broadsheet** (`/results/jhs-broadsheet`, LEADERSHIP, linked from
`/results`) is the class-wide companion: one of this year's JHS classes, pupils
down, subjects across, every JHS term on record. `assembleJhsBroadsheet` in
`src/lib/jhs-broadsheet.ts` is pure and pinned by `verify:results`. Each subject
cell is the pupil's AVERAGE term mark across the terms recorded, printed with
HOW MANY terms it averages — a missing term is left out of the average (dividing
by nine when three were never entered would print the school's paperwork as the
child's weakness) but the count keeps the hole on the page. The overall figure is
all marks over all marks available, the promotion rule stretched to three years,
and positions follow it, ties shared. It says on its face that it is a working
summary, not the official SBA figure. The loader is a fixed number of bulk
queries for the whole class — never per pupil — and only terms from years the
pupil spent in JHS count, so Basic 6 marks never leak in.

**The SBA figure (out of 30)** is `sbaFigure` in `src/lib/sba.ts`, the one place
the rule lives; the cumulative record prints it as a final column and the
broadsheet as a second VIEW of its subject cells (`?view=sba` — twelve more
columns do not fit landscape A4). The rule was the school's decision on
2026-10-08, because the public GES/WAEC material gives the 30/70 split and not how
the 30 is built: **class scores only** (never the exam), each term's class score
as a percentage of the class weight it was marked out of, **each JHS year
weighted equally** (terms averaged within a year first), then **scaled to 30**.
A term with no class score — a paper record entered as a total only — is left
out, never counted as zero, and the cell says how many years it rests on.

⚠️ Round half UP with a tolerance (`Math.round(v * 10 + 1e-9)`). 20.35 is
stored as 20.3499…, so plain rounding printed 20.3 against a head's hand
calculation of 20.4 — found by checking a real pupil's figure by hand, pinned
in `verify:results`.

⚠️ The loader scopes its level query to the pupil's school EXPLICITLY. Row
security does that in production, but a development database holds several
schools with RLS off, and the first render printed every JHS level twice — once
as the pupil's year and once as "not recorded".

## Mock exams are not term assessments

The BECE year (the top JHS level — found by stage and order, never by code:
provisioning calls it `B9`, the demo seed `JHS3`) sits mocks: `MockExam` per
sitting, `MockScore` per pupil per subject, out of 100. They are deliberately
NOT `Assessment` rows — `computeClassResults` adds every assessment in a term
into the report card, and a mock must never move a term's marks.

`mock-engine.ts` grades on the school's default scale and aggregates the BECE
way: **all four core subjects (ENG, MAT, SCI, SOC — matched by code, then name;
`Subject.isCore` is true for everything) plus the best two of the rest.** A
missing core subject or fewer than two others means NO aggregate rather than a
flattering partial one; absent is 0, the lowest grade. Positions are year-group
wide, ties shared. Nothing is stored — grades, aggregates and positions are
derived on read. Subject teachers enter marks for their own current-year
assignments (`/mocks` is MARKING), and `MARK_ANY_CLASS` (leadership and the IT
admin) for every class, as on the term mark sheet; the broadsheet, slips and
progress are ACADEMIC. `npm run verify:mocks` (CI, after the app starts) pins the aggregate
and drives the sheet as leadership, an assigned teacher and an unassigned one.

## The register, and the day nobody marked it

Attendance is a **daily** mark per child, taken by the form teacher on
`/attendance`: Present, Late, Excused or Absent. Late counts as present and
stays visible to the office; Excused counts as absent and carries a reason. One
register per class per day, enforced by a unique index, so re-marking in the
afternoon corrects the morning instead of opening a second one.

**Two tables, and the second is why the first exists.** `AttendanceDay` records
that the register *was taken* for a class on a date; `AttendanceEntry` hangs the
marks off it. The report card's denominator is "days the register was taken", and
that has to be a fact the database holds rather than something inferred from how
many children happen to have a mark — otherwise a day the teacher forgot is
indistinguishable from a day everyone was absent, and **the school's own
negligence prints as the child's attendance record**. A day nobody marked
produces no row and costs nobody an absence, exactly as a subject nobody
assessed invents no score.

**The denominator is per CHILD, not per class.** A child who joined in October is
marked out of the days they were actually here. That falls out of counting their
own entries rather than the class's days, and it is what makes a mid-term
admission read honestly.

`syncAttendanceTotals` (in `attendance-engine.ts`, *not* the actions file — every
export of a `"use server"` module is a callable endpoint, and this one takes a
transaction handle) writes `TermResult.daysPresent/daysTotal` on every save. It
runs only for a class whose register has actually been taken: a school still
keeping paper must not have its typed-in figures wiped by a module it has not
started using. `/results/remarks` asks the same question and renders those two
boxes read-only once the register exists, and `saveClassRemarks` drops the typed
values rather than letting a stale form field overwrite a derived number the
teacher never touched.

Deleting a day is `LEADERSHIP` only and recounts afterwards, or the card keeps a
deleted day in its denominator.

`npm run verify:attendance` covers it, and runs in CI **after the app starts**
because half of it drives the real `saveRegister` over HTTP — `mayMark`, the term
lookup and the roster check live behind `requireRole` and are unreachable from
engine code. Two forced reds: an absurd figure on a PUBLISHED card must survive
the sync and then be corrected once unpublished, and a class with no register
must come back `{students: 0, days: 0}` with its hand-typed 42 of 50 intact.

⚠️ Writing that HTTP half found two traps worth knowing before you write another
one. "Remove this day" is also a form and also carries `classGroupId`, and it
renders *first* — a loose form match posted to `deleteRegister` and destroyed the
day it meant to mark. And a plain `action={fn}` form carries `$ACTION_ID`, while
one driven by `useActionState` carries `$ACTION_REF_n` plus encrypted bound args
instead, so matching on `$ACTION_ID` excludes exactly the forms that matter.

## A class teacher sees three screens

A teacher signs in to do a small, fixed job — enter the term's marks for the
subjects they teach, write the conduct and remark for their class, and take the
daily register — so `TEACHER` appears on exactly three routes,
`/assessments/sheet`, `/results/remarks` and `/attendance`, plus a read-only
`/classes`, and nowhere else. That is the whole mechanism: `requireRole` then
refuses every other page without a separate list of prohibitions to keep in step
with the app.

⚠️ `/attendance` is the **one place a plain teacher writes about a class**, and
it is a deliberate exception to the rule below that every write on a class stays
`OFFICE`. Routing the register through the office would mean forty slips of
paper walking down a corridor every morning, which is the thing it replaces. The
role list is only the outer door; `mayMark` in `attendance-actions.ts` is the
inner one, narrowing a teacher to the class they FORM-TEACH. A subject
assignment used to count too, so a JHS subject teacher could take every register
they taught in; on 2026-10-09 the school asked for one class per teacher (the
Basic 1 teacher marks Basic 1 only), and the picker (`getRegisterSetup`) follows
the same rule. `verify:teacher` proves an assignment alone offers no register and
that a register forged for another class is refused by the action.

- **`MARKING`** (in `permissions.ts`) is those two screens and their actions —
  `openSheet`, `saveSheet`, `saveClassRemarks`. Everything else that used to be
  `ACADEMIC` is now `LEADERSHIP`; the `ACADEMIC` constant is gone, because a
  role list that no longer matches any screen is how the wrong page gets opened.
- **`MARK_ANY_CLASS`** (leadership + `IT_ADMIN`, added 2026-10-08 on the
  school's request) may enter marks, conduct and remarks for every class without
  a teaching assignment — the IT admin keys in what teachers hand in on paper.
  It is checked in `mayTeach`, in `saveClassRemarks`, in `saveMockSheet` and
  in all three screens' pickers; changing a component's total marks stays `LEADERSHIP`.
  `verify:it-admin` proves both pages and both actions with a probe that holds
  no staff record.
- **`isTeacherOnly`** distinguishes a teacher from a head who also teaches. A
  head keeps the whole app; only a login whose every role is `TEACHER` is
  narrowed.
- **`landingFor`** is where sign-in lands and where a refusal sends someone. It
  must never name a page the same person would be refused from — a teacher
  bounced off `/students` to `/dashboard` would be bounced again, and the two
  redirects would chase each other. The login action, `requireRole`,
  `redirectIfAuthenticated` and the platform gate all go through it.
- **`/dashboard` keeps `requireAuth` and redirects teachers explicitly** rather
  than switching to `requireRole`. A nurse or librarian has no listed role but
  still belongs there, and refusing them would send them back to `/dashboard`
  forever.

⚠️ **Hiding a nav link is not a guard.** Removing `TEACHER` from the `NAV` entry
does nothing to the page: `/students`, `/classes` and `/subjects` went on
rendering in full for a teacher who typed the URL, because their own
`requireRole([...OFFICE, "TEACHER"])` still admitted them. `npm run
verify:teacher` signs in as a real teacher and asks for every route by URL,
which is what caught it — run it after touching any role list.

## Passwords

Every account is created with a **temporary** password: the office reads it out
once and it is never recoverable. Until 2026-09-09 that password was also
*permanent* — the app had no change-password screen at all, for staff or
parents, and the guardian-login banner even told the office to "ask them to
change it", which was not something the software could do.

`/account/password` now does it, and `User.mustChangePassword` forces it.

⚠️ **The page lives OUTSIDE both `(app)` and `(portal)` deliberately.** Both
layouts divert a flagged session to it; if it sat inside either group that
redirect would land on itself and the two would chase each other — the same trap
`landingFor` exists to avoid for teachers. `verify:parent` asserts the divert
*and* that the page itself opens, so a future move back inside a group fails
loudly.

**Everything that issues a temporary password sets the flag** — `createUserAccount`,
`resetUserPassword`, `createGuardianLogin`, and `provisionSchool` for a school's
very first proprietor. Add the flag to any new one, or that account keeps a
read-aloud password forever.

`changePassword` requires the CURRENT password (a session left open on a shared
phone must not be enough to take the account over) and deletes every OTHER
session on success, so a password changed *because* it leaked actually ends the
leak. It clears the flag and stamps `passwordChangedAt`.

`mustChangePassword` rides on `AuthContext` rather than being queried in the
layouts: `getSessionUser` uses `include: { user: … }`, which already selects
every user scalar, so reading it costs nothing. Querying it separately added a
round trip to every page load, which on this link is seconds.

## The platform admin has a second factor

The Nanicle console (`/admin`) reads every school and can change their subscriptions and
trigger backups, so one password is not allowed to open it. **Authenticator-app codes
(TOTP, RFC 6238) are mandatory for any `isPlatformAdmin` user**, enforced in
`requirePlatformAdmin()` (`src/lib/platform-auth.ts`) — i.e. on every console page AND every
console server action:

- not enrolled → sent to `/admin/security` to enrol; the console stays closed until they do;
- enrolled → the *session* must have passed the code check (`Session.mfaVerifiedAt`), so a
  stolen password or a cookie issued before the code was entered opens nothing;
- tenant pages are unaffected — only the console is gated.

How it works: `src/lib/totp.ts` (HMAC-SHA1, 30s, 6 digits, ±1 step; replay protected by
`User.totpLastStep`, spent with a conditional UPDATE so two requests cannot both use a code),
`src/lib/totp-crypto.ts` (the secret is AES-256-GCM encrypted under **`TOTP_ENCRYPTION_KEY`**
before it is stored; it fails closed with no key), `src/lib/platform-2fa-actions.ts`
(enrol / verify / regenerate recovery codes / replace authenticator). Ten one-time recovery codes
are shown once at enrolment and stored as SHA-256 hashes. Attempts are limited per account (8)
and per address (30) per 15 minutes, and a locked account refuses even a correct code.

⚠️ **`TOTP_ENCRYPTION_KEY` must exist in the deployment before the first admin visits the
console**, or `/admin/security` shows the missing-key message and the console stays closed.
Generate with `openssl rand -base64 32` and keep a copy with the other deployment secrets. Losing
it only means admins must enrol again.

Lost phone **and** recovery codes: there is deliberately no screen that turns the factor off (a
screen that can would be a way around it). With database access run
`node --env-file=.env.prod scripts/reset-platform-2fa.mjs <email>`: it clears the factor and ends
every session; the admin signs in with their password and enrols again.

Tests: `npm run verify:totp` (RFC 6238 vectors, replay, window, encryption, recovery hashing; no
database; runs in CI).

## The subscription is MONTHLY

`paidUntil` is the date a school is paid to, and **ACTIVE means "paid up to that
date"** — not a permanent state. Reading the status alone is how a school that
stopped paying in March is still marked Active in September, which is the dead
field this whole area exists to end.

- past the date, a school keeps working for **7 grace days** and is told how many
  are left. School money arrives in the first weeks of term and thins out after,
  so a monthly bill will routinely be paid late in the months when the office has
  nothing in hand; cutting them off the morning after turns a cashflow gap into
  an argument.
- past grace it is read-only, the same as PAST_DUE or SUSPENDED.
- ⚠️ **ACTIVE with no `paidUntil` is NOT arrears** — that is a school being set
  up by hand, and punishing a missing field would be wrong.

⚠️ **`nextDueDate` advances from the date HELD, not from today.** Billing from the
payment date shortens every late month — pay four days late, get twenty-six days
— and across a year the school pays thirteen times without anyone deciding to
charge them that. It falls back to today only when the lapse is so old that
advancing would still leave them overdue, because taking money and handing back a
read-only system is indefensible.

⚠️ **Console routes are fully dynamic, and were slow to trust.** While the dev
database was recovering, a server action took **15 seconds** to return — long
enough that a headless test polling for 24s concluded `revalidatePath` had failed
and a `router.refresh()` was needed. It was not: with a realistic wait, the
confirmation and the re-rendered date both arrive on their own. Before adding a
refresh to any console screen, check what the database is doing.

**Bulk parent logins and SMS delivery of the temporary password shipped in PR #24**
(`/guardians/invites`).

## A parent who has forgotten their password

`/forgot` texts a 6-digit code to the number the school holds, and the parent
chooses their own password. It exists because the office reading a new password
down a phone line does not scale past the four hundred logins one afternoon on
`/guardians/invites` can create.

The rules, all of them refusals, all proved by `npm run verify:reset` (17 checks,
no dev server needed, in CI):

- **PARENT logins only.** Staff have the office, on `/users`, with an audit trail
  — and a staff login sees the whole school, so a self-service route into one is
  a far bigger door than this needs to open.
- **"Sent" and "no such number" answer identically.** Anything else turns the box
  into a way to ask whether a number belongs to a parent at the school.
- A code lasts **15 minutes**, works **once**, and dies after **5 wrong guesses**;
  asking for a new one kills the old. Three per number per hour.
- Only the **sha256** is stored, like a session token — a code sitting in the
  database, or in the message log, would be a reset anyone with read access could
  complete. The log records that a code was sent, never the digits.
- Success **ends every session** for that user: a reset asked for because
  something went wrong has to end it.

⚠️ **It refuses to start when no gateway is configured**, and says so, rather than
telling a parent to wait for a text that cannot arrive. That check runs BEFORE
the phone-number lookup, deliberately: whether a gateway exists is a fact about
the deployment, but "we cannot deliver to *you*" would be a fact about the
number, and that is the enumeration the rest of this is careful to avoid.

`SMS_DRY_RUN=1` forces a dry run even with credentials, which is what lets the
suite exercise the flow without texting anyone or calling Arkesel from CI.

⚠️ **`PasswordReset` carries no `schoolId`.** The flow runs before anyone is
signed in, so there is no tenant context to scope by — and since the guard in
prisma.ts, a tenant-scoped query without one is refused outright. It sits outside
RLS exactly as `Session` and `User` do, so the prod-rls tenant count stays 41.
Every query in `password-reset.ts` goes through `withBypass` for the same reason.

## The SMS gateway

`sendSms` DRY-RUNS unless `SMS_PROVIDER` and `SMS_API_KEY` are both set where the
app runs: the message is recorded, costed and shown in Messages, and nothing
leaves the building. That is the deliberate default, and it means "we set the
variable" is not evidence of anything.

**Settings → SMS has "Send a test"**: one message, to a number the office types,
using the school's own provider and sender ID, ungated by `smsEnabled` so the
wiring can be checked BEFORE any parent hears from the school. It reports the
gateway's own words, and records what it sent in the message log — a test costs
the school a message like any other, and the Spend figure totals that log.

⚠️ **These three integrations had never executed once** before 2026-09-10. When
first run against the real gateways (with a deliberately invalid key, so nothing
could be delivered), all three answered — Arkesel "Invalid key", mNotify "invalid
api key…", Hubtel "Something terribly happened while processing your request".

- **Arkesel is on v2**: `POST https://sms.arkesel.com/api/v2/sms/send`, key in an
  `api-key` HEADER, body `{sender, message, recipients[]}`, success
  `{"status":"success","data":{"id":…}}`. The v1 query-string form this shipped
  with still answers (422 `{"code":"102"}` for a bad key), so it was not broken —
  but it is undocumented in Arkesel's current guide and puts the API key in a URL,
  where proxies and access logs keep it.
- **Hubtel's credential is a PAIR.** `SMS_API_KEY` takes `clientid:clientsecret`
  and is base64-encoded for you; passing it raw into `Basic …` (as this used to)
  silently required a pre-encoded value and returned an unexplained 401.
- Every call is bounded by a 15s timeout and reads the body as TEXT before
  parsing: a gateway error page is HTML, so `res.json()` throws and the school
  reads "Unexpected token <" where the reason should be.

⚠️ **An unregistered sender ID is the usual reason a text is accepted and never
arrives.** It is at most 11 characters and must be registered with the provider;
that registration takes days in Ghana, so start it before you need it.

## The parent portal

A guardian signs in and sees their own children: what is owed, the receipts the
school has issued, and the report cards it has **published**. Nothing else.

Routes live in their own group, `src/app/(portal)`, with their own layout — no
navigation rail, no search, no term countdown. Those are tools for running a
school, and a parent checking a balance on a phone should not be handed chrome
that implies they can act on the school's behalf.

⚠️ **Look at the portal on a PHONE.** `npm run shots:portal` mints a session for
a real parent login and walks it at 390px. Both faults found the first time
anyone did (2026-09-11) were invisible on a laptop: the child row's class and
admission number truncated to "Kindergarten 1 A · S…" — the line a parent with
two children uses to tell the rows apart — and a receipt read **MOBILE_MONEY ·
TELECEL**.

That second one is worth remembering as a shape. The portal kept its own
`Record<string, string>` of method labels, keyed `MOMO` and `BANK`, values that
do not exist — the enum is MOBILE_MONEY, BANK_TRANSFER, BANK_DEPOSIT — and the
`?? method` fallback made every miss invisible. Three of six methods printed raw
to parents. `src/lib/payment-labels.ts` now holds the only copy, typed
`Record<PaymentMethod, string>`, so a value added to the enum without a label is
a BUILD failure. Prefer it to `.replace(/_/g, " ").toLowerCase()`, which each
staff screen was doing separately — that drift is why nobody noticed the portal
disagreeing.

⚠️ **RLS does NOT isolate one family from another.** Postgres scopes every query
to the school, and two parents at the same school are the same tenant — so the
`tenant_isolation` policy is satisfied by another family's child exactly as
readily as by their own. Family isolation is application code, and it lives in
ONE place: `src/lib/portal-auth.ts`.

- `requireGuardian()` resolves the children from the SESSION's guardian id.
- `requireMyChild(studentId)` checks a URL id against that set and calls
  `notFound()` otherwise — **404, not 403**, so a parent cannot tell "not yours"
  from "does not exist" and enumerate the roll one id at a time.
- Every function in `portal-data.ts` takes ids the session resolved, never an id
  from the request.

`Membership.guardianId` is the only trustworthy answer to "which family is
this". Note that one user can hold several memberships in the same school — the
unique key is (school, user, role) — so `requireAuth` gathers `staffId` and
`guardianId` across all of the active school's memberships rather than reading
them off whichever row sorted first. A proprietor whose own child attends holds
both, and the old code would have picked one at random.

**Publication is a second, independent check.** `getReportCard` in
results-data.ts deliberately does not filter by status — staff may read a draft,
that is what the approval flow is for. The portal therefore goes through
`getPublishedReportCard`, which confirms `status: "PUBLISHED"` BEFORE fetching
anything and returns null (rendered as 404) otherwise, so the portal never
confirms that an unpublished result exists.

**A parent login is created from the guardian's own record**, not from `/users`.
A PARENT membership without `guardianId` signs in to `/no-access`, and `/users`
never knows which guardian is meant — so `ASSIGNABLE_ROLES` still excludes
PARENT on purpose, and `createGuardianLogin` on `/guardians/[id]` is the way in.
It refuses a guardian with no children linked, because that login would open an
empty portal that reads as though the school had lost the child.

⚠️ **`/dashboard` is guarded by hand, and that is where this leaked.** It uses
`requireAuth` plus explicit redirects rather than `requireRole`, because a nurse
or librarian holds no listed role and still belongs there. The first release of
the portal added `isParentOnly` everywhere EXCEPT that page, so any guardian who
typed `/dashboard` got the school's attention list, collections chart and
activity feed — a 200, fully rendered. `npm run verify:parent` caught it on its
first run. Anyone whose home is elsewhere must be named in that check.

`npm run verify:parent` (needs `npm run dev`) signs in as a real parent and asks
for another family's child BY URL, plus every staff route, plus an unpublished
report card. 33 checks. It creates one user and one membership and deletes both;
where the seed publishes nothing it forces a draft to PUBLISHED, looks, and
restores it — so no check silently skips.

## Teaching assignments

One row means *this teacher teaches this subject, to this class, in this academic
year*, unique on that combination. Four things read it:

- the class and subject pickers a teacher is offered (`getSheetOptions`);
- whether opening or saving a sheet is allowed (`mayTeach` in `sheet-actions`);
- who may write a class's conduct and remarks — at **class** level, not subject
  level, because the form teacher may not teach every subject
  (`saveClassRemarks`);
- the teacher name frozen onto `SubjectResult` at publish time
  (`results-engine`), which is what reprints on a report card a year later.

It is **not** the form teacher: that is `ClassGroup.formTeacherId`, set on the
class page, and it is pastoral. A form teacher with no assignment in their own
class cannot open a mark sheet or write its remarks.

⚠️ **Always filter assignment queries by academic year.** They were stored per
year and displayed per year (`/staff/[id]` lists only the current one) but
enforced across *all* years, so a teacher silently kept the classes they taught
last year — invisibly, since the screen that would show it filters them out. The
same omission let a previous year's teacher win the report card's name lookup.
All four call sites now scope by year: the two guards and the picker take the
current year, and the results engine takes the *term's* year, not the current
one, because a term being computed may belong to a year that is no longer
current. `npm run verify:teacher` proves both directions — a prior-year
assignment opens nothing, the same row moved to this year opens the sheet.

**Setting them up is per class, not per teacher.** The GES curriculum gives a
level 4–12 subjects, so a school with one stream per level needs 104 assignments
before anyone can mark; adding them one at a time from `/staff/[id]` is not a
setup path, it is a correction path. `/classes/[id]` lists every subject the
class's **level** offers with a teacher beside each, saved in one submit, plus
"give every subject to…" for the class-teacher model that KG and lower primary
actually use. The rows come from `LevelSubject`, so KG is never offered
Mathematics, and the action re-reads them server-side rather than trusting the
form. A row left blank deletes its assignment — that is how a mistake is undone.
Where this year is empty and last year is not, the form pre-fills from last year
and says so; nothing is written until Save, which is what stops a rollover
meaning 104 fresh submissions.

**The screen follows the level's staffing model**, which in a Ghanaian basic
school is not uniform: through KG and primary one class teacher takes every
subject, and from B7 each subject has its own teacher. So on a class-teacher
level (`CLASS_TEACHER_STAGES` in `class-data.ts`) every row is pre-filled with
the class's **form teacher** and the screen says so; at JHS nothing is
pre-filled, because a suggestion there would be a wrong answer already entered.
A class-teacher level with no form teacher set says that instead of asking
someone to pick the same name nine times — the fix is the form teacher field,
not these rows.

## The look

The palette lives in ONE place: the `@theme` block in `src/app/globals.css`.
Screens are written in Tailwind's colour names, so re-tinting the product is
editing that block rather than a thousand class attributes — which is what made
the re-skin affordable. Three groups:

- **`slate-*` is redefined, not replaced.** Tailwind's stock slate is blue-grey
  and reads cold; these are the same ramp pulled towards green-grey. Every
  existing `text-slate-600` picked up the warmth for free.
- **`brand-*` does two jobs.** `brand-600` is the live green primary actions wear;
  `brand-800`/`900` are the near-black greens the navigation rail is built from.
  One family, so the rail and the buttons read as the same school. Print keeps
  the deep end — `brand-800` — because a live green prints thin.
- **`accent-*` is gold, and rationed.** It marks the one figure on a screen that
  decides what someone does next: the outstanding balance, the active rail item,
  the motto on a report card. Nowhere else, or it stops meaning anything. Only
  600 and 700 have enough contrast for text on white.

Type is **Plus Jakarta Sans** for the app — it carries the 800 weight the
headings need and tabular figures that keep a column of cedis from shifting.
**Newsreader** stays, but ONLY for print: the masthead of a report card and of a
fee invoice (`.font-display`). A serif page title read well on paper and looked
apologetic on a dashboard, so the app's headings are `.font-heading` — bold sans,
tight tracking. Both are self-hosted by `next/font`.

**The rail** (`nav.tsx`) is icon-first and carries the school's identity, so the
header does not repeat it. `NavItem.icon` keys into the icon set there; a new
nav entry needs one. The bottom corner is not decoration — it holds the current
term and how many days until it closes, which is the one thing a head teacher
wants permanently in view.

⚠️ **`inputClass` is `w-full`, and Tailwind orders utilities by its own rules,
not by the order you write them.** A `${inputClass} w-44` beside it silently
lost, so every filter row on every list screen stacked one control per line for
as long as those screens have existed. `filterClass` is the same field with the
width stripped — derived from `inputClass` so the two cannot drift. Use it for
anything sized inline; `inputClass` stays for fields that should fill their
column.

**Rows about a person carry an `Avatar`** — initials in a tinted square — and
their name and admission number stacked in one cell, rather than a separate
column of numbers nobody reads top to bottom. `ScoreBadge` colours a mark out of
100 (green ≥70, amber ≥50, red below) so a teacher scanning the total column
sees who is struggling without reading a number.

⚠️ **Only the BEST-matching nav item is active, not every prefix.**
`/assessments/sheet` starts with `/assessments`, so a plain `startsWith` test lit
Mark sheet and Assessments at once. `NavLinks` picks the longest matching href
across all sections. Note React emits `aria-current` BEFORE `href`, which will
break a naive test regex.

**Dark mode is BLACK**, not a dark green — the green is the brand's accent
against it. Built 2026-09-11, and the shape of it is the part worth keeping:

**Nothing in the app says `dark:` anywhere.** The screens are written in
`slate-*`, `brand-*` and `bg-surface`, and `html.dark` in globals.css gives those
same names different values. The slate ramp INVERTS — slate-50 is the page a
screen sits on and slate-900 is the text, in both themes — which carried ~990
utilities across untouched. Only `bg-white` needed replacing (84 of them, now
`bg-surface`), because white cannot follow a theme.

Three things that are easy to get wrong here:

- ⚠️ **A token used as a FILL cannot be lightened for text.** `brand-700` is
  13 text uses and 28 `hover:bg-brand-700` fills; lightening it for legibility
  put white button labels on mint. `brand-600/700/800` are untouched and
  `--color-brand-ink` carries brand-coloured TEXT instead. Lightening `brand-800`
  also turned the navigation rail — `from-brand-800 to-brand-900` — into a pale
  green panel.
- ⚠️ **Paper is paper.** A report card and a fee invoice are documents about to
  be printed, so they carry `.paper`, which re-asserts the light values for their
  subtree; a custom property resolves from the nearest ancestor that sets it, so
  it beats `html.dark`. `@media print` does the same for everything else, or a
  class list prints as a black page and the school buys the toner.
- ⚠️ **Status pills are Tailwind's own families** (`bg-green-50 text-green-700`
  and friends, ~95 uses). Left alone they stay bright islands on a black page, so
  each pair is re-cut in the dark block.

The theme is a class on `<html>`, set from localStorage by a script in the root
layout BEFORE first paint — a theme applied after hydration means every dark page
opens with a white flash, worst at night, which is when the setting is for. The
toggle reads that class with `useSyncExternalStore` rather than copying it into
state.

**Skins (2026-09-20).** `data-skin` on `<html>` — `oneui`, `oxygen`, `pixel`, or
absent for Classic — is the same mechanism as `.dark` and composes with it: a
skin re-cuts SHAPE, TYPE and SURFACE tokens (radii, shadows, materials, the
`--text-*` scale, `--color-surface`/`slate-50`), light/dark keeps deciding
colour. The blocks live under "SKINS" in globals.css; THEME_SCRIPT restores the
choice before paint; `SkinPicker` (skin-picker.tsx) sits beside `ThemeToggle` in
both layouts. The brand green is untouched in every skin on purpose — Pixel is
Material You seeded from the brand, not purple. The two shared headings in
`ui.tsx` carry `.card-title` / `.page-title` hooks so a skin can restyle them
without touching a screen; add the hook, never a `[data-skin]` selector, to a
screen file. `SHOT_SKIN=oneui npm run shots` captures a skin.

⚠️ **`npm run shots` and `shots:portal` reuse one Chrome profile**, so they now
always write `theme` to localStorage rather than only when dark — a dark run
otherwise leaves the setting behind and the next light run silently captures dark
screens, which is a very convincing way to verify the wrong thing. `SHOT_THEME=dark`
for the other palette.

**The crest and the head's signature** are uploaded on `/settings/branding` and
print at the head and foot of a report card, and at the head of a fee invoice.

The bytes live in their own table, `SchoolAsset`, and NOT on `School`:
`getSessionUser` does `include: { school: true }` on every request and Prisma
selects every scalar field, so a `Bytes` column there would drag the image into
every page load. `School` keeps only the pointer (`crestUrl`,
`headSignatureUrl`), which costs nothing to carry and tells a report card
whether to render an image at all without a second query. The pointer carries a
version (`?v=…`) so a replaced crest is never served from a stale cache.

`/api/school-asset/[kind]` serves them, and deliberately does NOT call
`requireAuth` — that resolves the user, their memberships, the school row and
the staff record, a heavy join to repeat for a 2 KB image. It reads only which
school the session is in: 7.6s → 4.3s per image on this link, and the remainder
is two round trips to Frankfurt, not the query. It answers 404 rather than
redirecting, because a signed-out browser should get a broken image and not a
login page decoded as one.

**SVG is refused** on upload. It is a document format that executes script, and
these files are served to every parent who opens a report card.

`npm run shots` captures the signed-in screens with headless Chrome over CDP
(no Puppeteer — Node's global WebSocket drives it). It mints a session for the
demo proprietor, and **disconnects Prisma before opening the browser**: with
`connection_limit=1` a client left open starves the dev server, and every page
screenshots as Next's "a server error occurred", which looks exactly like a
styling bug and is not one.

## On a phone

⚠️ **`backdrop-filter` makes an element the containing block for every
`position: fixed` DESCENDANT** — the same rule `filter`, `transform`,
`perspective`, `contain` and `will-change` have. The header is
`backdrop-blur-xl` because `--color-chrome` is 80% opaque, and the phone menu
was rendered inside it, so `fixed inset-0` resolved to the 64px header strip
rather than the viewport.

Nothing threw. The button worked, React set the state, and all twenty links were
in the DOM — laid out 276px wide and **63px tall, behind the page**. To a head
teacher holding a phone, the menu button simply did nothing, for as long as the
app has had a menu. The drawer is now portalled to `<body>`, which is the only
place outside every filtered ancestor; do not move it back inside the header to
tidy it up, and do not wrap either in anything carrying those properties.

It needs no "have we mounted" flag: `open` starts false and only a click can set
it, so the server never reaches `createPortal` and `document` always exists by
the time it does.

⚠️ **A grid or flex item will not shrink below its content.** `min-width: auto`
is the default, so a child whose min-content width exceeds its track pushes the
whole PAGE sideways rather than clipping. `CollectionsChart` uses fixed 44px
columns on purpose (see that section), and nine weeks of them made the dashboard
436px wide inside a 390px phone. Chrome's mobile emulation quietly zooms out to
fit; **a real iPhone does not — it lets the page slide under the thumb.** The fix is
`min-w-0` on the grid children AND `overflow-x-auto` on the fixed-width row, and
they do different jobs: min-w-0 lets the column shrink to its track, and the
scroll gives the fixed 44px slots somewhere to go — `Card` is
`overflow-hidden`, so without it the later weeks are simply clipped away with no
way to reach them.

**`npm run verify:mobile-nav` is what stops both returning**, and it is in CI. It
measures and hit-tests rather than querying, which is the whole point: every
other guard in this repo asks the DOM what EXISTS, and the menu existed — run
against the broken drawer, **four of this script's own six checks at the time
still passed**, and only the two that measured geometry and hit-tested a link
failed. It also asserts the viewport it actually GOT, not the one
it asked for: the overflow made the emulator report 453px, which is still under
`lg`, so the rail still collapsed and every check still passed at a width no
parent holds.

## Installable

The app is a PWA — `public/manifest.webmanifest`, an icon set, and a service
worker registered at idle in production only. `start_url` is **`/login`**, which
is the trick worth keeping: it already calls `redirectIfAuthenticated`, so one
entry point lands a proprietor on `/dashboard`, a class teacher on
`/assessments/sheet` and a parent on `/portal`, and the manifest needs to know
nothing about roles.

Icons and install screenshots are GENERATED (`scripts/make-icons.mjs`,
`scripts/make-screenshots.mjs`) rather than pasted in, so the mark cannot drift
from the `#12805c` rounded square the login page draws. `maskable.svg` is a
separate drawing, not a resize: Android crops a maskable icon to the launcher's
shape, so it bleeds to the edges with no radius of its own.

⚠️ **The screenshot script REFUSES to run against a database holding any school
but the demo**, and refuses a platform admin for the staff shot. Those images are
public — served to anyone who sees the install prompt — so shooting a real school
would publish its pupils, fees and marks, and the manifest has no idea whose
faces are in its screenshots. The admin rule is the same lesson `marketing.tsx`
learnt: their header carries a "Nanicle console" button no customer will ever
see.

⚠️ **The service worker caches `/_next/static/` and NOTHING else.** Two separate
reasons, and both were learnt the hard way:

- **No page navigations.** Every screen is a signed-in, tenant-scoped read — a
  report card, an invoice, a family's balance. Caching that HTML writes one
  person's data to the device in a store that outlives their session, and on the
  shared phone a Ghanaian family actually uses, the next person could be served
  it after the cookie is gone. RLS and `requireMyChild` guard the database;
  neither can guard a cache we filled ourselves.
- **Nothing at an unhashed url.** The first version cached the manifest and the
  icons too — static and tiny, so it looked free. A hashed asset gets a new
  filename when its bytes change and so can never be stale; `/manifest.webmanifest`
  keeps one url for ever. Adding the install screenshots proved it: Chrome went
  on reporting a manifest with no screenshots, reading the copy the worker had
  cached before they existed, and it would have stayed wrong for every installed
  user until `CACHE` changed.

So it does not work offline, and does not pretend to — nothing here renders
without the database anyway, and an offline launch gets the browser's offline
page rather than a stale report card.

**A signed-in school gets ITS OWN crest as the home-screen icon**, not the
generic mark. `/manifest.webmanifest` above is the anonymous default — logged
out, or a school with no crest uploaded. Once `(app)/layout.tsx` or
`(portal)/layout.tsx` resolves a session, their `generateMetadata` points
`manifest` at `/api/manifest?school=<id>&v=<crest version>` instead, which
reads the SAME static file off disk and swaps only its `icons` array — one
source of truth for name, description, colours; the crest is the only thing
allowed to differ per school.

`/api/school-icon/[schoolId]/[variant]` (`src/lib/school-icon.ts`) composites
the raw crest — uploaded for print, so no guarantee it is square or padded —
onto a white square with `sharp`. The maskable and apple-touch variants shrink
the crest further first, into the W3C safe zone, because a crest has no
hand-drawn `maskable.svg` twin to bleed full-frame the way the generic mark
does.

⚠️ **Neither route may read the session cookie, because neither ever gets
one.** A `<link rel="manifest">` is fetched with credentials mode "omit" unless
it says `crossorigin="use-credentials"` (Next adds that only on Vercel
previews), and the OS's icon fetches drop cookies too. The first version of
`/api/manifest` read the session, saw nobody on every real install, and
redirected to the generic file — so every school's home screen showed the green
"S" while the page head named the right crest. Both are keyed by school id in
the url and public, which is safe: a crest is printed on every bill. Both urls
carry the crest's own `?v=` token (`schoolIconUrls` in
`src/lib/manifest-data.ts` borrows it rather than minting a second one), so a
re-upload changes the url instead of the bytes behind it.

A school with no crest gets a 404 from `/api/school-icon/*` and a redirect
from `/api/manifest` back to the generic file — decided one layer up, in
`generateMetadata`, which returns `{}` and lets the root layout's defaults
show through untouched rather than the icon route guessing at a fallback of
its own.

## "Needs your attention"

The dashboard's first card is four computed rules, each a sentence and the link
that resolves it — `getAttention` in `dashboard-data.ts`:

- **Marking** — an assessment in the current term, not `APPROVED`, with fewer
  scores than its class roster. Approval means finished whatever the score count
  says, so an APPROVED sheet is never chased.
- **Results** — `TermResult` rows that are computed but not `PUBLISHED`: a
  report card nobody can see.
- **Staffing** — a class whose level offers more subjects than it has teaching
  assignments for, scoped to the current year. That class has a mark sheet
  nobody can open.
- **Fees** — handed the counts the stat cards already computed, so the debtors
  are not queried twice.

Five aggregate queries, deliberately. This runs on every dashboard load over a
link where a round trip is seconds, so a rule needing a per-row query does not
belong here.

⚠️ **The demo seed satisfies three of the four rules**, so they are silent by
default and a broken one would look identical to a quiet one. `npm run
verify:attention` therefore has two halves: it recounts each rule the long way,
then FORCES each condition — removing a teaching assignment, reopening an
assessment and dropping two of its scores — and asserts each item appears, says
the right number, and clears when the data is put back. It writes, and restores;
development databases only.

⚠️ The `Score` value column is **`rawScore`**, not `score`. Writing `score:` in a
create is silently accepted by `tsx` (esbuild strips types without checking) and
lands a NULL — which reads as "not marked" rather than failing. Run
`node_modules/.bin/tsc --noEmit` over scripts, not just the app.

## The weekly collections chart

Buckets **allocations against this term's invoices**, not payments by date. The
two differ — a payment made in week 3 can settle last term's arrears — and the
"Collected" stat card reads `invoice.amountPaid`. Bucketing allocations makes the
bars sum to exactly that figure, which `verify:collections` asserts: a chart that
quietly disagrees with the number printed above it is worse than no chart.

Design decisions worth keeping:

- **The accent marks the CURRENT week, not the biggest one.** Colour has to
  follow the entity rather than its rank, or the highlight jumps around as money
  comes in and stops meaning anything.
- **One series, so no legend** — the card title names it. Two values are printed
  (current week, best week); the rest are on hover, and all of them are in an
  `sr-only` table.
- **The window covers weeks elapsed OR any week holding money**, whichever
  reaches further. Trimming to "weeks elapsed" alone hid a week whose payments
  were dated ahead of today — the seed does exactly this — leaving bars summing
  to zero under a subtitle reading GH₵26,542.

⚠️ **Bar heights are in PIXELS.** A percentage height needs a parent with a
definite height, and inside a flex row with `items-end` the columns size to their
content — so the first version rendered week labels with no bars at all, and it
looked like missing data rather than broken layout.

⚠️ **The columns are a fixed 44px, and that is what made the dashboard wider
than a phone.** The fixed slot is deliberate — stretching two weeks across a
full-width card left a bar stranded in 500px of nothing — but nine of them is
436px, and a grid item will not shrink below its content. The row therefore
carries its own `overflow-x-auto` and the grid column carries `min-w-0`. Keep
both if you touch either; see "On a phone".

## Live activity

The dashboard's activity feed is a READER over `AuditLog`, which every money and
grade mutation has written since the first commit and which nothing displayed
until now. `getActivity` adds no records; it phrases existing ones.

Two fragile edges, both guarded by `npm run verify:activity`:

- **The phrase map must cover every action the app writes.** `ACTIVITY_ACTIONS`
  is exported so the verifier can grep every `action: "..."` in `src/lib` **and
  `src/app`** and assert each one has a phrase — otherwise a new `writeAudit`
  reaches a head teacher's dashboard as "invoice generate". It checks the
  reverse too: a phrase for an action nobody writes is dead weight.

  ⚠️ **This guard has now been caught looking in the wrong place twice, and the
  pattern is worth recognising before it happens a third time.** First it walked
  only `src/lib`, so `data.export` — audited from a route — reached the
  dashboard as a raw string. Then the scan itself read
  `/action: "([a-z][a-z.]+)"/`: lowercase and dots only, so every camelCase
  action was invisible to BOTH halves of the check. Eight were hiding there,
  including `score.saveSheet`, the most frequent write in the app — the feed had
  no words for a teacher entering marks, and the guard reported green because it
  never looked. The pattern now allows capitals.

  Both bugs share a shape: **the guard was green because of what it could not
  see**, which is the failure mode a guard is least able to report on itself.
  When you touch this check, delete a phrase on purpose and watch it go red
  before you trust it.
- **`after` is untyped JSON from twenty-five call sites.** Every field is read
  defensively (`money()`, `count()`, `plural()`), so one row with a missing key
  degrades to "Payment of an amount received" instead of taking the dashboard
  down.

Relative timestamps are resolved in the data layer, not the component — reading
the clock during render trips `react-hooks/purity`, as `daysUntil` in the app
layout already had to learn.

⚠️ **The demo seed writes no audit rows** — it inserts directly — so the feed
shows its empty state on a freshly seeded database. That is correct, not broken.
To see it populated, insert rows and delete them again.

## Before you push

```
npm run check:fast     # source-only guards, ~40s
npm run check          # every offline guard, CI's own order (~15 min on this link)
npm run check -- --http  # plus the app-backed ones, with the app running
npm run hooks:install  # once: check:fast runs before every push
```

⚠️ **The guards below were all here, all passing, and none of them ran until a
push.** One pull request went red in CI three times — a hand-rolled table where
`DataTable` was required, an uppercase label, two audited actions with no phrase
— and every one of those answers was sitting in a script on this machine the
whole time. A check nobody runs is a check that does not exist, and "remember to
run them" had already been the plan.

`scripts/check.mts` **reads the list out of `.github/workflows/ci.yml`** rather
than keeping its own. A second copy of "what we check" drifts the moment someone
adds a step to one and not the other, and the copy that is wrong is always the
one you are looking at. It also derives, from the workflow's own ordering, which
guards need the app running — anything after *Start the built app* — and refuses
to look successful if a `verify:*` script exists that CI never runs. It found two
on the day it was written: `verify:export:route` and `verify:platform:sql`. Both
are wired into CI now — 70 assertions that no pipeline had ever executed.

⚠️ **That refusal printed its warning and then exited 0**, so the finding it
reported on day one survived a green run and a merge. A check that names a
problem and then says everything is fine is the thing it is complaining about;
it fails the run now, in `--fast` too, since it costs nothing to evaluate
(`package.json` and `ci.yml`, both already read) and the pre-push hook should
catch it. Forced red by un-wiring one guard: exit 1, naming it.

**The two tiers are not arbitrary.** A guard invoked with `--env-file=.env`
reads the database; one without it reads only source. That is what the command
already says, so `--fast` cannot fall out of step the way a hand-kept list of
"the quick ones" would. It matters because the database is in Frankfurt: the
source-only guards take about a second each, the database-backed ones up to
three minutes. Hence a forty-second gate before every push and a full run before
opening a pull request — a gate that takes fifteen minutes is one people learn
to skip, and a skipped gate protects nothing.

⚠️ **Do not pipe a verify script through `head` or `grep`.** Closing the pipe
SIGPIPEs it before its own cleanup runs, which leaves `entityId: "verify"` rows
behind and fails the NEXT run's final assertion on work that was never wrong.
`check.mts` captures output instead of piping it, for exactly this reason.
Redirect to a file if you need to read one directly.

## Verification scripts

There is no test runner yet; these scripts exercise the real engine code against
the seeded database and are the fastest way to know a change didn't break the
arithmetic.

```bash
npm run db:verify        # money: payments == allocations == invoice balances
npm run verify:results   # grading, weighting, ranking, aggregate
npm run verify:sms       # phone normalisation, GSM-7 vs UCS2 segments, merge fields
npm run verify:audience  # who a campaign would reach, dedupe, debtor filtering
npm run verify:invoicing # which fee structure applies, and why a student was skipped
npm run verify:actions   # the server-action guards — needs `npm run dev` running
npm run verify:isolation # RLS coverage and cross-tenant reads/writes
npm run verify:onboarding # walks every screen of a school provisioned minutes ago
npm run verify:teacher   # a teacher reaches the two marking screens and nothing else,
                         # and an assignment counts only for its own year
npm run verify:parent    # a parent sees their own children and NOT another family's,
                         # never an unpublished report card, and a temporary
                         # password diverts to /account/password
npm run verify:reset     # forgotten-password: wrong, spent, expired and guessed
                         # codes are all refused; staff and strangers get nothing
npm run verify:mobile-nav # the phone menu opens and covers the screen, and no
                         # page scrolls sideways — needs a server and Chrome
```

`verify:actions` is the only one that goes over HTTP, because the guards it
checks (a forged write against a frozen grading scale, demoting the last
proprietor, deleting a billed student) live inside `"use server"` functions and
cannot be reached by calling engine code. **Every assertion in it is a refusal or
a preview, so a full run writes nothing** — keep that property when adding cases,
or it stops being safe to run against a real database. The one exception is
`foreignIdGuards`: CI seeds a single school, so it builds a throw-away second
school to point ids at and deletes it again, and puts back the ledger mappings its
controls change. It skips without a database. The new-assessment form renders only
after a click, so that check skips too unless `useState(false)` in
`new-assessment.tsx` is flipped to `true` for the run.

It also runs against a deployment, signing in through the real login form so it
needs no database at all:

```bash
VERIFY_BASE_URL=https://www.schoolosafrica.com \
VERIFY_EMAIL=you@example.com VERIFY_PASSWORD='…' npm run verify:actions
```

The Deployment section needs no fixtures and is the post-deploy smoke test: the
login page renders, the auth gate is closed, and an authenticated session reaches
the app — which on production also proves the isolation guard was satisfied,
since a misconfigured build refuses to start. The fixture-backed guards skip with
a `--` line rather than passing vacuously when there is no database to read.

**Server actions can be exercised without a browser.** The `Next-Action` header
POST that works for RPC-style actions does 404 here, because every action is
form-bound (`useActionState`). But Next also renders each form's **no-JS
fallback**: a real `method="POST"` form whose hidden inputs carry the action id
(`$ACTION_ID_*` for plain actions, `$ACTION_REF_n` + `$ACTION_n:0` for
`useActionState` ones). Replaying that POST as `multipart/form-data` to the page
URL runs the genuine action — `requireRole`, validation, transactions and all —
and the response carries the re-rendered `role="alert"` banners.

Two things this buys that clicking does not: submitting values the UI will not
produce (a forged `gradingScaleId` pointing at a frozen grading scale), and
bypassing `required` to reach server-side validation. Two limits: forms behind a
"+" toggle render only after a client click, so they are absent from the SSR
HTML — flip their `useState(false)` to `true` temporarily to reach them; and
none of this covers client behaviour (pending states, the staff-picker prefill).

**Decode the hidden fields before posting them back.** `$ACTION_n:0` is JSON in
an HTML attribute, so it arrives as `{&quot;id&quot;:&quot;…`. Post that back
raw and Next cannot parse the action id — it answers **500**, which is
indistinguishable from this project's ordinary dropped-connection 500 and will
send you hunting the wrong bug. `scripts/verify-actions.mjs` has a working
parser.

Authenticate by inserting a `Session` row with `sha256(token)` as `tokenHash`
and sending it as the `school_os_session` cookie.

**Engine code carries `import "server-only"`,** which throws outside a React
Server Component. The scripts run under `NODE_OPTIONS=--conditions=react-server`
so that import resolves to its empty stub. Without it you get an unhelpful
throw at import time. Scripts are `.mts` because tsx's CJS output rejects
top-level await.

`é` is IN the GSM-7 alphabet and does not force UCS-2; an em dash does. Getting
that backwards silently doubles a school's SMS bill.

## Backups

Nightly, in `.github/workflows/backup.yml`: dump production's `public` schema,
restore it into a throwaway Postgres, and compare exact row counts table by
table. The dump is encrypted with `age` and kept as a 30-day artifact.
`RESTORING.md` is the runbook — read it there, not here.

Three things about it that are not obvious, each of which failed first:

- **The self-test is the real proof.** Production was empty when this was
  written, and an empty database matches its own restore no matter how broken
  the machinery is. So the workflow also seeds a database from the migrations
  and proves the round trip on that. `prove-restore.sh` exits 3 rather than 0
  when a source has no rows, and the workflow reports UNPROVEN.
- **Counts come from `query_to_xml`, not `pg_stat_user_tables`.** `n_live_tup`
  is an autovacuum estimate that reads 0 on a fresh restore, so the obvious
  version of this check reports a perfect match between a full database and an
  empty one.
- **`school_os_app` must exist before `pg_restore` runs.** The policies are
  `CREATE POLICY … TO school_os_app` and roles are cluster-level, so no dump
  carries one. Without it the restore dies part-way, tables in and policies
  missing.

The comparison forces its own three failure modes every night and asserts the
exit codes, because it had only ever agreed.

## Commands

```bash
npm run dev          # next dev on :3000
npm run db:push      # push schema without a migration (early dev)
npm run db:migrate   # create + apply a migration
npm run db:seed      # demo Ghanaian school with fees, invoices, payments
npm run db:studio    # browse the data
```

Demo login after seeding: `owner@hopedemo.edu.gh` / `Password123!`

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
