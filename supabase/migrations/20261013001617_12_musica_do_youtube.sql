-- Música ambiente por link do YouTube (cada jogador toca o vídeo localmente, só o áudio)

alter table public.zones add column ambient_youtube text
  check (ambient_youtube is null or char_length(ambient_youtube) <= 300);
alter table public.rooms add column ambient_youtube text
  check (ambient_youtube is null or char_length(ambient_youtube) <= 300);

create function public.set_environment(
  p_room_id bigint, p_zone_id bigint, p_scene_media_id bigint, p_ambient_youtube text,
  p_caption text, p_ambient_volume real
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caption text := left(coalesce(trim(p_caption), ''), 200);
  v_volume real := least(greatest(coalesce(p_ambient_volume, 0.6), 0), 1);
  v_youtube text := nullif(trim(coalesce(p_ambient_youtube, '')), '');
begin
  if not private.is_room_master(p_room_id) then
    raise exception 'Apenas o mestre pode fazer isso.' using errcode = '42501';
  end if;
  if p_scene_media_id is not null and not exists (
    select 1 from public.room_media where id = p_scene_media_id and room_id = p_room_id and kind in ('image', 'video')) then
    raise exception 'Imagem ou vídeo inválido.' using errcode = '22023';
  end if;
  if v_youtube is not null and (
    char_length(v_youtube) > 300
    or v_youtube !~ '^https?://(www\.|m\.|music\.)?(youtube\.com/(watch\?|shorts/|embed/|live/|playlist\?)|youtu\.be/)[^[:space:]<>"]+$'
  ) then
    raise exception 'Cole um link válido do YouTube.' using errcode = '22023';
  end if;

  if p_zone_id is null then
    update public.rooms
       set scene_media_id = p_scene_media_id, ambient_youtube = v_youtube, ambient_media_id = null,
           scene_caption = v_caption, ambient_volume = v_volume
     where id = p_room_id;
  else
    update public.zones
       set scene_media_id = p_scene_media_id, ambient_youtube = v_youtube, ambient_media_id = null,
           scene_caption = v_caption, ambient_volume = v_volume
     where id = p_zone_id and room_id = p_room_id and not archived;
  end if;
end;
$$;

revoke execute on function public.set_environment(bigint, bigint, bigint, text, text, real) from public, anon;
grant execute on function public.set_environment(bigint, bigint, bigint, text, text, real) to authenticated;

-- A versão antiga (som ambiente por arquivo) deixa de ser usada
revoke execute on function public.set_scene(bigint, bigint, bigint, bigint, text, real) from authenticated;
