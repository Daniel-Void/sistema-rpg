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

document.getElementById('logout').addEventListener('click', async () => {
  await supabase.auth.signOut();
  location.replace('/');
});

const roomsEl = document.getElementById('rooms');

/** "Expira em 5h 12min" */
function expiresText(expiresAt) {
  const ms = Date.parse(expiresAt) - Date.now();
  if (!(ms > 0)) return 'Expirando';
  const min = Math.ceil(ms / 60000);
  const h = Math.floor(min / 60);
  return `Expira em ${h ? `${h}h ` : ''}${min % 60}min`;
}

// Arquivos (imagens, áudios) de salas que já expiraram: o Storage só deixa
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
  rooms = rooms.filter((r) => !r.expires_at || Date.parse(r.expires_at) > Date.now());
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
          ${r.expires_at ? `<span class="tag" title="Toda sala é excluída 8 horas depois de criada">${expiresText(r.expires_at)}</span>` : ''}
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

loadRooms().catch((err) => toast(friendlyError(err)));
cleanupOrphanFiles().catch(() => {});
