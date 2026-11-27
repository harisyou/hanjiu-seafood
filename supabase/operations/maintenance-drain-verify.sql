-- 100% READ ONLY. Zero rows is required; never terminate connections broadly.
select * from maintenance_private.drain_blockers() order by blocker_type,identifier;
select pid,usename,application_name,state,backend_xid,backend_xmin,xact_start,query_start,
  wait_event_type,wait_event,left(query,240) query
from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and (xact_start is not null or backend_xmin is not null or state like 'idle in transaction%')
order by coalesce(xact_start,query_start),pid;
