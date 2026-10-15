-- Arquivos de salas apagadas saem do Storage sozinhos. Antes só saíam quando
-- quem enviou abria o painel; se o mestre não voltasse, ficavam para sempre.
-- O Storage só apaga pela API, então o banco chama a Edge Function
-- limpar-arquivos-orfaos (supabase/functions/) logo depois de excluir salas
-- vazias e, por garantia, uma vez por hora (pega também salas que o mestre
-- excluiu no painel).

create extension if not exists pg_net with schema extensions;

-- Todos os arquivos do bucket "midia" cuja sala não existe mais. Só a chave de
-- serviço (a Edge Function) pode chamar.
create function public.orphan_files()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select o.name
    from storage.objects o
   where o.bucket_id = 'midia'
     and private.room_id_from_path(o.name) is not null
     and not exists (select 1 from public.rooms r where r.id = private.room_id_from_path(o.name))
   limit 1000;
$$;
revoke execute on function public.orphan_files() from public, anon, authenticated;
grant execute on function public.orphan_files() to service_role;

create function private.request_orphan_cleanup()
returns void
language sql
security definer
set search_path = ''
as $$
  select net.http_post(
    url := 'https://toknaupmcfqhonsrpjct.supabase.co/functions/v1/limpar-arquivos-orfaos',
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
$$;
revoke execute on function private.request_orphan_cleanup() from public, anon, authenticated;

create or replace function private.purge_empty_rooms()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.rooms r
   where r.created_at < now() - interval '5 minutes'
     and not exists (select 1 from public.room_activity a
                      where a.room_id = r.id and a.last_seen > now() - interval '5 minutes');
  get diagnostics v_count = row_count;
  if v_count > 0 then
    perform private.request_orphan_cleanup();
  end if;
  return v_count;
end;
$$;

select cron.schedule('limpar-arquivos-orfaos', '17 * * * *', $$select private.request_orphan_cleanup()$$);
