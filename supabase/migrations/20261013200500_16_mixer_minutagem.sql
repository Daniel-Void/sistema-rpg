-- Mixer: o mestre escolhe a minutagem da faixa (comando seek).

create or replace function public.music_control(p_track_id bigint, p_action text, p_value jsonb default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.music_tracks;
  v_other public.music_tracks;
  v_elapsed double precision;
  v_loop boolean; -- a coluna se chama loop, palavra reservada do PL/pgSQL
begin
  select * into t from public.music_tracks where id = p_track_id and not archived;
  if not found then
    raise exception 'Faixa não encontrada.' using errcode = '22023';
  end if;
  select mt.loop into v_loop from public.music_tracks mt where mt.id = p_track_id;
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
    when 'seek' then
      -- Mestre escolhe a minutagem (segundos); se estiver tocando, continua dali
      update public.music_tracks
         set offset_s = greatest(0, least(coalesce((p_value #>> '{}')::double precision, 0), coalesce(duration_s, 86400))),
             started_at = case when status = 'playing' then now() else started_at end,
             status = case when status = 'stopped' then 'paused' else status end
       where id = t.id;
    when 'restart' then
      update public.music_tracks set status = 'playing', started_at = now(), offset_s = 0 where id = t.id;
    when 'loop' then
      update public.music_tracks set loop = coalesce((p_value #>> '{}')::boolean, not v_loop) where id = t.id;
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
      if t.status = 'playing' and not v_loop then
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
