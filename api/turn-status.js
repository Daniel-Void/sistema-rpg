// Consumo do TURN no mês e se a trava está ativa. Não expõe nenhuma chave.
import { turnStatus } from './_turnUsage.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const turnConfigured = Boolean(process.env.CLOUDFLARE_TURN_KEY_ID && process.env.CLOUDFLARE_TURN_API_TOKEN);
  res.status(200).json({ turnConfigured, ...(await turnStatus()) });
}
