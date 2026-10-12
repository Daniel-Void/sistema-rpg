create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1), 'Aventureiro'), 40),
    case when new.raw_user_meta_data ->> 'role' = 'mestre' then 'mestre' else 'jogador' end
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.is_room_master(p_room_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.rooms where id = p_room_id and master_id = (select auth.uid()));
$$;

create function public.is_room_participant(p_room_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.rooms where id = p_room_id and master_id = (select auth.uid()))
      or exists (select 1 from public.room_members where room_id = p_room_id and user_id = (select auth.uid()));
$$;

create function public.is_user_in_room(p_room_id bigint, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.rooms where id = p_room_id and master_id = p_user_id)
      or exists (select 1 from public.room_members where room_id = p_room_id and user_id = p_user_id);
$$;

create function public.room_id_from_topic(p_topic text)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case when p_topic ~ '^room:[0-9]{1,18}$' then substring(p_topic from 6)::bigint end;
$$;

create policy "perfis visíveis para usuários logados" on public.profiles
  for select to authenticated using (true);

create policy "participantes veem a sala" on public.rooms
  for select to authenticated using (public.is_room_participant(id));
create policy "mestre exclui a sala" on public.rooms
  for delete to authenticated using (master_id = (select auth.uid()));

create policy "mestre vê o convite" on public.room_invites
  for select to authenticated using (public.is_room_master(room_id));

create policy "participantes veem ambientes" on public.zones
  for select to authenticated using (public.is_room_participant(room_id));

create policy "participantes veem membros" on public.room_members
  for select to authenticated using (public.is_room_participant(room_id));
create policy "mestre remove jogador ou jogador sai" on public.room_members
  for delete to authenticated using (user_id = (select auth.uid()) or public.is_room_master(room_id));

create policy "participante envia sinal como ele mesmo" on public.signals
  for insert to authenticated
  with check (
    from_user = (select auth.uid())
    and public.is_room_participant(room_id)
    and public.is_user_in_room(room_id, to_user)
  );
create policy "só o destinatário lê o sinal" on public.signals
  for select to authenticated using (to_user = (select auth.uid()));
create policy "destinatário apaga o sinal" on public.signals
  for delete to authenticated using (to_user = (select auth.uid()));

alter publication supabase_realtime add table public.rooms, public.zones, public.room_members, public.signals;
