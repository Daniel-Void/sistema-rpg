// Consumo do TURN da Cloudflare no mês atual e a trava de gasto.
// A Cloudflare só cobra o que passa de 1000 GB/mês; ao chegar em TURN_LIMIT_GB
// (900 por padrão) o sistema para de entregar o TURN e nada é cobrado.
//
// Variáveis: CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_ANALYTICS_TOKEN (token só com
// "Account Analytics: Read"), TURN_LIMIT_GB (opcional), TURN_DISABLED=1 (desliga na mão).

const GB = 1e9;
const CACHE_MS = 5 * 60 * 1000;
let cache = null; // { at, usedBytes }

export function limitGb() {
  const n = Number(process.env.TURN_LIMIT_GB);
  return Number.isFinite(n) && n > 0 ? n : 900;
}

export function usageConfigured() {
  return Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ANALYTICS_TOKEN);
}

async function fetchMonthBytes() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const query = `query($account: string!, $start: Time!, $end: Time!) {
    viewer { accounts(filter: { accountTag: $account }) {
      callsTurnUsageAdaptiveGroups(filter: { datetimeMinute_geq: $start, datetimeMinute_lt: $end }, limit: 1) { sum { egressBytes } }
    } }
  }`;
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_ANALYTICS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { account: process.env.CLOUDFLARE_ACCOUNT_ID, start: start.toISOString(), end: now.toISOString() } }),
  });
  const body = await res.json();
  if (!res.ok || (body.errors && body.errors.length)) throw new Error(`analytics ${res.status} ${JSON.stringify(body.errors || '')}`);
  const groups = body.data.viewer.accounts[0]?.callsTurnUsageAdaptiveGroups || [];
  return groups.reduce((sum, g) => sum + (g.sum?.egressBytes || 0), 0);
}

/** Situação da trava. Se a consulta falhar, usa o último valor conhecido. */
export async function turnStatus() {
  const status = { configured: usageConfigured(), limitGb: limitGb(), usedGb: null, blocked: false, reason: null };
  if (process.env.TURN_DISABLED === '1') return { ...status, blocked: true, reason: 'desligado manualmente' };
  if (!status.configured) return { ...status, reason: 'medição de consumo não configurada' };
  try {
    if (!cache || Date.now() - cache.at > CACHE_MS) cache = { at: Date.now(), usedBytes: await fetchMonthBytes() };
  } catch (err) {
    console.error('turn usage', err);
    if (!cache) return { ...status, reason: 'não foi possível medir o consumo agora' };
  }
  status.usedGb = Math.round((cache.usedBytes / GB) * 100) / 100;
  if (status.usedGb >= status.limitGb) {
    status.blocked = true;
    status.reason = `limite de ${status.limitGb} GB do mês atingido`;
  }
  return status;
}
