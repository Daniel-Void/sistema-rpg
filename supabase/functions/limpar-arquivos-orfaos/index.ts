// Apaga do Storage os arquivos (imagens, áudios) de salas que não existem mais.
// O Storage não deixa apagar por SQL, só pela API; por isso esta função roda com
// a chave de serviço e é chamada pelo banco (pg_cron + pg_net) logo depois que
// uma sala vazia é excluída e, por garantia, uma vez por hora.
// Não precisa de login: ela só remove arquivos de salas apagadas.
import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async () => {
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data, error } = await supabase.rpc('orphan_files');
  if (error) return Response.json({ erro: error.message }, { status: 500 });
  const names = (data ?? []).map((row: unknown) => (typeof row === 'string' ? row : (row as { orphan_files: string }).orphan_files)).filter(Boolean);
  let removidos = 0;
  for (let i = 0; i < names.length; i += 100) {
    const { data: removed, error: removeError } = await supabase.storage.from('midia').remove(names.slice(i, i + 100));
    if (removeError) return Response.json({ removidos, erro: removeError.message }, { status: 500 });
    removidos += removed?.length ?? 0;
  }
  return Response.json({ removidos });
});
