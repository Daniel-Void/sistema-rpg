create or replace function public.set_master_target(p_room_id bigint, p_target jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target jsonb := '{"type":"all"}'::jsonb;
begin
  if not private.is_room_master(p_room_id) then
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

create or replace function public.move_player(p_room_id bigint, p_user_id uuid, p_zone_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_room_master(p_room_id) then
    raise exception 'Apenas o mestre pode fazer isso.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.zones where id = p_zone_id and room_id = p_room_id and not archived) then
    raise exception 'Ambiente inválido.' using errcode = '22023';
  end if;
  update public.room_members set zone_id = p_zone_id where room_id = p_room_id and user_id = p_user_id;
end;
$$;

create or replace function public.create_zone(p_room_id bigint, p_name text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if not private.is_room_master(p_room_id) then
    raise exception 'Apenas o mestre pode fazer isso.' using errcode = '42501';
  end if;
  insert into public.zones (room_id, name, position)
  values (p_room_id, left(trim(p_name), 40),
          (select coalesce(max(position), -1) + 1 from public.zones where room_id = p_room_id))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.rename_zone(p_room_id bigint, p_zone_id bigint, p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_room_master(p_room_id) then
    raise exception 'Apenas o mestre pode fazer isso.' using errcode = '42501';
  end if;
  update public.zones set name = left(trim(p_name), 40) where id = p_zone_id and room_id = p_room_id;
end;
$$;

create or replace function public.archive_zone(p_room_id bigint, p_zone_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fallback bigint;
begin
  if not private.is_room_master(p_room_id) then
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
