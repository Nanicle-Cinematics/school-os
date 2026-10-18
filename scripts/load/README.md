# Load test

Answers one question: **can School OS carry ten schools (500–700 pupils, 17–35 staff each) on a given hosting setup, and what gives first?**

It seeds ten realistic schools through the app's own engines, signs in as their parents, teachers and office staff, drives the busiest things a school does, and reports latency, failures, database connections and server CPU against a budget.

## Status

- **Verified:** the safety guard (`npm run verify:load-guard`, in CI, forced red six ways) and the whole harness type-checks against the real Prisma schema.
- **NOT yet run end to end.** No Postgres 17 was available where this was written (no Homebrew, no Docker). Run the smoke scenario (step 6) first; it exists to find what the harness got wrong before a real number depends on it.

## What it will not do

It refuses to start unless `.env.load` names a database that is neither `.env`'s nor `.env.prod`'s, and a server that is not production. It never reads `.env` for a URL, and it forces SMS to a dry run. The rules are in `guard.mts`; `.env.load.example` is a valid target as written. Do not point it at the dev project: a dozen requests an hour took that instance Unhealthy once, and a load test is a few thousand.

## Setup (local, about 20 minutes plus the seed)

Disk is the constraint on this machine (about 5 GB free). Ten schools is roughly 0.5–1 GB of database, a built app is about 1 GB, Postgres itself a few hundred MB. Start with `--schools 3` and look at the size it prints before going to ten.

1. **Postgres 17** on `localhost:5432` (Postgres.app, or the EnterpriseDB installer), then create the database:
   ```bash
   psql -h localhost -U postgres -c 'create database school_os_load'
   ```
2. **Environment:** `cp .env.load.example .env.load`. Nothing in it is real.
3. **Schema and role:**
   ```bash
   npm run load:migrate     # prisma migrate deploy, into the throwaway
   npm run load:rls         # creates school_os_app and the policies; the app must run as it, or the test measures a database with no row security
   ```
4. **Seed:**
   ```bash
   npm run load:seed -- --schools 3 --pupils 650 --staff 25
   npm run load:seed                                  # the full ten
   ```
   It prints the database size at the end: that, divided by the school count and doubled, is a school-year.
5. **Build and serve** (stop `npm run dev` first: both use `.next`):
   ```bash
   npm run load:build
   npm run load:serve > /tmp/load-server.log 2>&1     # port 3100
   ```
6. **Smoke test.** One of everything, ten seconds. It fails if any part of the harness cannot reach the app:
   ```bash
   npm run load:run -- --scenario smoke
   ```
7. **The real thing:**
   ```bash
   npm run load:run -- --server-log /tmp/load-server.log
   ```

Afterwards: `npm run load:clean` (or drop the database), and `rm -rf .next` to free the disk. `npm run dev` rebuilds it.

## Scenarios

| scenario | what it does |
|---|---|
| `smoke` | one school, one of each thing; checks the harness |
| `parents` | N parents arrive over the window and read the portal: home, child, fees, results, a published report card |
| `login` | real sign-ins through the form (what the password hashing costs under a crowd) |
| `office` | owners clicking the heavy list pages: dashboard, students, debtors, messages, chart of accounts |
| `registers` | every form teacher opens and saves the morning register |
| `marks` | teachers saving the mark sheet, which rolls the whole class up (the heaviest write) |
| `invoices` | the bursar generating a term's invoices for the whole school |
| `peak` | **all of the above at once** (the default): results are published, the term has begun, registers are being taken |

Useful flags: `--duration 120` (the window arrivals are spread over), `--parents 300`, `--logins 60`, `--office 3` (per school), `--registers 1` (share of classes), `--marks 20`, `--invoice-schools 2`, `--schools 10`. Budgets: `--page-p95 1500`, `--action-p95 4000`, `--login-p95 3000`, `--error-rate 0.01`.

## Reading the result

- **Over budget on pages only, DB connections low:** the app or its queries; look at which label is slowest.
- **Failures with `timeout/refused`, or `P2024` in the server log:** the connection pool is exhausted. This is the failure `CLAUDE.md` warns about (four connections per instance, every query a transaction). The fix is in the page that fans out, or the limiter on the job that holds the connections, not a bigger database.
- **Database `active` close to the core count, `idle in transaction` high:** the database is the limit. This is the one a bigger compute tier answers.
- **Connections near `max_connections`:** more serverless instances than the database can seat; look at the pooler's limits before the compute tier.
- **`invoices: generate` and `marks: save sheet` slow while `portal` pages stay fast:** the noisy-neighbour case. One school's big job is costing the other nine.
- **Server CPU pinned at 100% of a core:** on this machine the runner, the server and the database share a CPU, so this says "the laptop is the limit". It is the one number a local run cannot give you honestly.

## A local run is not the decision

Locally there is no network between the app and the database and one old CPU under all three. Trust the **shape** (what fails first, what the pool does) and compare runs against each other. The number that picks a hosting tier comes from a production-shaped run: a deployed copy of the app (Vercel Pro, `fra1`) against a **separate throwaway Supabase project at the compute tier under test**. For that, put the project's URLs in `.env.load`, set `LOAD_ALLOW_REMOTE=yes` and `LOAD_CONFIRM_TARGET=<its ref>`, seed it from this machine, and point `LOAD_BASE_URL` at the deployment. The guard compares against `.env`'s and `.env.prod`'s projects and refuses theirs.

## Files

- `guard.mts`, `preflight.mts`: the interlock. Pure, tested by `verify:load-guard`.
- `seed.mts`: ten schools through the real engines. `--clean` removes them.
- `run.mts`: the scenarios, the samplers, the report. Writes JSON to `load-results/` (git-ignored).
- `http.mts`: the timed client and the form replay (the same technique as `verify:actions`).
- `stats.mts`: percentiles and the budget.
