-- 1) Salas temporárias: cada sala é excluída 8 horas depois de criada.
--    Um job do pg_cron apaga as vencidas a cada 5 minutos (ambientes, membros,
--    rolagens, faixas etc. vão junto pelo "on delete cascade").
--    Os arquivos do Storage não podem ser apagados por SQL; quem os enviou os
--    remove pela API (o painel faz isso sozinho, ver my_orphan_files).
-- 2) Mestre pode silenciar um jogador para todos (muted_by_master).

create extension if not exists pg_cron with schema pg_catalog;

alter table public.rooms add column expires_at timestamptz;
update public.rooms set expires_at = created_at + interval '8 hours';
alter table public.rooms alter column expires_at set default (now() + interval '8 hours');
alter table public.rooms alter column expires_at set not null;
create index rooms_expires_at_idx on public.rooms (expires_at);

create function private.purge_expired_rooms()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.rooms where expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke execute on function private.purge_expired_rooms() from public, anon, authenticated;

select cron.schedule('apagar-salas-expiradas', '*/5 * * * *', $$select private.purge_expired_rooms()$$);

create function public.my_orphan_files()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select o.name
    from storage.objects o
   where o.bucket_id = 'midia'
     and o.owner_id = (select auth.uid())::text
     and not exists (select 1 from public.rooms r where r.id = private.room_id_from_path(o.name))
   limit 500;
$$;
revoke execute on function public.my_orphan_files() from public, anon;
grant execute on function public.my_orphan_files() to authenticated;

create policy "dono vê arquivos de salas apagadas" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'midia' and owner_id = (select auth.uid())::text
    and not exists (select 1 from public.rooms r where r.id = private.room_id_from_path(name))
  );
create policy "dono remove arquivos de salas apagadas" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'midia' and owner_id = (select auth.uid())::text
    and not exists (select 1 from public.rooms r where r.id = private.room_id_from_path(name))
  );

alter table public.room_members add column muted_by_master boolean not null default false;

create function public.set_member_muted(p_room_id bigint, p_user_id uuid, p_muted boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_room_master(p_room_id) then
    raise exception 'Apenas o mestre pode fazer isso.' using errcode = '42501';
  end if;
  update public.room_members
     set muted_by_master = coalesce(p_muted, false)
   where room_id = p_room_id and user_id = p_user_id;
end;
$$;
revoke execute on function public.set_member_muted(bigint, uuid, boolean) from public, anon;
grant execute on function public.set_member_muted(bigint, uuid, boolean) to authenticated;
