-- Contas temporárias (fase de testes): só nome e papel, sem e-mail nem verificação.
-- O navegador gera uma senha aleatória, a função cria a conta e devolve o e-mail interno;
-- o navegador então entra com e-mail + senha e guarda a sessão.
create function public.create_temp_account(p_name text, p_role text, p_password text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
  v_email text := 'temp-' || replace(v_id::text, '-', '') || '@contas-temporarias.example.com';
begin
  if char_length(trim(coalesce(p_name, ''))) not between 1 and 40 then
    raise exception 'Informe um nome de até 40 caracteres.' using errcode = '22023';
  end if;
  if p_role not in ('mestre', 'jogador') then
    raise exception 'Escolha mestre ou jogador.' using errcode = '22023';
  end if;
  if char_length(coalesce(p_password, '')) < 24 then
    raise exception 'Senha gerada inválida.' using errcode = '22023';
  end if;
  if (select count(*) from auth.users
      where created_at > now() - interval '1 minute'
        and raw_app_meta_data ->> 'temporary' = 'true') >= 30 then
    raise exception 'Muitas contas criadas agora. Aguarde um minuto.' using errcode = '54000';
  end if;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, email_change, email_change_token_new, recovery_token)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
          extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"],"temporary":true}'::jsonb,
          jsonb_build_object('display_name', trim(p_name), 'role', p_role),
          now(), now(), '', '', '', '');

  insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_id, v_id::text, 'email',
          jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true), now(), now(), now());

  return v_email;
end;
$$;

revoke execute on function public.create_temp_account(text, text, text) from public;
grant execute on function public.create_temp_account(text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Biblioteca de mídia da sala (imagens, vídeos e áudios enviados pelo mestre)
-- ---------------------------------------------------------------------------

create table public.room_media (
  id           bigint generated always as identity primary key,
  room_id      bigint not null references public.rooms (id) on delete cascade,
  kind         text not null check (kind in ('image', 'video', 'audio')),
  name         text not null check (char_length(name) between 1 and 80),
  storage_path text not null unique check (char_length(storage_path) <= 300),
  created_at   timestamptz not null default now()
);
create index room_media_room_id_idx on public.room_media (room_id);

alter table public.room_media enable row level security;
revoke all on public.room_media from anon;

create policy "participantes veem a biblioteca" on public.room_media
  for select to authenticated using (private.is_room_participant(room_id));
create policy "mestre adiciona à biblioteca" on public.room_media
  for insert to authenticated
  with check (private.is_room_master(room_id) and storage_path like room_id::text || '/%');
create policy "mestre remove da biblioteca" on public.room_media
  for delete to authenticated using (private.is_room_master(room_id));

-- Cena de cada ambiente (e a cena padrão da sala, para quem estiver em ambiente sem cena)
alter table public.zones
  add column scene_media_id   bigint references public.room_media (id) on delete set null,
  add column ambient_media_id bigint references public.room_media (id) on delete set null,
  add column scene_caption    text not null default '' check (char_length(scene_caption) <= 200),
  add column ambient_volume   real not null default 0.6 check (ambient_volume between 0 and 1);

alter table public.rooms
  add column scene_media_id   bigint references public.room_media (id) on delete set null,
  add column ambient_media_id bigint references public.room_media (id) on delete set null,
  add column scene_caption    text not null default '' check (char_length(scene_caption) <= 200),
  add column ambient_volume   real not null default 0.6 check (ambient_volume between 0 and 1);

create index zones_scene_media_id_idx on public.zones (scene_media_id);
create index zones_ambient_media_id_idx on public.zones (ambient_media_id);
create index rooms_scene_media_id_idx on public.rooms (scene_media_id);
create index rooms_ambient_media_id_idx on public.rooms (ambient_media_id);

-- p_zone_id nulo = cena padrão da sala
create function public.set_scene(
  p_room_id bigint, p_zone_id bigint, p_scene_media_id bigint, p_ambient_media_id bigint,
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
begin
  if not private.is_room_master(p_room_id) then
    raise exception 'Apenas o mestre pode fazer isso.' using errcode = '42501';
  end if;
  if p_scene_media_id is not null and not exists (
    select 1 from public.room_media where id = p_scene_media_id and room_id = p_room_id and kind in ('image', 'video')) then
    raise exception 'Imagem ou vídeo inválido.' using errcode = '22023';
  end if;
  if p_ambient_media_id is not null and not exists (
    select 1 from public.room_media where id = p_ambient_media_id and room_id = p_room_id and kind = 'audio') then
    raise exception 'Áudio inválido.' using errcode = '22023';
  end if;

  if p_zone_id is null then
    update public.rooms
       set scene_media_id = p_scene_media_id, ambient_media_id = p_ambient_media_id,
           scene_caption = v_caption, ambient_volume = v_volume
     where id = p_room_id;
  else
    update public.zones
       set scene_media_id = p_scene_media_id, ambient_media_id = p_ambient_media_id,
           scene_caption = v_caption, ambient_volume = v_volume
     where id = p_zone_id and room_id = p_room_id and not archived;
  end if;
end;
$$;

revoke execute on function public.set_scene(bigint, bigint, bigint, bigint, text, real) from public, anon;
grant execute on function public.set_scene(bigint, bigint, bigint, bigint, text, real) to authenticated;

alter publication supabase_realtime add table public.room_media;

-- ---------------------------------------------------------------------------
-- Arquivos: bucket privado "midia", caminho "<id da sala>/<arquivo>"
-- ---------------------------------------------------------------------------

create function private.room_id_from_path(p_path text)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case when p_path ~ '^[0-9]{1,18}/' then split_part(p_path, '/', 1)::bigint end;
$$;
grant execute on function private.room_id_from_path(text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('midia', 'midia', false, 52428800, array['image/*', 'video/*', 'audio/*']);

create policy "participantes leem a mídia da sala" on storage.objects
  for select to authenticated
  using (bucket_id = 'midia' and private.is_room_participant(private.room_id_from_path(name)));
create policy "mestre envia mídia da sala" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'midia' and private.is_room_master(private.room_id_from_path(name)));
create policy "mestre remove mídia da sala" on storage.objects
  for delete to authenticated
  using (bucket_id = 'midia' and private.is_room_master(private.room_id_from_path(name)));

-- ---------------------------------------------------------------------------
-- Canal da sala: presença para todos os participantes; broadcast (efeitos sonoros)
-- só pode ser enviado pelo mestre.
-- ---------------------------------------------------------------------------

alter policy "participantes publicam no canal da sala" on realtime.messages
  with check (
    (realtime.messages.extension = 'presence'
      and private.is_room_participant(private.room_id_from_topic((select realtime.topic()))))
    or (realtime.messages.extension = 'broadcast'
      and private.is_room_master(private.room_id_from_topic((select realtime.topic()))))
  );
