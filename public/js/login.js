import { supabase, currentUser, friendlyError } from './supabase.js';

const next = new URLSearchParams(location.search).get('next');
const destination = next && next.startsWith('/') && !next.startsWith('//') ? next : '/painel';
if (await currentUser()) location.replace(destination);

const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');

function showTab(register) {
  registerForm.classList.toggle('hidden', !register);
  loginForm.classList.toggle('hidden', register);
  tabRegister.classList.toggle('active', register);
  tabLogin.classList.toggle('active', !register);
}
tabLogin.addEventListener('click', () => showTab(false));
tabRegister.addEventListener('click', () => showTab(true));

async function withButton(form, fn) {
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    await fn();
  } finally {
    button.disabled = false;
  }
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';
  const { email, password } = Object.fromEntries(new FormData(loginForm));
  withButton(loginForm, async () => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) errorEl.textContent = friendlyError(error);
    else location.replace(destination);
  });
});

registerForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('register-error');
  const notice = document.getElementById('register-notice');
  errorEl.textContent = '';
  notice.classList.add('hidden');
  const { email, password, displayName, role } = Object.fromEntries(new FormData(registerForm));
  withButton(registerForm, async () => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { display_name: displayName.trim(), role },
        emailRedirectTo: `${location.origin}${destination}`,
      },
    });
    if (error) {
      errorEl.textContent = friendlyError(error);
    } else if (data.session) {
      location.replace(destination);
    } else {
      notice.textContent = `Conta criada! Enviamos um link de confirmação para ${email}. Confirme e depois entre aqui.`;
      notice.classList.remove('hidden');
      registerForm.reset();
    }
  });
});
