create function public.create_room(p_name text, p_description text default '')
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room_id bigint;
  v_code text;
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  if not exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'mestre') then
    raise exception 'Apenas mestres podem criar salas.' using errcode = '42501';
  end if;
  insert into public.rooms (name, description, master_id)
  values (trim(p_name), coalesce(trim(p_description), ''), (select auth.uid()))
  returning id into v_room_id;
  insert into public.zones (room_id, name, position) values (v_room_id, 'Grupo principal', 0);
  loop
    select string_agg(substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1), '')
      into v_code from generate_series(1, 6);
    begin
      insert into public.room_invites (room_id, code) values (v_room_id, v_code);
      exit;
    exception when unique_violation then
    end;
  end loop;
  return v_room_id;
end;
$$;

create function public.join_room(p_code text)
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
            (select id from public.zones where room_id = v_room.id order by position, id limit 1))
    on conflict do nothing;
  end if;
  return v_room.id;
end;
$$;

create function public.set_master_target(p_room_id bigint, p_target jsonb)
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
     and exists (select 1 from public.zones where room_id = p_room_id and id::text = p_target ->> 'zoneId') then
    v_target := jsonb_build_object('type', 'zone', 'zoneId', (p_target ->> 'zoneId')::bigint);
  elsif p_target ->> 'type' = 'player'
     and exists (select 1 from public.room_members where room_id = p_room_id and user_id::text = p_target ->> 'userId') then
    v_target := jsonb_build_object('type', 'player', 'userId', p_target ->> 'userId');
  end if;
  update public.rooms set master_target = v_target where id = p_room_id;
end;
$$;

create function public.move_player(p_room_id bigint, p_user_id uuid, p_zone_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_room_master(p_room_id) then
    raise exception 'Apenas o mestre pode fazer isso.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.zones where id = p_zone_id and room_id = p_room_id) then
    raise exception 'Ambiente inválido.' using errcode = '22023';
  end if;
  update public.room_members set zone_id = p_zone_id where room_id = p_room_id and user_id = p_user_id;
end;
$$;

create function public.create_zone(p_room_id bigint, p_name text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if not public.is_room_master(p_room_id) then
    raise exception 'Apenas o mestre pode fazer isso.' using errcode = '42501';
  end if;
  insert into public.zones (room_id, name, position)
  values (p_room_id, left(trim(p_name), 40),
          (select coalesce(max(position), -1) + 1 from public.zones where room_id = p_room_id))
  returning id into v_id;
  return v_id;
end;
$$;

create function public.rename_zone(p_room_id bigint, p_zone_id bigint, p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_room_master(p_room_id) then
    raise exception 'Apenas o mestre pode fazer isso.' using errcode = '42501';
  end if;
  update public.zones set name = left(trim(p_name), 40) where id = p_zone_id and room_id = p_room_id;
end;
$$;

create function public.set_whisper(p_room_id bigint, p_active boolean)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.room_members set whisper_to_master = coalesce(p_active, false)
  where room_id = p_room_id and user_id = (select auth.uid());
$$;
