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

Not modelled yet: timetable, attendance, admissions, library, boarding,
transport, health, payroll. Single-campus by design — there is no `Branch` model.

## Gotchas

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
Verified by `npm run verify:isolation` (9/9) and `npm run verify:actions` (43/43).

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

**`connection_limit`**: with RLS on, every model op becomes a transaction, which
`connection_limit=1` cannot serve (P2024). The app role's URL uses 10.

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

**The same job also checks for SCHEMA drift.** Production's schema is changed by
hand — there are no migrations, and `db push` needs the owner password, which is
lost (see Passwords). So nothing connected the repo's schema to the database's,
and the only thing between a forgotten `ALTER` and a 500 on every authenticated
page was somebody remembering. `prisma migrate diff --exit-code` fails the job
and prints the SQL that reconciles them — paste that straight into Supabase's SQL
editor, which needs no password.

⚠️ **To change the production schema without the owner password:** diff the two
datamodels offline — this needs no database at all —

```bash
git show main:prisma/schema.prisma > /tmp/old.prisma
node_modules/.bin/prisma migrate diff \
  --from-schema-datamodel /tmp/old.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
```

then run that SQL in the Supabase SQL editor and confirm with an
`information_schema.columns` select BEFORE merging. `main` auto-deploys, so a
column the code expects and the database lacks is an outage, not a degradation.

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

## A class teacher sees two screens

A teacher signs in to do one job — enter the term's marks for the subjects they
teach, and write the conduct and remark for their class — so `TEACHER` appears
on exactly two routes, `/assessments/sheet` and `/results/remarks`, and nowhere
else. That is the whole mechanism: `requireRole` then refuses every other page
without a separate list of prohibitions to keep in step with the app.

- **`MARKING`** (in `permissions.ts`) is those two screens and their actions —
  `openSheet`, `saveSheet`, `saveClassRemarks`. Everything else that used to be
  `ACADEMIC` is now `LEADERSHIP`; the `ACADEMIC` constant is gone, because a
  role list that no longer matches any screen is how the wrong page gets opened.
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

**Dark mode, when it is built, is BLACK** — not a dark green. The green stays as
the brand accent against it. The blocker is not the palette: 69 hardcoded
`bg-white` across 51 files (plus 86 `border-slate-200`, 68 `bg-slate-50`) have to
route through a surface token first, or the theme will half-work.

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

## Live activity

The dashboard's activity feed is a READER over `AuditLog`, which every money and
grade mutation has written since the first commit and which nothing displayed
until now. `getActivity` adds no records; it phrases existing ones.

Two fragile edges, both guarded by `npm run verify:activity`:

- **The phrase map must cover every action the app writes.** `ACTIVITY_ACTIONS`
  is exported so the verifier can grep every `action: "..."` in `src/lib` and
  assert each one has a phrase — otherwise a new `writeAudit` reaches a head
  teacher's dashboard as "invoice generate". It checks the reverse too: a phrase
  for an action nobody writes is dead weight. 25 actions today, all covered.
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
```

`verify:actions` is the only one that goes over HTTP, because the guards it
checks (a forged write against a frozen grading scale, demoting the last
proprietor, deleting a billed student) live inside `"use server"` functions and
cannot be reached by calling engine code. **Every assertion in it is a refusal or
a preview, so a full run writes nothing** — keep that property when adding cases,
or it stops being safe to run against a real database.

It also runs against a deployment, signing in through the real login form so it
needs no database at all:

```bash
VERIFY_BASE_URL=https://school-os-lilac.vercel.app \
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

## Commands

```bash
npm run dev          # next dev on :3000
npm run db:push      # push schema without a migration (early dev)
npm run db:migrate   # create + apply a migration
npm run db:seed      # demo Ghanaian school with fees, invoices, payments
npm run db:studio    # browse the data
```

Demo login after seeding: `owner@stmarydemo.edu.gh` / `Password123!`

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
