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

Then decrypt one backup by hand. The workflow proves the ciphertext is well
formed, but it cannot prove *your* key opens it — a valid-but-wrong public key
encrypts perfectly well. One manual decrypt is the only thing that settles it,
and it is worth doing the day you set this up rather than the day you need it.
