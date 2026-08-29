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
ships that table with no row security at all. This has already happened once:
`AssessmentTemplate` arrived with the mark sheet and went unprotected, so every
school's Settings → Assessment components listed every other school's components
(the count read 18 across three schools instead of 6). `verify:isolation` now
fails on any table that has a `schoolId` but no RLS, FORCE and policy — run it
after every migration, and against production after every deploy that carries
one. The check is first in that suite deliberately: every other assertion proves
isolation for the tables it names and proves nothing about a table added since.

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
