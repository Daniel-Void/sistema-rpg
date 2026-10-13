-- Mixer de música: cada ambiente (ou a cena padrão da sala) tem uma lista de
-- faixas do YouTube. Cada faixa é um canal independente: tocar, pausar, parar,
-- repetir, volume e "ao terminar, tocar a próxima". Várias faixas podem tocar
-- juntas (ex.: música + chuva). Todo mundo calcula a posição da faixa a partir
-- de started_at + offset_s, então os jogadores ouvem o mesmo trecho.

create table public.music_tracks (
  id          bigint generated always as identity primary key,
  room_id     bigint not null references public.rooms (id) on delete cascade,
  zone_id     bigint references public.zones (id) on delete cascade, -- null = cena padrão da sala
  title       text not null default '' check (char_length(title) <= 120),
  youtube     text not null check (char_length(youtube) <= 300),
  position    integer not null default 0,
  volume      real not null default 0.7 check (volume between 0 and 1),
  loop        boolean not null default false,
  chain       boolean not null default true, -- ao terminar, toca a próxima da lista
  status      text not null default 'stopped' check (status in ('stopped', 'playing', 'paused')),
  offset_s    double precision not null default 0, -- posição (s) quando começou/pausou
  started_at  timestamptz,                         -- quando começou a tocar (status playing)
  duration_s  double precision,                    -- informada pelo player do YouTube
  archived    boolean not null default false,
  created_at  timestamptz not null default now()
);
create index music_tracks_room_idx on public.music_tracks (room_id, zone_id, position);
create index music_tracks_zone_id_idx on public.music_tracks (zone_id);

alter table public.music_tracks enable row level security;
revoke all on public.music_tracks from anon;

create policy "participantes veem as faixas da sala" on public.music_tracks
  for select to authenticated
  using (private.is_room_participant(room_id));

alter publication supabase_realtime add table public.music_tracks;

-- Relógio do servidor, para todos sincronizarem a posição das faixas
create function public.server_now()
returns timestamptz
language sql
stable
set search_path = ''
as $$ select now() $$;

-- Mestre: adicionar faixa ao fim da lista do ambiente (ou da cena padrão)
create function public.add_track(p_room_id bigint, p_zone_id bigint, p_youtube text, p_title text default '')
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_youtube text := trim(coalesce(p_youtube, ''));
  v_id bigint;
begin
  if not private.is_room_master(p_room_id) then
    raise exception 'Apenas o mestre pode fazer isso.' using errcode = '42501';
  end if;
  if char_length(v_youtube) > 300
     or v_youtube !~ '^https?://(www\.|m\.|music\.)?(youtube\.com/(watch\?|shorts/|embed/|live/|playlist\?)|youtu\.be/)[^[:space:]<>"]+$' then
    raise exception 'Cole um link válido do YouTube.' using errcode = '22023';
  end if;
  if p_zone_id is not null and not exists (
    select 1 from public.zones where id = p_zone_id and room_id = p_room_id and not archived) then
    raise exception 'Ambiente não encontrado.' using errcode = '22023';
  end if;
  if (select count(*) from public.music_tracks
       where room_id = p_room_id and zone_id is not distinct from p_zone_id and not archived) >= 30 then
    raise exception 'No máximo 30 faixas por ambiente.' using errcode = '22023';
  end if;

  insert into public.music_tracks (room_id, zone_id, title, youtube, position)
  values (
    p_room_id, p_zone_id, left(trim(coalesce(p_title, '')), 120), v_youtube,
    coalesce((select max(position) + 1 from public.music_tracks
               where room_id = p_room_id and zone_id is not distinct from p_zone_id and not archived), 0)
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- Mestre: comandos do mixer.
-- play | pause | stop | restart | loop (bool) | chain (bool) | volume (0..1) | title (texto)
-- | up | down | remove | ended (a faixa chegou ao fim: para e, se chain, toca a próxima)
create function public.music_control(p_track_id bigint, p_action text, p_value jsonb default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.music_tracks;
  v_other public.music_tracks;
  v_elapsed double precision;
begin
  select * into t from public.music_tracks where id = p_track_id and not archived;
  if not found then
    raise exception 'Faixa não encontrada.' using errcode = '22023';
  end if;
  if not private.is_room_master(t.room_id) then
    raise exception 'Apenas o mestre pode fazer isso.' using errcode = '42501';
  end if;

  v_elapsed := t.offset_s + case when t.status = 'playing' and t.started_at is not null
                                  then extract(epoch from (now() - t.started_at)) else 0 end;

  case p_action
    when 'play' then
      if t.status <> 'playing' then
        -- Retomar de onde parou; se já tinha terminado, recomeça
        update public.music_tracks
           set status = 'playing', started_at = now(),
               offset_s = case when duration_s is not null and offset_s >= duration_s - 1 then 0 else offset_s end
         where id = t.id;
      end if;
    when 'pause' then
      if t.status = 'playing' then
        update public.music_tracks
           set status = 'paused', started_at = null,
               offset_s = case when duration_s is not null and loop then mod(v_elapsed::numeric, duration_s::numeric)::double precision
                               when duration_s is not null then least(v_elapsed, duration_s) else v_elapsed end
         where id = t.id;
      end if;
    when 'stop' then
      update public.music_tracks set status = 'stopped', started_at = null, offset_s = 0 where id = t.id;
    when 'restart' then
      update public.music_tracks set status = 'playing', started_at = now(), offset_s = 0 where id = t.id;
    when 'loop' then
      update public.music_tracks set loop = coalesce((p_value #>> '{}')::boolean, not t.loop) where id = t.id;
    when 'chain' then
      update public.music_tracks set chain = coalesce((p_value #>> '{}')::boolean, not t.chain) where id = t.id;
    when 'volume' then
      update public.music_tracks set volume = least(greatest(coalesce((p_value #>> '{}')::real, t.volume), 0), 1) where id = t.id;
    when 'title' then
      update public.music_tracks set title = left(trim(coalesce(p_value #>> '{}', '')), 120) where id = t.id;
    when 'up', 'down' then
      select * into v_other from public.music_tracks
       where room_id = t.room_id and zone_id is not distinct from t.zone_id and not archived
         and case when p_action = 'up' then position < t.position else position > t.position end
       order by case when p_action = 'up' then -position else position end
       limit 1;
      if found then
        update public.music_tracks set position = v_other.position where id = t.id;
        update public.music_tracks set position = t.position where id = v_other.id;
      end if;
    when 'remove' then
      update public.music_tracks set archived = true, status = 'stopped', started_at = null where id = t.id;
    when 'ended' then
      -- Só vale se a faixa estava tocando e não repete (evita pular por engano)
      if t.status = 'playing' and not t.loop then
        update public.music_tracks set status = 'stopped', started_at = null, offset_s = 0 where id = t.id;
        if t.chain then
          update public.music_tracks
             set status = 'playing', started_at = now(), offset_s = 0
           where id = (select id from public.music_tracks
                        where room_id = t.room_id and zone_id is not distinct from t.zone_id
                          and not archived and position > t.position
                        order by position limit 1);
        end if;
      end if;
    else
      raise exception 'Comando inválido.' using errcode = '22023';
  end case;
end;
$$;

-- Qualquer participante informa duração e título quando o player do YouTube carrega
-- (só preenche o que ainda está vazio).
create function public.report_track_meta(p_track_id bigint, p_duration double precision, p_title text default '')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room bigint;
begin
  select room_id into v_room from public.music_tracks where id = p_track_id and not archived;
  if v_room is null or not private.is_room_participant(v_room) then
    return;
  end if;
  update public.music_tracks
     set duration_s = coalesce(duration_s, case when p_duration between 1 and 86400 then p_duration end),
         title = case when title = '' then left(trim(coalesce(p_title, '')), 120) else title end
   where id = p_track_id;
end;
$$;

revoke execute on function
  public.server_now(), public.add_track(bigint, bigint, text, text),
  public.music_control(bigint, text, jsonb), public.report_track_meta(bigint, double precision, text)
from public, anon;
grant execute on function
  public.server_now(), public.add_track(bigint, bigint, text, text),
  public.music_control(bigint, text, jsonb), public.report_track_meta(bigint, double precision, text)
to authenticated;

-- A música única de cada ambiente vira a primeira faixa do mixer, tocando em repetição
insert into public.music_tracks (room_id, zone_id, youtube, loop, status, started_at)
select id, null, ambient_youtube, true, 'playing', now() from public.rooms where ambient_youtube is not null;
insert into public.music_tracks (room_id, zone_id, youtube, loop, status, started_at)
select room_id, id, ambient_youtube, true, 'playing', now() from public.zones where ambient_youtube is not null and not archived;
