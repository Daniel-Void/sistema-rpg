import { supabase, currentUser, friendlyError } from './supabase.js';
import { hydrateIcons } from './icons.js';

hydrateIcons();

const next = new URLSearchParams(location.search).get('next');
const destination = next && next.startsWith('/') && !next.startsWith('//') ? next : '/painel';
// Links de e-mail (confirmação e troca de senha) voltam para cá com o resultado no "#".
const hashParams = new URLSearchParams(location.hash.slice(1));
const isRecovery = hashParams.get('type') === 'recovery';
const linkError = hashParams.get('error_description');

const messageEl = document.getElementById('entry-message');
function showMessage(text, ok = false) {
  messageEl.textContent = text;
  messageEl.classList.toggle('ok', ok);
  messageEl.classList.toggle('hidden', !text);
}

const tabs = [...document.querySelectorAll('.entry-tabs [data-tab]')];
const panels = [...document.querySelectorAll('[data-panel]')];
function showPanel(name) {
  for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  for (const panel of panels) panel.classList.toggle('hidden', panel.dataset.panel !== name);
  document.querySelector('.entry-tabs').classList.toggle('hidden', name === 'nova-senha');
  showMessage('');
  const first = document.querySelector(`[data-panel="${name}"] input:not([type=radio]):not([type=checkbox])`);
  if (first && !first.value) first.focus();
}
for (const tab of tabs) tab.addEventListener('click', () => showPanel(tab.dataset.tab));

for (const box of document.querySelectorAll('[data-show-password]')) {
  box.addEventListener('change', () => {
    for (const input of box.closest('form').querySelectorAll('input[name=password], input[name=confirm]')) {
      input.type = box.checked ? 'text' : 'password';
    }
  });
}

/** Trava o botão do formulário enquanto a ação roda e mostra o erro, se houver. */
function handle(form, errorId, action) {
  const errorEl = document.getElementById(errorId);
  const button = form.querySelector('button[type=submit]');
  form.addEventListener('submit', async () => {
    errorEl.textContent = '';
    button.disabled = true;
    try {
      await action(Object.fromEntries(new FormData(form)));
    } catch (err) {
      errorEl.textContent = friendlyError(err);
    }
    button.disabled = false;
  });
}

function checkPasswords({ password, confirm }) {
  if (password.length < 6) throw new Error('A senha precisa ter pelo menos 6 caracteres.');
  if (password !== confirm) throw new Error('As senhas não são iguais.');
}

const loginForm = document.getElementById('login-form');
handle(loginForm, 'login-error', async ({ email, password }) => {
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw error;
  location.replace(destination);
});

document.getElementById('forgot').addEventListener('click', async (e) => {
  const errorEl = document.getElementById('login-error');
  const email = document.getElementById('login-email').value.trim();
  errorEl.textContent = '';
  if (!email) {
    errorEl.textContent = 'Digite seu e-mail acima e clique de novo em "Esqueci minha senha".';
    document.getElementById('login-email').focus();
    return;
  }
  e.currentTarget.disabled = true;
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/` });
  e.currentTarget.disabled = false;
  if (error) errorEl.textContent = friendlyError(error);
  else showMessage(`Se existir uma conta com ${email}, enviamos um link para criar uma nova senha.`, true);
});

const tempForm = document.getElementById('temp-form');
handle(tempForm, 'temp-error', async ({ name, role }) => {
  const password = randomPassword();
  const { data: email, error } = await supabase.rpc('create_temp_account', { p_name: name.trim(), p_role: role, p_password: password });
  if (error) throw error;
  const { error: loginError } = await supabase.auth.signInWithPassword({ email, password });
  if (loginError) throw loginError;
  location.replace(destination);
});

function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]);
}

const resetForm = document.getElementById('reset-form');
handle(resetForm, 'reset-error', async (fields) => {
  checkPasswords(fields);
  const { error } = await supabase.auth.updateUser({ password: fields.password });
  if (error) throw error;
  location.replace(destination);
});

// Espera o cliente ler o link do e-mail antes de limpar o endereço.
await supabase.auth.getSession();
if (isRecovery) {
  history.replaceState(null, '', location.pathname + location.search);
  showPanel('nova-senha');
} else {
  if (linkError) {
    history.replaceState(null, '', location.pathname + location.search);
    showMessage(/expired|invalid/i.test(linkError) ? 'Esse link expirou ou já foi usado. Peça um novo.' : linkError);
  }
  if (await currentUser()) location.replace(destination);
}
