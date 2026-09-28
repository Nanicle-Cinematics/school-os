-- Every tenant table, its RLS scoping column, and its column list in
-- declaration order — one line each, pipe-separated. The same discovery
-- apply-rls.mjs already does (a schoolId column, or School itself by id),
-- so a per-school backup can never miss a table db:rls protects or dump one
-- it doesn't.
select
  c.table_name || '|' ||
  (case when c.table_name = 'School' then 'id' else 'schoolId' end) || '|' ||
  string_agg(quote_ident(col.column_name), ',' order by col.ordinal_position)
from information_schema.tables c
join information_schema.columns col
  on col.table_schema = c.table_schema and col.table_name = c.table_name
where c.table_schema = 'public'
  and c.table_type = 'BASE TABLE'
  and c.table_name <> '_prisma_migrations'
  and (
    c.table_name = 'School'
    or exists (
      select 1 from information_schema.columns sc
      where sc.table_schema = c.table_schema
        and sc.table_name = c.table_name
        and sc.column_name = 'schoolId'
    )
  )
group by c.table_name
order by c.table_name;
