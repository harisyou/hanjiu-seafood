-- F003-7: admin-only arrival notification workflow.
-- Run once after F003-6. This migration does not update inventory or historical rows.

alter table public.fish_requests
  drop constraint if exists fish_requests_status_check;
alter table public.fish_requests
  add constraint fish_requests_status_check
  check (status in ('waiting', 'matched', 'contacted', 'converted', 'closed', 'cancelled'));

create or replace function public.admin_update_fish_request_status(
  p_request_id uuid,
  p_status text
)
returns public.fish_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.fish_requests;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_request_id is null then raise exception 'fish_request_not_found'; end if;
  if p_status not in ('waiting', 'contacted', 'converted', 'cancelled') then
    raise exception 'invalid_fish_request_status';
  end if;

  update public.fish_requests
  set status = p_status
  where id = p_request_id
  returning * into v_request;

  if not found then raise exception 'fish_request_not_found'; end if;
  return v_request;
end;
$$;

revoke all on function public.admin_update_fish_request_status(uuid, text)
  from public, anon, authenticated;
grant execute on function public.admin_update_fish_request_status(uuid, text)
  to authenticated;
