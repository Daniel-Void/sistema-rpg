import { api, currentUser } from './api.js';

if (await currentUser()) location.replace('/painel');

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

async function submit(form, path, errorEl) {
  const body = Object.fromEntries(new FormData(form));
  const button = form.querySelector('button[type=submit]');
  errorEl.textContent = '';
  button.disabled = true;
  try {
    await api(path, { method: 'POST', body });
    location.replace(new URLSearchParams(location.search).get('next') || '/painel');
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  submit(loginForm, '/login', document.getElementById('login-error'));
});
registerForm.addEventListener('submit', (e) => {
  e.preventDefault();
  submit(registerForm, '/register', document.getElementById('register-error'));
});
