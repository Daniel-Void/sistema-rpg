-- Só administradores criam contas: ninguém mais cria usuário temporário pelo site.
-- A função fica no banco (para poder religar), mas sem permissão de execução.
revoke execute on function public.create_temp_account(text, text, text) from anon, authenticated, public;
