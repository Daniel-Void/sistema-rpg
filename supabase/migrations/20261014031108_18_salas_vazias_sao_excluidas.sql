-- Sala vazia é excluída: cada página aberta da sala avisa "ainda estou aqui"
-- a cada 30 s (room_heartbeat). Se ninguém (mestre ou jogador) der sinal por
-- 5 minutos, o job do pg_cron apaga a sala e tudo dentro dela (cascade).
-- Os arquivos do Storage não podem ser apagados por SQL; quem os enviou os
-- remove pela API (o painel faz isso sozinho, ver my_orphan_files).

create extension if not exists pg_cron with schema pg_catalog;

create table public.room_activity (
  room_id   bigint primary key references public.rooms (id) on delete cascade,
  last_seen timestamptz not null default now()
);
alter table public.room_activity enable row level security;
revoke all on public.room_activity from anon, authenticated;

create function public.room_heartbeat(p_room_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_room_participant(p_room_id) then
    return;
  end if;
  insert into public.room_activity (room_id, last_seen) values (p_room_id, now())
  on conflict (room_id) do update set last_seen = excluded.last_seen;
end;
$$;
revoke execute on function public.room_heartbeat(bigint) from public, anon;
grant execute on function public.room_heartbeat(bigint) to authenticated;

create function private.purge_empty_rooms()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.rooms r
   where r.created_at < now() - interval '5 minutes'
     and not exists (select 1 from public.room_activity a
                      where a.room_id = r.id and a.last_seen > now() - interval '5 minutes');
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke execute on function private.purge_empty_rooms() from public, anon, authenticated;

select cron.schedule('apagar-salas-vazias', '* * * * *', $$select private.purge_empty_rooms()$$);

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
