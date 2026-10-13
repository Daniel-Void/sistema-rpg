// Entrega a lista de servidores STUN/TURN para a call.
// As chaves do TURN ficam só no servidor (variáveis de ambiente da Vercel) e
// apenas usuários logados recebem credenciais, que são temporárias quando o
// provedor permite. Sem TURN configurado, devolve só STUN.
//
// Variáveis aceitas (use um dos provedores):
//   CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN   (Cloudflare Realtime TURN)
//   METERED_DOMAIN + METERED_API_KEY                     (Metered / Open Relay)
//   TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL          (qualquer TURN, ex.: coturn)
// Trava de gasto da Cloudflare: veja _turnUsage.js.

import { turnStatus } from './_turnUsage.js';

const SUPABASE_URL = 'https://toknaupmcfqhonsrpjct.supabase.co';
const SUPABASE_KEY = 'sb_publishable_57JJu48g_afjfLOyYXsw9A_ypZ3VkpG';
const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

async function isLoggedIn(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return false;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: auth } });
  return res.ok;
}

async function turnServers() {
  const env = process.env;
  if (env.CLOUDFLARE_TURN_KEY_ID && env.CLOUDFLARE_TURN_API_TOKEN) {
    // Trava de gasto: perto do fim da franquia grátis, para de entregar o TURN.
    const status = await turnStatus();
    if (status.blocked) {
      console.warn('TURN bloqueado:', status.reason);
      return [];
    }
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.CLOUDFLARE_TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 6 * 3600 }),
    });
    if (!res.ok) throw new Error(`cloudflare ${res.status}`);
    const data = await res.json();
    return data.iceServers || [];
  }
  if (env.METERED_DOMAIN && env.METERED_API_KEY) {
    const res = await fetch(`https://${env.METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${encodeURIComponent(env.METERED_API_KEY)}`);
    if (!res.ok) throw new Error(`metered ${res.status}`);
    return res.json();
  }
  if (env.TURN_URLS && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    return [{ urls: env.TURN_URLS.split(',').map((u) => u.trim()), username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL }];
  }
  return [];
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  let turn = [];
  try {
    if (await isLoggedIn(req)) turn = await turnServers();
  } catch (err) {
    console.error('ice', err);
  }
  res.status(200).json({ iceServers: [...STUN, ...turn], turn: turn.length > 0 });
}
