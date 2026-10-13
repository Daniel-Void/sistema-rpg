-- Rolagens de dados. Todo sorteio acontece aqui no banco, nunca no navegador.

-- Rola uma expressão como "2d20kh1+1d6-2". Devolve { expression, terms, total }.
-- Termos: NdM (N de 1 a 1000, M de 1 a 1000; "dM" = 1dM; "d%" = d100),
-- com khK/klK (manter K maiores/menores) ou dhK/dlK (descartar K maiores/menores),
-- e números inteiros. Até 20 termos e 5000 dados por rolagem.
create function private.roll_dice(p_expr text)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_expr text := replace(lower(regexp_replace(coalesce(p_expr, ''), '\s', '', 'g')), 'd%', 'd100');
  v_term_re constant text := '(\d{0,4}d\d{1,4}((kh|kl|dh|dl)\d{1,4})?|\d{1,7})';
  v_m text[];
  v_terms jsonb := '[]'::jsonb;
  v_total bigint := 0;
  v_nterms int := 0;
  v_dice int := 0;
  v_sign int;
  v_count int;
  v_faces int;
  v_mode text;
  v_k int;
  v_rolls int[];
  v_order int[];
  v_kept boolean[];
  v_sum bigint;
  v_value bigint;
  i int;
begin
  if v_expr = '' or char_length(v_expr) > 200
     or v_expr !~ ('^[+-]?' || v_term_re || '([+-]' || v_term_re || ')*$') then
    raise exception 'Expressão de dados inválida. Exemplos: 1d20, 2d6+3, 2d20kh1, 4d6dl1.' using errcode = '22023';
  end if;

  for v_m in select regexp_matches(v_expr, '([+-]?)(?:(\d{0,4})d(\d{1,4})(?:(kh|kl|dh|dl)(\d{1,4}))?|(\d{1,7}))', 'g') loop
    v_nterms := v_nterms + 1;
    if v_nterms > 20 then
      raise exception 'Use no máximo 20 termos por rolagem.' using errcode = '22023';
    end if;
    v_sign := case when v_m[1] = '-' then -1 else 1 end;

    if v_m[3] is null then
      v_value := v_m[6]::bigint;
      v_terms := v_terms || jsonb_build_object('type', 'const', 'sign', v_sign, 'value', v_value);
      v_total := v_total + v_sign * v_value;
      continue;
    end if;

    v_count := coalesce(nullif(v_m[2], ''), '1')::int;
    v_faces := v_m[3]::int;
    if v_count < 1 or v_count > 1000 or v_faces < 1 or v_faces > 1000 then
      raise exception 'Cada termo vai de 1d1 até 1000d1000.' using errcode = '22023';
    end if;
    v_dice := v_dice + v_count;
    if v_dice > 5000 then
      raise exception 'No máximo 5000 dados por rolagem.' using errcode = '22023';
    end if;

    v_mode := v_m[4];
    v_k := case when v_m[5] is null then null else v_m[5]::int end;
    if v_mode in ('kh', 'kl') and (v_k < 1 or v_k > v_count) then
      raise exception 'Manter (kh/kl) precisa ser entre 1 e a quantidade de dados.' using errcode = '22023';
    end if;
    if v_mode in ('dh', 'dl') and (v_k < 0 or v_k >= v_count) then
      raise exception 'Descartar (dh/dl) precisa deixar pelo menos um dado.' using errcode = '22023';
    end if;

    v_rolls := array(select random(1, v_faces) from generate_series(1, v_count));
    v_kept := array_fill(true, array[v_count]);
    if v_mode is not null then
      -- posições ordenadas do maior para o menor (ou o contrário)
      select array_agg(t.idx order by
                         case when v_mode in ('kh', 'dh') then -t.val else t.val end, t.idx)
        into v_order
        from unnest(v_rolls) with ordinality as t(val, idx);
      v_kept := array_fill(v_mode in ('dh', 'dl'), array[v_count]);
      for i in 1..v_k loop
        v_kept[v_order[i]] := v_mode in ('kh', 'kl');
      end loop;
    end if;

    v_sum := 0;
    for i in 1..v_count loop
      if v_kept[i] then v_sum := v_sum + v_rolls[i]; end if;
    end loop;

    v_terms := v_terms || jsonb_build_object(
      'type', 'dice', 'sign', v_sign, 'count', v_count, 'faces', v_faces,
      'mode', v_mode, 'k', v_k, 'rolls', to_jsonb(v_rolls), 'kept', to_jsonb(v_kept), 'subtotal', v_sum);
    v_total := v_total + v_sign * v_sum;
  end loop;

  return jsonb_build_object('expression', v_expr, 'terms', v_terms, 'total', v_total);
end;
$$;

create table public.dice_rolls (
  id          bigint generated always as identity primary key,
  room_id     bigint not null references public.rooms (id) on delete cascade,
  roller_id   uuid not null references public.profiles (id) on delete cascade,
  created_by  uuid not null references public.profiles (id) on delete cascade,
  expression  text not null check (char_length(expression) between 1 and 200),
  label       text not null default '' check (char_length(label) <= 80),
  -- requested: jogador pediu, aguarda o mestre | ordered: mestre mandou o jogador rolar
  -- rolled: rolado | denied: mestre recusou | cancelled: cancelado
  status      text not null check (status in ('requested', 'ordered', 'rolled', 'denied', 'cancelled')),
  -- public: todos veem | secret: só o mestre e quem rolou
  visibility  text not null default 'public' check (visibility in ('public', 'secret')),
  result      jsonb,
  total       bigint,
  created_at  timestamptz not null default now(),
  rolled_at   timestamptz
);
create index dice_rolls_room_created_idx on public.dice_rolls (room_id, created_at desc);
create index dice_rolls_roller_id_idx on public.dice_rolls (roller_id);
create index dice_rolls_created_by_idx on public.dice_rolls (created_by);

alter table public.dice_rolls enable row level security;
revoke all on public.dice_rolls from anon;

create policy "quem pode ver cada rolagem" on public.dice_rolls
  for select to authenticated
  using (
    private.is_room_master(room_id)
    or roller_id = (select auth.uid())
    or (visibility = 'public' and status = 'rolled' and private.is_room_participant(room_id))
  );

alter publication supabase_realtime add table public.dice_rolls;

-- Jogador: pedir uma rolagem ao mestre
create function public.request_roll(p_room_id bigint, p_expression text, p_label text default '')
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
  v_norm text;
begin
  if not exists (select 1 from public.room_members where room_id = p_room_id and user_id = (select auth.uid())) then
    raise exception 'Você não é jogador desta sala.' using errcode = '42501';
  end if;
  if (select count(*) from public.dice_rolls
      where room_id = p_room_id and roller_id = (select auth.uid()) and status = 'requested') >= 3 then
    raise exception 'Você já tem pedidos aguardando o mestre.' using errcode = '54000';
  end if;
  v_norm := private.roll_dice(p_expression) ->> 'expression'; -- só valida
  insert into public.dice_rolls (room_id, roller_id, created_by, expression, label, status)
  values (p_room_id, (select auth.uid()), (select auth.uid()), v_norm, left(coalesce(trim(p_label), ''), 80), 'requested')
  returning id into v_id;
  return v_id;
end;
$$;

-- Jogador: cancelar o próprio pedido
create function public.cancel_roll(p_roll_id bigint)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.dice_rolls set status = 'cancelled'
   where id = p_roll_id and roller_id = (select auth.uid()) and created_by = (select auth.uid()) and status = 'requested';
$$;

-- Mestre: aprovar um pedido (pode ajustar a expressão e torná-la secreta)
create function public.approve_roll(p_roll_id bigint, p_expression text default null, p_secret boolean default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_roll public.dice_rolls;
  v_result jsonb;
begin
  select * into v_roll from public.dice_rolls where id = p_roll_id for update;
  if v_roll.id is null or not private.is_room_master(v_roll.room_id) then
    raise exception 'Apenas o mestre pode fazer isso.' using errcode = '42501';
  end if;
  if v_roll.status <> 'requested' then
    raise exception 'Este pedido já foi resolvido.' using errcode = '22023';
  end if;
  v_result := private.roll_dice(coalesce(nullif(trim(p_expression), ''), v_roll.expression));
  update public.dice_rolls
     set status = 'rolled', expression = v_result ->> 'expression', result = v_result,
         total = (v_result ->> 'total')::bigint, rolled_at = now(),
         visibility = case when coalesce(p_secret, false) then 'secret' else visibility end
   where id = p_roll_id;
end;
$$;

-- Mestre: recusar um pedido ou cancelar uma ordem
create function public.deny_roll(p_roll_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room bigint;
begin
  select room_id into v_room from public.dice_rolls where id = p_roll_id;
  if v_room is null or not private.is_room_master(v_room) then
    raise exception 'Apenas o mestre pode fazer isso.' using errcode = '42501';
  end if;
  update public.dice_rolls
     set status = case when status = 'requested' then 'denied' else 'cancelled' end
   where id = p_roll_id and status in ('requested', 'ordered');
end;
$$;

-- Mestre: rolar agora (aberto ou secreto)
create function public.master_roll(p_room_id bigint, p_expression text, p_label text default '', p_secret boolean default false)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
  v_result jsonb;
begin
  if not private.is_room_master(p_room_id) then
    raise exception 'Apenas o mestre pode fazer isso.' using errcode = '42501';
  end if;
  v_result := private.roll_dice(p_expression);
  insert into public.dice_rolls (room_id, roller_id, created_by, expression, label, status, visibility, result, total, rolled_at)
  values (p_room_id, (select auth.uid()), (select auth.uid()), v_result ->> 'expression', left(coalesce(trim(p_label), ''), 80),
          'rolled', case when coalesce(p_secret, false) then 'secret' else 'public' end,
          v_result, (v_result ->> 'total')::bigint, now())
  returning id into v_id;
  return v_id;
end;
$$;

-- Mestre: mandar um jogador rolar
create function public.order_roll(p_room_id bigint, p_user_id uuid, p_expression text, p_label text default '', p_secret boolean default false)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
  v_norm text;
begin
  if not private.is_room_master(p_room_id) then
    raise exception 'Apenas o mestre pode fazer isso.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.room_members where room_id = p_room_id and user_id = p_user_id) then
    raise exception 'Jogador não está na sala.' using errcode = '22023';
  end if;
  v_norm := private.roll_dice(p_expression) ->> 'expression'; -- só valida
  insert into public.dice_rolls (room_id, roller_id, created_by, expression, label, status, visibility)
  values (p_room_id, p_user_id, (select auth.uid()), v_norm, left(coalesce(trim(p_label), ''), 80),
          'ordered', case when coalesce(p_secret, false) then 'secret' else 'public' end)
  returning id into v_id;
  return v_id;
end;
$$;

-- Jogador: rolar o que o mestre mandou
create function public.perform_roll(p_roll_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_roll public.dice_rolls;
  v_result jsonb;
begin
  select * into v_roll from public.dice_rolls where id = p_roll_id for update;
  if v_roll.id is null or v_roll.roller_id <> (select auth.uid()) or v_roll.status <> 'ordered' then
    raise exception 'Não há rolagem pendente para você.' using errcode = '42501';
  end if;
  v_result := private.roll_dice(v_roll.expression);
  update public.dice_rolls
     set status = 'rolled', result = v_result, total = (v_result ->> 'total')::bigint, rolled_at = now()
   where id = p_roll_id;
end;
$$;

revoke execute on function private.roll_dice(text) from public, anon, authenticated;
revoke execute on function
  public.request_roll(bigint, text, text), public.cancel_roll(bigint), public.approve_roll(bigint, text, boolean),
  public.deny_roll(bigint), public.master_roll(bigint, text, text, boolean),
  public.order_roll(bigint, uuid, text, text, boolean), public.perform_roll(bigint)
from public, anon;
grant execute on function
  public.request_roll(bigint, text, text), public.cancel_roll(bigint), public.approve_roll(bigint, text, boolean),
  public.deny_roll(bigint), public.master_roll(bigint, text, text, boolean),
  public.order_roll(bigint, uuid, text, text, boolean), public.perform_roll(bigint)
to authenticated;
