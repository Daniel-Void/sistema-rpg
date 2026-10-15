import { supabase, currentUser, escapeHtml, friendlyError, toast } from './supabase.js';
import { hydrateIcons, icon } from './icons.js';

hydrateIcons();

const user = await currentUser();
if (!user) location.replace('/?next=/painel');

document.getElementById('who').textContent = user.displayName;
const roleTag = document.getElementById('role-tag');
roleTag.textContent = user.role === 'mestre' ? 'Mestre' : 'Jogador';
if (user.role === 'mestre') roleTag.classList.add('accent');
if (user.role !== 'mestre') document.getElementById('create-card').classList.add('hidden');
else document.getElementById('players-card').classList.remove('hidden');

document.getElementById('logout').addEventListener('click', async () => {
  await supabase.auth.signOut();
  location.replace('/');
});

const roomsEl = document.getElementById('rooms');

// Arquivos (imagens, áudios) de salas que já foram excluídas: o Storage só deixa
// apagar pela API, então quem enviou limpa ao abrir o painel.
async function cleanupOrphanFiles() {
  const { data, error } = await supabase.rpc('my_orphan_files');
  if (error || !data || !data.length) return;
  const names = data.map((row) => (typeof row === 'string' ? row : row.my_orphan_files)).filter(Boolean);
  for (let i = 0; i < names.length; i += 100) await supabase.storage.from('midia').remove(names.slice(i, i + 100));
}

async function loadRooms() {
  let { data: rooms, error } = await supabase
    .from('rooms')
    .select('*, master:profiles!rooms_master_id_fkey(display_name), room_members(count), room_invites(code)')
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
      <article class="panel room-card">
        <h3>${escapeHtml(r.name)}</h3>
        ${r.description ? `<p class="muted small" style="margin:0">${escapeHtml(r.description)}</p>` : ''}
        <div class="meta">
          ${isMaster ? '<span class="tag accent">Você é o mestre</span>' : `<span class="tag">Mestre: ${escapeHtml(r.master && r.master.display_name)}</span>`}
          <span class="tag">${icon('users', 13)}${players} ${players === 1 ? 'jogador' : 'jogadores'}</span>
        </div>
        ${isMaster && code ? `<div class="invite">Convite <span class="code">${escapeHtml(code)}</span> <button class="sm quiet icon-only" data-copy="${escapeHtml(code)}" title="Copiar código">${icon('copy', 15)}</button></div>` : ''}
        <div class="actions">
          <a class="btn primary" href="/sala/${r.id}">Abrir</a>
          ${isMaster ? `<button class="danger" data-delete="${r.id}">Excluir</button>` : `<button data-leave="${r.id}">Sair</button>`}
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
      const roomId = Number(btn.dataset.delete);
      // Apaga também os arquivos da biblioteca da sala
      const { data: media } = await supabase.from('room_media').select('storage_path').eq('room_id', roomId);
      if (media && media.length) await supabase.storage.from('midia').remove(media.map((m) => m.storage_path));
      const { error } = await supabase.from('rooms').delete().eq('id', roomId);
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

// ---------- Contas de jogador (só o mestre, que é o admin) ----------

const playersEl = document.getElementById('players');
const playerForm = document.getElementById('player-form');

/** Senha fácil de ditar: sem letras parecidas (l/1, O/0). */
function generatePassword(length = 12) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

async function loadPlayers() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, username')
    .eq('role', 'jogador')
    .not('username', 'is', null)
    .order('display_name');
  if (error) {
    playersEl.innerHTML = '<div class="hint">Não foi possível carregar as contas.</div>';
    return;
  }
  playersEl.innerHTML = data.length
    ? data
        .map(
          (p) => `
      <div class="player-row">
        <div class="info"><div class="name">${escapeHtml(p.display_name)}</div><div class="user">${escapeHtml(p.username)}</div></div>
        <button class="sm quiet" data-reset="${p.id}" data-name="${escapeHtml(p.display_name)}" data-user="${escapeHtml(p.username)}">Trocar senha</button>
        <button class="sm quiet icon-only" data-remove="${p.id}" data-name="${escapeHtml(p.display_name)}" title="Excluir conta">${icon('trash', 15)}</button>
      </div>`,
        )
        .join('')
    : '<div class="hint">Nenhum jogador criado ainda.</div>';
}

function showCredentials(username, password, title) {
  const box = document.getElementById('player-created');
  box.innerHTML = `${escapeHtml(title)}<br>Usuário: <span class="mono">${escapeHtml(username)}</span><br>Senha: <span class="mono">${escapeHtml(password)}</span>
    <div style="margin-top:0.5rem"><button type="button" class="sm" data-copy-login>${icon('copy', 14)}Copiar usuário e senha</button></div>`;
  box.querySelector('[data-copy-login]').addEventListener('click', async () => {
    await navigator.clipboard.writeText(`Usuário: ${username}\nSenha: ${password}\n${location.origin}`);
    toast('Usuário e senha copiados.');
  });
  box.classList.remove('hidden');
}

document.getElementById('player-generate').addEventListener('click', () => {
  document.getElementById('player-password').value = generatePassword();
});

playerForm.addEventListener('submit', async () => {
  const errorEl = document.getElementById('player-error');
  const button = playerForm.querySelector('button[type=submit]');
  errorEl.textContent = '';
  const { name, username, password } = Object.fromEntries(new FormData(playerForm));
  const login = username.trim().toLowerCase();
  button.disabled = true;
  const { error } = await supabase.rpc('create_player_account', { p_username: login, p_display_name: name.trim(), p_password: password });
  button.disabled = false;
  if (error) {
    errorEl.textContent = friendlyError(error);
    return;
  }
  playerForm.reset();
  showCredentials(login, password, `Conta de ${name.trim()} criada.`);
  await loadPlayers();
});

playersEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  try {
    if (btn.dataset.reset) {
      const password = prompt(`Nova senha para ${btn.dataset.name} (pelo menos 8 caracteres):`, generatePassword());
      if (password === null) return;
      const { error } = await supabase.rpc('set_player_password', { p_user: btn.dataset.reset, p_password: password });
      if (error) throw error;
      showCredentials(btn.dataset.user, password, `Senha de ${btn.dataset.name} trocada.`);
    } else if (btn.dataset.remove) {
      if (!confirm(`Excluir a conta de ${btn.dataset.name}? Isso não pode ser desfeito.`)) return;
      const { error } = await supabase.rpc('delete_player_account', { p_user: btn.dataset.remove });
      if (error) throw error;
      await loadPlayers();
    }
  } catch (err) {
    toast(friendlyError(err));
  }
});

if (user.role === 'mestre') loadPlayers();
loadRooms().catch((err) => toast(friendlyError(err)));
cleanupOrphanFiles().catch(() => {});
