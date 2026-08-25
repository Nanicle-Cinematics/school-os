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

## Tenancy

Every tenant-owned table carries `schoolId` and is indexed on it. A table without
`schoolId` is a tenancy bug.

`src/lib/tenant-context.ts` holds a per-request `AsyncLocalStorage` context;
`src/lib/prisma.ts` extends the client so each operation sets the
`app.school_id` / `app.bypass_rls` GUCs transaction-locally, which is what
Postgres RLS policies read. RLS ships dormant behind `DB_RLS=on`. Use
`tenantTransaction()` for any multi-statement tenant write (invoice generation,
results computation, number-sequence increments) so the GUC and the writes share
one transaction.

## Verification scripts

There is no test runner yet; these scripts exercise the real engine code against
the seeded database and are the fastest way to know a change didn't break the
arithmetic.

```bash
npm run db:verify        # money: payments == allocations == invoice balances
npm run verify:results   # grading, weighting, ranking, aggregate
npm run verify:sms       # phone normalisation, GSM-7 vs UCS2 segments, merge fields
npm run verify:audience  # who a campaign would reach, dedupe, debtor filtering
npm run verify:actions   # the server-action guards — needs `npm run dev` running
```

`verify:actions` is the only one that goes over HTTP, because the guards it
checks (a forged write against a frozen grading scale, demoting the last
proprietor, deleting a billed student) live inside `"use server"` functions and
cannot be reached by calling engine code. **Every assertion in it is a refusal or
a preview, so a full run writes nothing** — keep that property when adding cases,
or it stops being safe to run against a real database.

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
