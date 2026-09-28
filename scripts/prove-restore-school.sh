#!/usr/bin/env bash
#
# Dump ONE school's data, restore it, and prove the two agree — the scoped
# counterpart to prove-restore.sh.
#
# ⚠️ NOT pg_dump. Two things were tried and both failed against the real
# database, not a toy one:
#
#   1. PGOPTIONS="-c app.school_id=…" does not survive Supabase's pooler —
#      even the "direct" port 5432 goes through Supavisor, which silently
#      drops custom startup options. `select current_setting('app.school_id')`
#      came back empty right after connecting with it set. This is exactly
#      why src/lib/prisma.ts sets the GUC as a real SQL statement inside the
#      transaction rather than a connection option — the same lesson,
#      relearned the hard way here.
#
#   2. Even with the GUC delivered correctly, pg_dump still cannot do this:
#      it always emits a bare `COPY tablename TO stdout` internally, and
#      Postgres refuses that outright for any row-security table when the
#      connecting role is not the owner or a superuser — "query would be
#      affected by row-level security policy". A QUERY-based
#      `COPY (SELECT …) TO` is not subject to that restriction, but pg_dump
#      has no option to use that form for an ordinary data-only table dump.
#
# So this extracts each tenant table by hand — the same table+column
# discovery apply-rls.mjs already does (scripts/tenant-tables.sql), one
# `\copy (SELECT …) TO` per table, with the GUC set once for the whole psql
# session. Postgres does the type-correct formatting; nothing here hand-
# escapes a data value. The framing around each table's rows (`COPY … FROM
# stdin; … \.`) only ever touches table and column NAMES from that same
# trusted discovery — never a row of school data — so there is nothing in
# this file for an odd character in an address or a name to break.
#
#   prove-restore-school.sh <app-role-source-url> <owner-source-url> <scratch-url> <dump-path> <school-id>
#
# scratch-url must already carry the application SCHEMA (e.g. `db:deploy`)
# and must connect as a role that can SET session_replication_role — the
# owner does. It must NOT already hold rows for this school; this restore
# inserts, it does not merge.
#
# Exit codes, matching prove-restore.sh:
#   0  restored, and the counts match
#   1  the counts DISAGREE — the dump does not reproduce the source
#   2  the target already holds rows for this school
#   3  nothing to prove: this school holds no rows at all
set -euo pipefail

app_url=$1
owner_url=$2
scratch_url=$3
dump=$4
school_id=$5
here=$(dirname "$0")

counts() {
  psql -At -v school_id="$school_id" -f "$here/table-counts-school.sql" "$1"
}
total_of() {
  awk -F= '{ s += $2 } END { print s + 0 }' "$1"
}

echo "Checking the target is clean for this school…"
counts "$scratch_url" > /tmp/school_counts.preexisting
preexisting=$(total_of /tmp/school_counts.preexisting)
if [ "$preexisting" != "0" ]; then
  echo "REFUSING: the restore target already holds $preexisting row(s) for this school."
  echo "This restore inserts; it does not merge. Point it at a target with an empty slate for this school."
  exit 2
fi

echo "Extracting school $school_id (query-scoped, as school_os_app)…"
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

# table|scopeColumn|col1,col2,… — owner connection, since this is schema
# introspection, not a read of any school's rows.
psql -At -F '|' "$owner_url" -f "$here/tenant-tables.sql" > "$workdir/tables.txt"
if [ ! -s "$workdir/tables.txt" ]; then
  echo "::error::No tenant tables found — db:rls has not been run against this target's source."
  exit 1
fi

{
  # is_local=false: SESSION-scoped, so it survives every \copy below even
  # though each is its own auto-committed statement — is_local=true would
  # reset at the first transaction boundary and every table after it would
  # read as an unscoped session, which RLS treats as matching nothing.
  echo "select set_config('app.school_id', '$school_id', false), set_config('app.bypass_rls', 'off', false);"
  while IFS='|' read -r table _scopecol cols; do
    echo "\\o $workdir/$table.data"
    echo "\\copy (select $cols from \"$table\") to stdout"
  done < "$workdir/tables.txt"
  echo "\\o"
} > "$workdir/extract.sql"
psql -q "$app_url" -f "$workdir/extract.sql"

{
  echo "-- One school's data. Restore with session_replication_role = replica —"
  echo "-- see RESTORING.md — these tables are in no particular order, and"
  echo "-- foreign keys would otherwise fail depending which happens to load first."
  while IFS='|' read -r table _scopecol cols; do
    echo "COPY \"$table\" ($cols) FROM stdin;"
    cat "$workdir/$table.data"
    echo '\.'
    echo
  done < "$workdir/tables.txt"
} > "$dump"
echo "  $(du -h "$dump" | cut -f1) written to $dump"

echo "Counting the source…"
counts "$owner_url" > /tmp/school_counts.source
total=$(total_of /tmp/school_counts.source)
tables=$(wc -l < /tmp/school_counts.source | tr -d ' ')
echo "  $tables tables, $total rows for this school"

echo "Restoring…"
psql -q -v ON_ERROR_STOP=1 -c 'SET session_replication_role = replica;' -f "$dump" "$scratch_url"

# A deliberately broken restore, so the comparison below has something to
# catch — same discipline as prove-restore.sh's PROVE_RESTORE_SABOTAGE.
if [ -n "${PROVE_RESTORE_SCHOOL_SABOTAGE:-}" ]; then
  echo "  (sabotaging the restore on purpose)"
  psql -q -v school_id="$school_id" \
    -c 'delete from "Student" where id = (select id from "Student" where "schoolId" = :'"'school_id'"' limit 1)' \
    "$scratch_url"
fi

echo "Counting the restore…"
counts "$scratch_url" > /tmp/school_counts.restored

if ! diff -u /tmp/school_counts.source /tmp/school_counts.restored > /tmp/school_counts.diff; then
  echo
  echo "MISMATCH — the restore does not reproduce the source:"
  sed -n '3,40p' /tmp/school_counts.diff
  exit 1
fi

if [ "$total" -eq 0 ]; then
  echo
  echo "UNPROVEN: this school holds no rows, so matching counts prove nothing."
  exit 3
fi

echo
echo "Restored and verified: $tables tables, $total rows for this school, counts identical."
