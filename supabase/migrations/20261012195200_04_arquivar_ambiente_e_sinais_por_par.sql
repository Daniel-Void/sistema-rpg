alter table public.zones add column archived boolean not null default false;

-- Um registro por par de conexões (sessão de origem -> sessão de destino); renegociações atualizam a mesma linha.
alter table public.signals add constraint signals_session_pair_key unique (from_session, to_session);

create policy "remetente atualiza o próprio sinal" on public.signals
  for update to authenticated
  using (from_user = (select auth.uid()))
  with check (
    from_user = (select auth.uid())
    and public.is_room_participant(room_id)
    and public.is_user_in_room(room_id, to_user)
  );

create function public.archive_zone(p_room_id bigint, p_zone_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fallback bigint;
begin
  if not public.is_room_master(p_room_id) then
    raise exception 'Apenas o mestre pode fazer isso.' using errcode = '42501';
  end if;
  select id into v_fallback from public.zones
  where room_id = p_room_id and id <> p_zone_id and not archived order by position, id limit 1;
  if v_fallback is null then
    raise exception 'A sala precisa ter pelo menos um ambiente.' using errcode = '22023';
  end if;
  update public.room_members set zone_id = v_fallback
  where room_id = p_room_id and (zone_id = p_zone_id or zone_id is null);
  update public.rooms set master_target = '{"type":"all"}'::jsonb
  where id = p_room_id and master_target ->> 'type' = 'zone' and master_target ->> 'zoneId' = p_zone_id::text;
  update public.zones set archived = true where id = p_zone_id and room_id = p_room_id;
end;
$$;

-- Ambientes arquivados não podem ser alvo nem destino
create or replace function public.move_player(p_room_id bigint, p_user_id uuid, p_zone_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_room_master(p_room_id) then
    raise exception 'Apenas o mestre pode fazer isso.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.zones where id = p_zone_id and room_id = p_room_id and not archived) then
    raise exception 'Ambiente inválido.' using errcode = '22023';
  end if;
  update public.room_members set zone_id = p_zone_id where room_id = p_room_id and user_id = p_user_id;
end;
$$;

create or replace function public.set_master_target(p_room_id bigint, p_target jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target jsonb := '{"type":"all"}'::jsonb;
begin
  if not public.is_room_master(p_room_id) then
    raise exception 'Apenas o mestre pode fazer isso.' using errcode = '42501';
  end if;
  if p_target ->> 'type' = 'zone'
     and exists (select 1 from public.zones where room_id = p_room_id and not archived and id::text = p_target ->> 'zoneId') then
    v_target := jsonb_build_object('type', 'zone', 'zoneId', (p_target ->> 'zoneId')::bigint);
  elsif p_target ->> 'type' = 'player'
     and exists (select 1 from public.room_members where room_id = p_room_id and user_id::text = p_target ->> 'userId') then
    v_target := jsonb_build_object('type', 'player', 'userId', p_target ->> 'userId');
  end if;
  update public.rooms set master_target = v_target where id = p_room_id;
end;
$$;

create or replace function public.join_room(p_code text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
begin
  select r.* into v_room
  from public.room_invites i join public.rooms r on r.id = i.room_id
  where i.code = upper(trim(p_code));
  if v_room.id is null then
    raise exception 'Código de convite inválido.' using errcode = 'P0002';
  end if;
  if v_room.master_id <> (select auth.uid()) then
    insert into public.room_members (room_id, user_id, zone_id)
    values (v_room.id, (select auth.uid()),
            (select id from public.zones where room_id = v_room.id and not archived order by position, id limit 1))
    on conflict do nothing;
  end if;
  return v_room.id;
end;
$$;

grant execute on function
  public.create_room(text, text),
  public.join_room(text),
  public.set_master_target(bigint, jsonb),
  public.move_player(bigint, uuid, bigint),
  public.create_zone(bigint, text),
  public.rename_zone(bigint, bigint, text),
  public.archive_zone(bigint, bigint),
  public.set_whisper(bigint, boolean),
  public.is_room_master(bigint),
  public.is_room_participant(bigint),
  public.is_user_in_room(bigint, uuid),
  public.room_id_from_topic(text)
to authenticated;
