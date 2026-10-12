import { supabase, currentUser, escapeHtml, friendlyError, toast } from './supabase.js';

const user = await currentUser();
if (!user) location.replace('/?next=/painel');

document.getElementById('who').textContent = user.displayName;
const pill = document.getElementById('role-pill');
pill.textContent = user.role === 'mestre' ? '🧙 Mestre' : '🗡️ Jogador';
pill.classList.add(`role-${user.role}`);
if (user.role !== 'mestre') document.getElementById('create-card').classList.add('hidden');

document.getElementById('logout').addEventListener('click', async () => {
  await supabase.auth.signOut();
  location.replace('/');
});

const roomsEl = document.getElementById('rooms');

async function loadRooms() {
  const { data: rooms, error } = await supabase
    .from('rooms')
    .select('id, name, description, master_id, created_at, master:profiles!rooms_master_id_fkey(display_name), room_members(count), room_invites(code)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  if (!rooms.length) {
    roomsEl.innerHTML = `<div class="empty">${
      user.role === 'mestre' ? 'Nenhuma sala ainda. Crie a primeira acima!' : 'Você ainda não está em nenhuma sala. Use o código de convite do seu mestre.'
    }</div>`;
    return;
  }
  roomsEl.innerHTML = rooms
    .map((r) => {
      const isMaster = r.master_id === user.id;
      const code = r.room_invites && r.room_invites.code;
      const players = (r.room_members[0] && r.room_members[0].count) || 0;
      return `
      <article class="card room-card">
        <h3>${escapeHtml(r.name)}</h3>
        ${r.description ? `<p class="muted small">${escapeHtml(r.description)}</p>` : ''}
        <div class="meta">
          <span class="pill ${isMaster ? 'role-mestre' : ''}">${isMaster ? '🧙 Você é o mestre' : `Mestre: ${escapeHtml(r.master && r.master.display_name)}`}</span>
          <span class="pill">👥 ${players} jogador(es)</span>
        </div>
        ${isMaster && code ? `<div class="small muted">Convite: <span class="code">${escapeHtml(code)}</span> <button class="small ghost" data-copy="${escapeHtml(code)}">Copiar</button></div>` : ''}
        <div class="row">
          <a class="btn primary" href="/sala/${r.id}">Abrir sala</a>
          ${isMaster ? `<button class="danger" data-delete="${r.id}">Excluir</button>` : `<button class="ghost" data-leave="${r.id}">Sair</button>`}
        </div>
      </article>`;
    })
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
      const { error } = await supabase.from('rooms').delete().eq('id', Number(btn.dataset.delete));
      if (error) throw error;
      await loadRooms();
    } else if (btn.dataset.leave) {
      if (!confirm('Sair desta sala?')) return;
      const { error } = await supabase.from('room_members').delete().eq('room_id', Number(btn.dataset.leave)).eq('user_id', user.id);
      if (error) throw error;
      await loadRooms();
    }
  } catch (err) {
    toast(friendlyError(err));
  }
});

document.getElementById('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('create-error');
  errorEl.textContent = '';
  const { data: roomId, error } = await supabase.rpc('create_room', {
    p_name: document.getElementById('room-name').value.trim(),
    p_description: document.getElementById('room-desc').value.trim(),
  });
  if (error) errorEl.textContent = friendlyError(error);
  else location.href = `/sala/${roomId}`;
});

document.getElementById('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('join-error');
  errorEl.textContent = '';
  const { data: roomId, error } = await supabase.rpc('join_room', { p_code: document.getElementById('join-code').value });
  if (error) errorEl.textContent = friendlyError(error);
  else location.href = `/sala/${roomId}`;
});

loadRooms().catch((err) => toast(friendlyError(err)));
