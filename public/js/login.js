import { supabase, currentUser, friendlyError, loginEmail } from './supabase.js';
import { hydrateIcons } from './icons.js';

hydrateIcons();

const next = new URLSearchParams(location.search).get('next');
const destination = next && next.startsWith('/') && !next.startsWith('//') ? next : '/painel';
if (await currentUser()) location.replace(destination);

const form = document.getElementById('login-form');
const errorEl = document.getElementById('login-error');
const button = form.querySelector('button[type=submit]');

form.querySelector('[data-show-password]').addEventListener('change', (e) => {
  document.getElementById('login-password').type = e.currentTarget.checked ? 'text' : 'password';
});

form.addEventListener('submit', async () => {
  errorEl.textContent = '';
  button.disabled = true;
  const { user, password } = Object.fromEntries(new FormData(form));
  const { error } = await supabase.auth.signInWithPassword({ email: loginEmail(user), password });
  if (error) {
    errorEl.textContent = error.message === 'Invalid login credentials' ? 'Usuário ou senha inválidos.' : friendlyError(error);
    button.disabled = false;
  } else {
    location.replace(destination);
  }
});
