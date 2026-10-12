// Configuração pública do front-end. A chave "publishable" do Supabase é feita
// para ficar no navegador: quem protege os dados são as regras (RLS) do banco.
export const SUPABASE_URL = 'https://toknaupmcfqhonsrpjct.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_57JJu48g_afjfLOyYXsw9A_ypZ3VkpG';

// Servidores STUN/TURN para a call. Adicione um TURN para jogadores em redes restritivas (4G, empresas).
export const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
