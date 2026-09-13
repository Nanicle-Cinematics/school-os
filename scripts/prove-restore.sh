#!/usr/bin/env bash
#
# Dump a database, restore the dump somewhere else, and prove the two agree.
#
# A dump nobody has restored is a belief, not a backup. This is the step that
# turns the file into evidence: restore it into a scratch database and compare
# exact row counts, table by table.
#
#   prove-restore.sh <source-url> <scratch-url> <dump-path>
#
# Exit codes, which the workflow reads:
#   0  restored, and the counts match
#   1  the counts DISAGREE — the dump does not reproduce the source
#   3  nothing to prove: the source holds no rows at all
#
# ⚠️ 3 is not success, and must never be reported as a tick. An empty source
# makes the comparison vacuous — every table 0 on both sides — so it would pass
# no matter how broken the dump machinery was. Production is empty today, which
# is precisely why this distinction exists rather than being hypothetical.
set -euo pipefail

source_url=$1
scratch_url=$2
dump=$3
here=$(dirname "$0")

echo "Dumping…"
# --schema=public, and only public. A Supabase database also carries `auth`,
# `storage`, `graphql` and the extensions schema, none of which this app uses —
# it has its own authentication — and all of which reference extensions a plain
# postgres:17 does not have, so a whole-database dump does not restore into the
# scratch server below. What is dumped here is the whole APPLICATION.
#
# --no-owner: roles live in the cluster, not in the dump, so a restore elsewhere
# must not try to chown to `postgres` or to `school_os_app`. Recreating that role
# is `npm run db:rls` on the target — see RESTORING.md.
pg_dump --format=custom --schema=public --no-owner --no-privileges \
  --file "$dump" "$source_url"
echo "  $(du -h "$dump" | cut -f1) written to $dump"

echo "Counting the source…"
psql -At -f "$here/table-counts.sql" "$source_url" > /tmp/counts.source

total=$(awk -F= '{ s += $2 } END { print s + 0 }' /tmp/counts.source)
tables=$(wc -l < /tmp/counts.source | tr -d ' ')
echo "  $tables tables, $total rows"

echo "Restoring…"
pg_restore --no-owner --no-privileges --exit-on-error --dbname "$scratch_url" "$dump"

echo "Counting the restore…"
psql -At -f "$here/table-counts.sql" "$scratch_url" > /tmp/counts.restored

if ! diff -u /tmp/counts.source /tmp/counts.restored > /tmp/counts.diff; then
  echo
  echo "MISMATCH — the restore does not reproduce the source:"
  sed -n '3,40p' /tmp/counts.diff
  exit 1
fi

if [ "$total" -eq 0 ]; then
  echo
  echo "UNPROVEN: the source holds no rows, so matching counts prove nothing."
  exit 3
fi

echo
echo "Restored and verified: $tables tables, $total rows, counts identical."
