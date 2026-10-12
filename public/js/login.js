import { supabase, currentUser, friendlyError } from './supabase.js';
import { hydrateIcons } from './icons.js';

hydrateIcons();

const next = new URLSearchParams(location.search).get('next');
const destination = next && next.startsWith('/') && !next.startsWith('//') ? next : '/painel';
if (await currentUser()) location.replace(destination);

function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]);
}

const tempForm = document.getElementById('temp-form');
tempForm.addEventListener('submit', async () => {
  const errorEl = document.getElementById('temp-error');
  const button = tempForm.querySelector('button[type=submit]');
  errorEl.textContent = '';
  const { name, role } = Object.fromEntries(new FormData(tempForm));
  button.disabled = true;
  try {
    const password = randomPassword();
    const { data: email, error } = await supabase.rpc('create_temp_account', { p_name: name.trim(), p_role: role, p_password: password });
    if (error) throw error;
    const { error: loginError } = await supabase.auth.signInWithPassword({ email, password });
    if (loginError) throw loginError;
    location.replace(destination);
  } catch (err) {
    errorEl.textContent = friendlyError(err);
    button.disabled = false;
  }
});

const loginForm = document.getElementById('login-form');
document.getElementById('show-email').addEventListener('click', (e) => {
  loginForm.classList.toggle('hidden');
  e.currentTarget.classList.add('hidden');
  document.getElementById('login-email').focus();
});
loginForm.addEventListener('submit', async () => {
  const errorEl = document.getElementById('login-error');
  const button = loginForm.querySelector('button[type=submit]');
  errorEl.textContent = '';
  button.disabled = true;
  const { email, password } = Object.fromEntries(new FormData(loginForm));
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    errorEl.textContent = friendlyError(error);
    button.disabled = false;
  } else {
    location.replace(destination);
  }
});
