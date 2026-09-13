-- Exact row counts for every table in `public`, one table per line.
--
-- ⚠️ NOT pg_stat_user_tables.n_live_tup, which is what every snippet for this
-- reaches for first. That column is an ESTIMATE maintained by autovacuum: on a
-- freshly restored database it is usually 0 until something analyses it, so a
-- comparison built on it would report a perfect match between a full database
-- and an empty one. The whole point here is to catch exactly that.
--
-- query_to_xml runs a real count(*) per table without needing a loop or a
-- temporary function, so this stays a single statement that psql can run with
-- -At and produce a diff-able file.
select
  table_name || '=' ||
  (xpath(
    '/row/cnt/text()',
    query_to_xml(format('select count(*) as cnt from %I.%I', table_schema, table_name),
                 false, true, '')
  ))[1]::text::bigint
from information_schema.tables
where table_schema = 'public'
  and table_type = 'BASE TABLE'
order by table_name;
