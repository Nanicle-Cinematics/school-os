# Restoring School OS from a backup

Written for the day it is needed, when nobody wants to work anything out.

The nightly `Backup` workflow keeps an encrypted dump of production as a GitHub
Actions artifact for 30 days. Artifacts are listed on each run:
**Actions → Backup → a run → Artifacts**, named `school-os-prod-<date>-<run id>`.

## What is in it

The `public` schema of the production database: every table, its rows, its
indexes, and the row-security policies. That is the whole application — School
OS uses its own authentication, so nothing of value lives in Supabase's `auth`
or `storage` schemas.

What is **not** in it:

- **Roles.** `school_os_app` is a cluster-level object, not a schema one. The
  target needs it recreated before the app can connect (step 4 below).
- **Anything newer than last night.** This is a nightly logical dump, not
  point-in-time recovery. Losing today's work is the accepted cost; if that
  stops being acceptable, the answer is Supabase Pro with PITR, not a shorter
  cron.
- **The environment.** Vercel's variables, the Supabase project itself, and
  `PROD_DIRECT_URL` are not backed up. They are configuration, listed below.

## Restoring

You need `age` and PostgreSQL 17 client tools (`brew install age libpq`, or the
same two packages on any Linux).

**1. Decrypt.** Download the artifact (a zip), unzip it, then:

```
age -d -i /path/to/backup-key.txt -o production.dump production.dump.age
```

`backup-key.txt` is the private key you generated with `age-keygen`. If it is
lost, the backups are unreadable — there is no recovery, by design.

**2. Point at a target.** Either a fresh Supabase project or the existing one.
Take the session-pooler URL (port 5432, user `postgres.<ref>`), not the direct
`db.<ref>.supabase.co` host, which is IPv6-only and unreachable from most Macs.

**3. Create the `school_os_app` role first.** The dump's row-security policies
name it (`CREATE POLICY … TO school_os_app`), and roles are cluster-level so the
dump cannot carry one. Without this the restore dies part-way through, with
tables restored and policies missing — the worst of both:

```
psql -c "create role school_os_app nologin" "$TARGET"
```

A fresh Supabase project will not have it. An existing one will, and this line
harmlessly errors.

**4. Restore.** Into an empty database — and it must be genuinely empty,
including its `public` schema. The dump carries `CREATE SCHEMA public`, which
every database already has, so this fails on its first statement otherwise:

```
psql -c 'drop schema if exists public cascade' "$TARGET"
pg_restore --no-owner --no-privileges --exit-on-error --dbname "$TARGET" production.dump
```

That first line destroys whatever is in the target. Read the connection string
again before running it.

**5. Give the role its password and grants.** Step 3 created it with no login;
this makes it usable and re-asserts row security on every tenant table:

```
DIRECT_URL="$TARGET" APP_DB_PASSWORD="<a new one>" npm run db:rls
```

This is idempotent, and also re-asserts row security on every tenant table.

**6. Check what you got**, before pointing anything at it:

```
psql -At -f scripts/table-counts.sql "$TARGET"
```

Compare against the counts printed in the backup run's log. They should be
identical; the nightly job asserts exactly this comparison every night.

**7. Repoint the app.** In Vercel, set `DATABASE_URL` and `DIRECT_URL` to the
owner connection and `APP_DATABASE_URL` to the `school_os_app` one from step 4,
then redeploy. Update the `PROD_DIRECT_URL` GitHub secret too, or the next
night's backup silently keeps dumping the old database.

## Restoring one school

A whole-database restore is the tool for genuine disaster recovery. Losing or
needing to roll back just one school is a smaller, more common problem, and
`School backup` (`.github/workflows/school-backup.yml`) exists so it doesn't
require touching every other school's data to fix it. Artifacts are named
`school-os-schools-<date>-<run-id>` and contain one `<slug>.dump.age` per
school; **Actions → School backup → a run → Artifacts** lists them, same as
the whole-database ones. The nightly run covers every school; the admin
console can also dispatch one for a single school on demand.

**1. Decrypt**, same as above:

```
age -d -i /path/to/backup-key.txt -o ratmma.dump ratmma.dump.age
```

**2. The target must already have the right SCHEMA.** This is plain SQL —
`COPY "Table" (…) FROM stdin;` blocks, one per tenant table, nothing that
creates a table or a policy. Point it at production itself (after whatever
wiped the school's rows has been dealt with — a `sql-delete-school` gone to
the wrong slug, an accidental bulk delete, the school's own mistake), or at
a fresh target that has already had migrations applied (`npm run
db:deploy`) and, if you want RLS active there too, row security applied
(`npm run db:rls`).

**3. The target must NOT already hold rows for this school.** This restore
inserts; it does not merge or upsert. Restoring on top of existing rows for
the same school fails on the first primary-key collision. If the school's
rows are still partially there, clear them first — the platform console's
own `sql-delete-school` preview is one way to see exactly what a clean
slate for that school looks like before you restore into one.

**4. Restore, as a role that can set `session_replication_role`** (the
owner connection can) — the tables in the file are in no particular
dependency order, so foreign keys are turned off for the duration rather
than restored in a topological order this file doesn't carry:

```
psql -v ON_ERROR_STOP=1 -c 'SET session_replication_role = replica;' -f ratmma.dump "$TARGET"
```

Why not `pg_dump`/`pg_restore` here, the way the whole-database backup
works: `pg_dump` always emits a bare `COPY tablename TO stdout` internally,
and Postgres refuses that outright for any row-security table when the
connecting role is the restricted `school_os_app` rather than the owner —
"query would be affected by row-level security policy". A query-based
`COPY (SELECT …) TO` isn't subject to that restriction, which is what this
file actually is — one block per tenant table, built and proved restorable
by `scripts/prove-restore-school.sh` every time the backup runs.

**5. Check what you got**, scoped to this one school rather than the whole
database:

```
psql -At -v school_id=<the school's id> -f scripts/table-counts-school.sql "$TARGET"
```

Compare against the counts printed in that school's backup run log — the
nightly job (and the on-demand one from the admin console) asserts exactly
this comparison for every school, every time.

## Setting it up (once)

```
age-keygen -o backup-key.txt
```

Keep that file out of this repo and off the machine's shell history — a password
manager's secure-note field is the right place. Put its **public** line (`age1…`)
in Settings → Secrets and variables → Actions → **Variables**, as
`BACKUP_AGE_RECIPIENT`.

Without that variable the workflow fails rather than writing a plaintext dump of
every pupil record and guardian phone number into an artifact.

`School backup` additionally needs `PROD_APP_DIRECT_URL` — the `school_os_app`
role's **session-pooler** connection string (port 5432, not the pgbouncer
6543 one `APP_DATABASE_URL` uses): the per-school filtering is Postgres's own
row security doing the work, keyed on a GUC set for the session, and
transaction-mode pooling can hop a session across backend connections
mid-dump and drop that GUC partway through. Same host as `PROD_DIRECT_URL`,
different role and port. If `school_os_app`'s password isn't known (Vercel's
copy may be type Secret, which can't be revealed again), regenerate it —
`APP_DB_PASSWORD=<new> npm run db:rls` against production, then update
`APP_DATABASE_URL` in Vercel to match, same as provisioning that role the
first time.

Then decrypt one backup by hand. The workflow proves the ciphertext is well
formed, but it cannot prove *your* key opens it — a valid-but-wrong public key
encrypts perfectly well. One manual decrypt is the only thing that settles it,
and it is worth doing the day you set this up rather than the day you need it.
