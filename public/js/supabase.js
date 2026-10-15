import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.1/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Contas criadas pelo mestre entram com nome de usuário; no Auth elas têm um
// e-mail interno nesse domínio. Contas antigas ainda entram com o e-mail.
export const USERNAME_DOMAIN = 'usuarios.sistema-rpg.example.com';
export function loginEmail(user) {
  const value = String(user || '').trim().toLowerCase();
  return value.includes('@') ? value : `${value}@${USERNAME_DOMAIN}`;
}

/** Usuário logado com o perfil (nome exibido e papel), ou null. */
export async function currentUser() {
  const { data } = await supabase.auth.getSession();
  const user = data.session && data.session.user;
  if (!user) return null;
  const { data: profile } = await supabase.from('profiles').select('display_name, role').eq('id', user.id).maybeSingle();
  if (!profile) return null;
  return { id: user.id, email: user.email, displayName: profile.display_name, role: profile.role };
}

/** Mensagem amigável para erros do Supabase. */
export function friendlyError(error) {
  if (!error) return 'Algo deu errado. Tente novamente.';
  const msg = error.message || String(error);
  const known = {
    'Invalid login credentials': 'E-mail ou senha inválidos.',
    'Email not confirmed': 'Confirme seu e-mail antes de entrar (veja sua caixa de entrada).',
    'User already registered': 'Já existe uma conta com esse e-mail.',
  };
  if (known[msg]) return known[msg];
  if (/rate limit/i.test(msg)) return 'Muitas tentativas. Aguarde alguns minutos e tente de novo.';
  if (/Password should be at least/i.test(msg)) return 'A senha precisa ter pelo menos 6 caracteres.';
  return msg;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

export function toast(message, ms = 3500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
