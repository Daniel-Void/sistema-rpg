-- Contas: um único admin (o mestre, login "lelis") cria as contas de jogador,
-- com nome de usuário e senha definidos por ele. Ninguém se cadastra sozinho
-- e ninguém além do admin é mestre.

-- Nome de usuário usado no login (as contas por usuário têm um e-mail interno).
alter table public.profiles add column username text unique
  check (username ~ '^[a-z0-9][a-z0-9._-]{2,29}$');

-- Só existe um mestre. Os mestres antigos viram jogadores; as salas que eles
-- já comandam continuam com eles (o controle da sala vem de rooms.master_id).
update public.profiles set role = 'jogador' where role = 'mestre';
create unique index profiles_um_unico_mestre on public.profiles (role) where role = 'mestre';

-- Conta criada direto pela API do Auth nunca vira mestre.
create or replace function public.handle_new_user()
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
    'jogador'
  );
  return new;
end;
$$;

create function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'mestre');
$$;
grant execute on function private.is_admin() to authenticated;

-- Cria a conta no Auth com o e-mail interno <usuário>@usuarios.sistema-rpg.example.com.
-- Sem permissão para o site: só as funções abaixo (e o dono, pelo SQL) chamam.
create function private.create_account(p_username text, p_display_name text, p_password text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
  v_username text := lower(trim(coalesce(p_username, '')));
  v_name text := trim(coalesce(p_display_name, ''));
  v_email text;
begin
  if v_username !~ '^[a-z0-9][a-z0-9._-]{2,29}$' then
    raise exception 'O usuário deve ter de 3 a 30 letras minúsculas, números, ponto, hífen ou sublinhado.' using errcode = '22023';
  end if;
  if char_length(v_name) not between 1 and 40 then
    raise exception 'Informe um nome de até 40 caracteres.' using errcode = '22023';
  end if;
  if char_length(coalesce(p_password, '')) not between 8 and 72 then
    raise exception 'A senha precisa ter de 8 a 72 caracteres.' using errcode = '22023';
  end if;
  v_email := v_username || '@usuarios.sistema-rpg.example.com';
  if exists (select 1 from public.profiles where username = v_username)
     or exists (select 1 from auth.users where email = v_email) then
    raise exception 'Já existe uma conta com esse usuário.' using errcode = '23505';
  end if;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, email_change, email_change_token_new, recovery_token)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
          extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}'::jsonb,
          jsonb_build_object('display_name', v_name),
          now(), now(), '', '', '', '');

  insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_id, v_id::text, 'email',
          jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true), now(), now(), now());

  update public.profiles set username = v_username where id = v_id;
  return v_id;
end;
$$;
revoke execute on function private.create_account(text, text, text) from public, anon, authenticated;

-- O admin cria um jogador (nunca mestre).
create function public.create_player_account(p_username text, p_display_name text, p_password text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Apenas o mestre pode criar contas.' using errcode = '42501';
  end if;
  if (select count(*) from auth.users where created_at > now() - interval '1 minute') >= 30 then
    raise exception 'Muitas contas criadas agora. Aguarde um minuto.' using errcode = '54000';
  end if;
  return private.create_account(p_username, p_display_name, p_password);
end;
$$;

-- O admin troca a senha de um jogador que ele criou.
create function public.set_player_password(p_user uuid, p_password text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Apenas o mestre pode trocar senhas.' using errcode = '42501';
  end if;
  if char_length(coalesce(p_password, '')) not between 8 and 72 then
    raise exception 'A senha precisa ter de 8 a 72 caracteres.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where id = p_user and role = 'jogador' and username is not null) then
    raise exception 'Jogador não encontrado.' using errcode = 'P0002';
  end if;
  update auth.users
     set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now()
   where id = p_user;
end;
$$;

-- O admin exclui a conta de um jogador que ele criou.
create function public.delete_player_account(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Apenas o mestre pode excluir contas.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_user and role = 'jogador' and username is not null) then
    raise exception 'Jogador não encontrado.' using errcode = 'P0002';
  end if;
  delete from auth.users where id = p_user;
end;
$$;

revoke execute on function
  public.create_player_account(text, text, text),
  public.set_player_password(uuid, text),
  public.delete_player_account(uuid)
from public, anon;
grant execute on function
  public.create_player_account(text, text, text),
  public.set_player_password(uuid, text),
  public.delete_player_account(uuid)
to authenticated;
