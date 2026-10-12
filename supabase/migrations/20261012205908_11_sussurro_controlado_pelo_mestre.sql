-- Sussurro controlado pelo mestre: o jogador só pede; o mestre aceita, recusa,
-- força e encerra. Durante o sussurro, jogador e mestre só se ouvem entre si.

alter table public.room_members add column whisper_requested boolean not null default false;

-- O jogador não liga mais o próprio sussurro
revoke execute on function public.set_whisper(bigint, boolean) from authenticated;

-- Jogador: pedir (ou cancelar o pedido de) conversa em particular com o mestre
create function public.request_whisper(p_room_id bigint, p_active boolean)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.room_members
     set whisper_requested = coalesce(p_active, false) and not whisper_to_master
   where room_id = p_room_id and user_id = (select auth.uid());
$$;

-- Mestre: iniciar sussurro com um jogador (aceitando um pedido ou forçando).
-- Encerra qualquer outro sussurro em andamento na sala.
create function public.start_whisper(p_room_id bigint, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_room_master(p_room_id) then
    raise exception 'Apenas o mestre pode fazer isso.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.room_members where room_id = p_room_id and user_id = p_user_id) then
    raise exception 'Jogador não está na sala.' using errcode = '22023';
  end if;
  update public.room_members
     set whisper_to_master = (user_id = p_user_id),
         whisper_requested = case when user_id = p_user_id then false else whisper_requested end
   where room_id = p_room_id and (whisper_to_master or user_id = p_user_id);
  update public.rooms
     set master_target = jsonb_build_object('type', 'player', 'userId', p_user_id::text)
   where id = p_room_id;
end;
$$;

-- Mestre: encerrar o sussurro (ou recusar o pedido) de um jogador
create function public.end_whisper(p_room_id bigint, p_user_id uuid)
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
     set whisper_to_master = false, whisper_requested = false
   where room_id = p_room_id and user_id = p_user_id;
  update public.rooms
     set master_target = '{"type":"all"}'::jsonb
   where id = p_room_id and master_target ->> 'type' = 'player' and master_target ->> 'userId' = p_user_id::text;
end;
$$;

revoke execute on function public.request_whisper(bigint, boolean), public.start_whisper(bigint, uuid), public.end_whisper(bigint, uuid) from public, anon;
grant execute on function public.request_whisper(bigint, boolean), public.start_whisper(bigint, uuid), public.end_whisper(bigint, uuid) to authenticated;
