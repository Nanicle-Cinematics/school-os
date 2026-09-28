-- Row counts for ONE school only, table by table — the scoped counterpart to
-- table-counts.sql.
--
-- Uses the exact column each table's RLS policy is keyed on (`schoolId`, or
-- `id` for School itself), discovered from the schema rather than a hardcoded
-- list — the same special-casing apply-rls.mjs already does for the same
-- reason. A table this can't find a schoolId column for is simply not
-- counted, which is correct: nothing scopes it to one school, so a
-- per-school dump was never going to carry its rows either.
--
-- Usage: psql -At -v school_id=<id> -f table-counts-school.sql
select
  c.table_name || '=' ||
  (xpath(
    '/row/cnt/text()',
    query_to_xml(
      format(
        'select count(*) as cnt from %I.%I where %I = %L',
        c.table_schema,
        c.table_name,
        case when c.table_name = 'School' then 'id' else 'schoolId' end,
        :'school_id'
      ),
      false, true, ''
    )
  ))[1]::text::bigint
from information_schema.tables c
where c.table_schema = 'public'
  and c.table_type = 'BASE TABLE'
  and c.table_name <> '_prisma_migrations'
  and (
    c.table_name = 'School'
    or exists (
      select 1
      from information_schema.columns col
      where col.table_schema = c.table_schema
        and col.table_name = c.table_name
        and col.column_name = 'schoolId'
    )
  )
order by c.table_name;
