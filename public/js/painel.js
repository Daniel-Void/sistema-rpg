import { api, currentUser, escapeHtml, toast } from './api.js';

const user = await currentUser();
if (!user) location.replace('/?next=/painel');

document.getElementById('who').textContent = user.displayName;
const pill = document.getElementById('role-pill');
pill.textContent = user.role === 'mestre' ? '🧙 Mestre' : '🗡️ Jogador';
pill.classList.add(`role-${user.role}`);
if (user.role !== 'mestre') document.getElementById('create-card').classList.add('hidden');

document.getElementById('logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  location.replace('/');
});

const roomsEl = document.getElementById('rooms');

async function loadRooms() {
  const { rooms } = await api('/rooms');
  if (!rooms.length) {
    roomsEl.innerHTML = `<div class="empty">${
      user.role === 'mestre' ? 'Nenhuma sala ainda. Crie a primeira acima!' : 'Você ainda não está em nenhuma sala. Use o código de convite do seu mestre.'
    }</div>`;
    return;
  }
  roomsEl.innerHTML = rooms
    .map(
      (r) => `
      <article class="card room-card">
        <h3>${escapeHtml(r.name)}</h3>
        ${r.description ? `<p class="muted small">${escapeHtml(r.description)}</p>` : ''}
        <div class="meta">
          <span class="pill ${r.isMaster ? 'role-mestre' : ''}">${r.isMaster ? '🧙 Você é o mestre' : `Mestre: ${escapeHtml(r.masterName)}`}</span>
          <span class="pill">👥 ${r.playerCount} jogador(es)</span>
          ${r.online ? `<span class="pill" style="color:var(--ok)">● ${r.online} na call</span>` : ''}
        </div>
        ${r.isMaster ? `<div class="small muted">Convite: <span class="code">${escapeHtml(r.inviteCode)}</span> <button class="small ghost" data-copy="${escapeHtml(r.inviteCode)}">Copiar</button></div>` : ''}
        <div class="row">
          <a class="btn primary" href="/sala/${r.id}">Abrir sala</a>
          ${r.isMaster ? `<button class="danger" data-delete="${r.id}">Excluir</button>` : `<button class="ghost" data-leave="${r.id}">Sair</button>`}
        </div>
      </article>`,
    )
    .join('');
}

roomsEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  try {
    if (btn.dataset.copy) {
      await navigator.clipboard.writeText(btn.dataset.copy);
      toast('Código copiado!');
    } else if (btn.dataset.delete) {
      if (!confirm('Excluir esta sala? Isso não pode ser desfeito.')) return;
      await api(`/rooms/${btn.dataset.delete}`, { method: 'DELETE' });
      loadRooms();
    } else if (btn.dataset.leave) {
      if (!confirm('Sair desta sala?')) return;
      await api(`/rooms/${btn.dataset.leave}/members/${user.id}`, { method: 'DELETE' });
      loadRooms();
    }
  } catch (err) {
    toast(err.message);
  }
});

document.getElementById('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('create-error');
  errorEl.textContent = '';
  try {
    const { room } = await api('/rooms', {
      method: 'POST',
      body: { name: document.getElementById('room-name').value, description: document.getElementById('room-desc').value },
    });
    location.href = `/sala/${room.id}`;
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

document.getElementById('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('join-error');
  errorEl.textContent = '';
  try {
    const { roomId } = await api('/rooms/join', { method: 'POST', body: { code: document.getElementById('join-code').value } });
    location.href = `/sala/${roomId}`;
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

loadRooms().catch((err) => toast(err.message));
