import { supabase, currentUser, escapeHtml, friendlyError, initials, toast } from './supabase.js';
import { ICE_SERVERS } from './config.js';
import { computeRouting, normalizeMasterTarget } from './audioRules.js';

const roomId = Number(location.pathname.split('/').filter(Boolean).pop());
const $ = (id) => document.getElementById(id);

const user = await currentUser();
if (!user) location.replace(`/?next=${encodeURIComponent(location.pathname)}`);

// Identifica esta aba. Se o mesmo usuário abrir a sala em outra aba, a mais nova assume.
const sessionId = crypto.randomUUID();
const joinedAt = Date.now();

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

let db = null; // { room, zones, members, inviteCode } vindo do banco
let online = new Map(); // userId -> { sessionId, joinedAt, muted } (presença na call)
let state = null; // visão calculada para renderizar e rotear
let channel = null;
let inCall = false;
let localStream = null;
let micTrack = null;
let audioCtx = null;
let muted = false;
const peers = new Map(); // userId -> peer
const analysers = new Map(); // userId -> AnalyserNode
const speaking = new Set();

const VOLUME_KEY = `rpg-volumes-${roomId}`;
let zoneVolumes = {};
try {
  zoneVolumes = JSON.parse(localStorage.getItem(VOLUME_KEY)) || {};
} catch {
  zoneVolumes = {};
}

let isMaster = false;
const emptyRouting = { sendTo: [], hearFrom: [] };
const routing = () => (state && state.routing) || emptyRouting;
const playerById = (id) => state && state.players.find((p) => p.userId === id);
const zoneById = (id) => state && state.zones.find((z) => z.id === id);
function nameOf(id) {
  if (state && state.master && state.master.userId === id) return `${state.master.displayName} (mestre)`;
  const p = playerById(id);
  return p ? p.displayName : 'Alguém';
}

// ---------------------------------------------------------------------------
// Dados do banco
// ---------------------------------------------------------------------------

async function loadData() {
  const [roomRes, zonesRes, membersRes] = await Promise.all([
    supabase.from('rooms').select('id, name, description, master_id, master_target, master:profiles!rooms_master_id_fkey(display_name), room_invites(code)').eq('id', roomId).maybeSingle(),
    supabase.from('zones').select('id, name, position').eq('room_id', roomId).eq('archived', false).order('position').order('id'),
    supabase.from('room_members').select('user_id, zone_id, whisper_to_master, profile:profiles(display_name)').eq('room_id', roomId),
  ]);
  const error = roomRes.error || zonesRes.error || membersRes.error;
  if (error) throw error;
  return roomRes.data ? { room: roomRes.data, zones: zonesRes.data, members: membersRes.data } : null;
}

let refreshTimer = null;
let refreshing = Promise.resolve();
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshing = refreshing.then(refresh).catch((err) => console.error('refresh', err));
  }, 40);
}

async function refresh() {
  const data = await loadData();
  if (!data) return handleRemoved('A sala foi excluída ou você não faz mais parte dela.');
  if (data.room.master_id !== user.id && !data.members.some((m) => m.user_id === user.id)) {
    return handleRemoved('Você foi removido da sala pelo mestre.');
  }
  db = data;
  recompute();
}

/** Junta banco + presença, calcula as regras de áudio e atualiza a tela e as conexões. */
function recompute() {
  if (!db) return;
  const zones = db.zones;
  const zoneIds = zones.map((z) => z.id);
  const effectiveZone = (zoneId) => (zoneIds.includes(zoneId) ? zoneId : zoneIds[0] ?? null);
  const masterId = db.room.master_id;
  const masterOnline = online.get(masterId);

  const players = db.members
    .map((m) => {
      const presence = online.get(m.user_id);
      return {
        userId: m.user_id,
        displayName: (m.profile && m.profile.display_name) || 'Jogador',
        zoneId: effectiveZone(m.zone_id),
        online: Boolean(presence),
        muted: presence ? presence.muted : false,
        whisperToMaster: m.whisper_to_master,
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt-BR'));

  const masterTarget = normalizeMasterTarget(db.room.master_target, { zoneIds, playerIds: players.map((p) => p.userId) });

  const participants = new Map();
  if (masterOnline) participants.set(masterId, { role: 'mestre', zoneId: null });
  for (const p of players) if (p.online) participants.set(p.userId, { role: 'jogador', zoneId: p.zoneId, whisperToMaster: p.whisperToMaster });

  const allRouting = computeRouting({ participants, masterTarget });
  const myRouting = allRouting[user.id] || emptyRouting;
  const masterSpeaksToMe = Boolean(masterOnline && allRouting[masterId] && allRouting[masterId].sendTo.includes(user.id));

  state = {
    zones,
    players,
    master: { userId: masterId, displayName: (db.room.master && db.room.master.display_name) || 'Mestre', online: Boolean(masterOnline), muted: masterOnline ? masterOnline.muted : false },
    // Para jogadores, o alvo do mestre só aparece quando inclui eles.
    masterTarget: isMaster || masterSpeaksToMe ? masterTarget : null,
    routing: inCall ? myRouting : emptyRouting,
  };

  render();
  if (inCall) {
    reconcilePeers();
    applyAllRouting();
  }
}

function handleRemoved(reason) {
  stopCall();
  showOverlay('Você saiu da sala', reason, 'Voltar ao painel', () => location.replace('/painel'));
}

// ---------------------------------------------------------------------------
// Realtime: presença (quem está na call) + mudanças no banco + sinalização
// ---------------------------------------------------------------------------

function connectRealtime() {
  return new Promise((resolve, reject) => {
    channel = supabase.channel(`room:${roomId}`, { config: { private: true, presence: { key: sessionId } } });
    const onChange = () => scheduleRefresh();
    channel
      // Atualizações frequentes (alvo do mestre, mover jogador, sussurro) são aplicadas na hora, sem recarregar.
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` }, ({ new: row }) => {
        if (db && row) db.room.master_target = row.master_target;
        recompute();
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'room_members', filter: `room_id=eq.${roomId}` }, ({ new: row }) => {
        const member = db && row && db.members.find((m) => m.user_id === row.user_id);
        if (!member) return onChange();
        member.zone_id = row.zone_id;
        member.whisper_to_master = row.whisper_to_master;
        recompute();
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_members', filter: `room_id=eq.${roomId}` }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'zones', filter: `room_id=eq.${roomId}` }, onChange)
      // Exclusões não aceitam filtro: qualquer exclusão nessas tabelas faz recarregar.
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'room_members' }, onChange)
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'rooms' }, onChange)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'signals', filter: `to_user=eq.${user.id}` }, ({ new: row }) => onSignalRow(row))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'signals', filter: `to_user=eq.${user.id}` }, ({ new: row }) => onSignalRow(row))
      .on('presence', { event: 'sync' }, onPresenceSync)
      .subscribe(async (status, err) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ userId: user.id, joinedAt, muted });
          scheduleRefresh(); // pega qualquer mudança que aconteceu enquanto conectava
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          updateConnStatus(false);
          reject(err || new Error(status));
        } else if (status === 'CLOSED') {
          updateConnStatus(false);
        }
      });
  });
}

function onPresenceSync() {
  // presenceState(): { <sessionId da aba>: [{ userId, joinedAt, muted }] }
  const next = new Map();
  for (const [key, metas] of Object.entries(channel.presenceState())) {
    for (const m of metas) {
      if (!m.userId) continue;
      const entry = { sessionId: key, joinedAt: m.joinedAt || 0, muted: Boolean(m.muted) };
      const current = next.get(m.userId);
      // Se o mesmo usuário estiver em duas abas, vale a mais recente
      if (!current || entry.joinedAt > current.joinedAt) next.set(m.userId, entry);
    }
  }
  const mine = next.get(user.id);
  if (mine && mine.sessionId !== sessionId && mine.joinedAt > joinedAt) {
    handleRemoved('Você entrou nesta sala em outra aba.');
    return;
  }
  online = next;
  updateConnStatus(true);
  recompute();
}

// ---------------------------------------------------------------------------
// WebRTC (malha P2P com "perfect negotiation"; sinais vão pelo banco)
// ---------------------------------------------------------------------------

async function sendSignal(peer, data) {
  peer.seq += 1;
  const { error } = await supabase.from('signals').upsert(
    { room_id: roomId, from_session: sessionId, to_user: peer.id, to_session: peer.sessionId, payload: { ...data, seq: peer.seq } },
    { onConflict: 'from_session,to_session' },
  );
  if (error) console.error('signal', error);
}

/** Espera o navegador reunir os candidatos de rede, para mandar tudo numa mensagem só. */
function waitForIce(pc, timeout = 2500) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    const timer = setTimeout(done, timeout);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

async function sendDescription(peer) {
  await waitForIce(peer.pc);
  await sendSignal(peer, { description: peer.pc.localDescription.toJSON() });
}

function createPeer(peerId, peerSession, initiator) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const audio = new Audio();
  audio.autoplay = true;
  const peer = {
    id: peerId,
    sessionId: peerSession,
    pc,
    audio,
    polite: !initiator,
    makingOffer: false,
    ignoreOffer: false,
    transceiver: null,
    seq: 0,
    lastSeq: 0,
    queue: Promise.resolve(),
  };
  peers.set(peerId, peer);

  if (initiator) peer.transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });

  pc.ontrack = ({ track, streams, transceiver }) => {
    peer.transceiver = peer.transceiver || transceiver;
    const stream = streams[0] || new MediaStream([track]);
    audio.srcObject = stream;
    audio.play().catch(() => {});
    watchLevel(peerId, stream);
    applyPeerRouting(peer);
  };
  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      await sendDescription(peer);
    } catch (err) {
      console.error('negotiation', err);
    } finally {
      peer.makingOffer = false;
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') pc.restartIce();
    updateConnStatus(true);
  };

  applyPeerRouting(peer);
  return peer;
}

function closePeer(peerId) {
  const peer = peers.get(peerId);
  if (!peer) return;
  peer.pc.close();
  peer.audio.srcObject = null;
  peers.delete(peerId);
  analysers.delete(peerId);
  speaking.delete(peerId);
}

function closeAllPeers() {
  for (const id of [...peers.keys()]) closePeer(id);
}

/** Quem é participante válido da sala (mestre ou membro) segundo o banco. */
function isParticipant(userId) {
  return db && (db.room.master_id === userId || db.members.some((m) => m.user_id === userId));
}

/** Abre/fecha conexões conforme quem está na call. Quem entrou por último inicia. */
function reconcilePeers() {
  for (const [peerId, peer] of peers) {
    const presence = online.get(peerId);
    if (!presence || presence.sessionId !== peer.sessionId || !isParticipant(peerId)) closePeer(peerId);
  }
  for (const [peerId, presence] of online) {
    if (peerId === user.id || peers.has(peerId) || !isParticipant(peerId) || !presence.sessionId) continue;
    const iStart = joinedAt > presence.joinedAt || (joinedAt === presence.joinedAt && sessionId > presence.sessionId);
    if (iStart) createPeer(peerId, presence.sessionId, true);
  }
  updateConnStatus(true);
}

function onSignalRow(row) {
  if (!inCall || !row || row.to_session !== sessionId || !isParticipant(row.from_user)) return;
  let peer = peers.get(row.from_user);
  if (peer && peer.sessionId !== row.from_session) {
    closePeer(row.from_user);
    peer = null;
  }
  if (!peer) peer = createPeer(row.from_user, row.from_session, false);
  const data = row.payload || {};
  if (typeof data.seq === 'number') {
    if (data.seq <= peer.lastSeq) return; // mensagem velha ou repetida
    peer.lastSeq = data.seq;
  }
  peer.queue = peer.queue.then(() => handleDescription(peer, data.description)).catch((err) => console.error('signal', err));
}

async function handleDescription(peer, description) {
  if (!description) return;
  const { pc } = peer;
  const collision = description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
  peer.ignoreOffer = !peer.polite && collision;
  if (peer.ignoreOffer) return;
  await pc.setRemoteDescription(description);
  if (description.type === 'offer') {
    const t = pc.getTransceivers().find((tr) => tr.receiver.track.kind === 'audio');
    if (t) {
      peer.transceiver = t;
      t.direction = 'sendrecv';
    }
    await applyPeerRouting(peer);
    await pc.setLocalDescription();
    await sendDescription(peer);
  }
}

/**
 * Aplica as regras de áudio a uma conexão:
 *  - só ENVIA o microfone se as regras dizem que esse peer pode nos ouvir;
 *  - só TOCA o áudio recebido se as regras dizem que podemos ouvir esse peer.
 */
async function applyPeerRouting(peer) {
  const r = routing();
  const sender = peer.transceiver && peer.transceiver.sender;
  const desired = r.sendTo.includes(peer.id) ? micTrack : null;
  if (sender && sender.track !== desired) {
    try {
      await sender.replaceTrack(desired);
    } catch (err) {
      console.error('replaceTrack', err);
    }
  }
  peer.audio.muted = !r.hearFrom.includes(peer.id);
  peer.audio.volume = volumeFor(peer.id);
}

function volumeFor(userId) {
  if (!isMaster || !state) return 1;
  const p = playerById(userId);
  if (!p) return 1;
  const v = zoneVolumes[p.zoneId];
  return typeof v === 'number' ? v : 1;
}

function applyAllRouting() {
  for (const peer of peers.values()) applyPeerRouting(peer);
}

// ---------------------------------------------------------------------------
// Indicador de quem está falando
// ---------------------------------------------------------------------------

function watchLevel(userId, stream) {
  if (!audioCtx) return;
  try {
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    analysers.set(userId, analyser);
  } catch (err) {
    console.warn('analyser', err);
  }
}

const levelBuffer = new Uint8Array(512);
setInterval(() => {
  let changed = false;
  for (const [id, analyser] of analysers) {
    analyser.getByteTimeDomainData(levelBuffer);
    let sum = 0;
    for (let i = 0; i < levelBuffer.length; i++) {
      const v = (levelBuffer[i] - 128) / 128;
      sum += v * v;
    }
    const peer = peers.get(id);
    const audible = id === user.id ? !muted : peer && !peer.audio.muted;
    const isSpeaking = audible && Math.sqrt(sum / levelBuffer.length) > 0.035;
    if (isSpeaking !== speaking.has(id)) {
      changed = true;
      if (isSpeaking) speaking.add(id);
      else speaking.delete(id);
    }
  }
  if (changed) {
    document.querySelectorAll('.person[data-user]').forEach((el) => el.classList.toggle('speaking', speaking.has(el.dataset.user)));
  }
}, 120);

// ---------------------------------------------------------------------------
// Ciclo da call
// ---------------------------------------------------------------------------

async function startCall() {
  $('join-error').textContent = '';
  $('join-btn').disabled = true;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (err) {
    $('join-btn').disabled = false;
    $('join-error').textContent = 'Não foi possível acessar o microfone. Verifique a permissão do navegador.';
    console.error(err);
    return;
  }
  micTrack = localStream.getAudioTracks()[0];
  audioCtx = new AudioContext();
  watchLevel(user.id, localStream);
  inCall = true;
  try {
    await connectRealtime();
  } catch (err) {
    console.error(err);
    stopCall();
    $('join-btn').disabled = false;
    $('join-error').textContent = 'Não foi possível conectar à sala em tempo real. Tente novamente.';
    return;
  }
  $('join-overlay').classList.add('hidden');
  $('mute-btn').disabled = false;
}

function stopCall() {
  inCall = false;
  if (channel) {
    supabase.removeChannel(channel);
    channel = null;
  }
  closeAllPeers();
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  if (audioCtx && audioCtx.state !== 'closed') audioCtx.close();
  analysers.clear();
  updateConnStatus(false);
}

function showOverlay(title, text, buttonText, onClick) {
  $('overlay-title').textContent = title;
  $('overlay-text').textContent = text;
  if (buttonText) {
    $('join-btn').textContent = buttonText;
    $('join-btn').onclick = onClick;
    $('join-btn').disabled = false;
  }
  $('join-overlay').classList.remove('hidden');
}

function updateConnStatus(connected) {
  const el = $('conn-status');
  if (!connected || !inCall) {
    el.textContent = '● Desconectado';
    el.style.color = 'var(--danger)';
    return;
  }
  const total = peers.size;
  const ok = [...peers.values()].filter((p) => p.pc.connectionState === 'connected').length;
  el.textContent = total ? `● ${ok}/${total} conectados` : '● Na call';
  el.style.color = ok === total ? 'var(--ok)' : 'var(--accent)';
}

$('leave-btn').onclick = () => {
  stopCall();
  location.href = '/painel';
};
$('mute-btn').onclick = () => {
  muted = !muted;
  if (micTrack) micTrack.enabled = !muted;
  $('mute-btn').textContent = muted ? '🔇 Microfone mudo' : '🎙️ Microfone ligado';
  $('mute-btn').classList.toggle('active', muted);
  if (channel) channel.track({ userId: user.id, joinedAt, muted });
};
window.addEventListener('pagehide', () => {
  if (channel) channel.untrack();
});

async function rpc(name, params) {
  const { error } = await supabase.rpc(name, { p_room_id: roomId, ...params });
  if (error) {
    toast(friendlyError(error));
    scheduleRefresh();
  }
}

// ---------------------------------------------------------------------------
// Controles do mestre
// ---------------------------------------------------------------------------

function setTarget(target) {
  rpc('set_master_target', { p_target: target });
}

function setupMasterControls() {
  $('zone-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('zone-name').value.trim();
    if (!name) return;
    rpc('create_zone', { p_name: name });
    $('zone-name').value = '';
  });

  $('targets').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-target]');
    if (btn) setTarget(JSON.parse(btn.dataset.target));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.target.closest('input, textarea')) setTarget({ type: 'all' });
  });

  const zonesEl = $('zones');
  zonesEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const zoneId = Number(btn.dataset.zone);
    if (btn.dataset.action === 'narrate') setTarget({ type: 'zone', zoneId });
    if (btn.dataset.action === 'whisper') setTarget({ type: 'player', userId: btn.dataset.user });
    if (btn.dataset.action === 'rename') {
      const name = prompt('Novo nome do ambiente:', zoneById(zoneId).name);
      if (name && name.trim()) rpc('rename_zone', { p_zone_id: zoneId, p_name: name.trim() });
    }
    if (btn.dataset.action === 'delete' && confirm('Excluir este ambiente? Os jogadores nele vão para outro ambiente.')) {
      rpc('archive_zone', { p_zone_id: zoneId });
    }
  });
  zonesEl.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-move]');
    if (sel) rpc('move_player', { p_user_id: sel.dataset.move, p_zone_id: Number(sel.value) });
  });
  zonesEl.addEventListener('input', (e) => {
    const range = e.target.closest('input[data-volume]');
    if (!range) return;
    zoneVolumes[range.dataset.volume] = Number(range.value);
    try {
      localStorage.setItem(VOLUME_KEY, JSON.stringify(zoneVolumes));
    } catch {
      /* armazenamento indisponível: volume vale só nesta aba */
    }
    applyAllRouting();
  });

  // Arrastar e soltar jogadores entre ambientes
  zonesEl.addEventListener('dragstart', (e) => {
    const person = e.target.closest('.person[data-user]');
    if (person) e.dataTransfer.setData('text/plain', person.dataset.user);
  });
  zonesEl.addEventListener('dragover', (e) => {
    const zone = e.target.closest('.zone');
    if (!zone) return;
    e.preventDefault();
    zone.classList.add('drop-hover');
  });
  zonesEl.addEventListener('dragleave', (e) => {
    const zone = e.target.closest('.zone');
    if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove('drop-hover');
  });
  zonesEl.addEventListener('drop', (e) => {
    const zone = e.target.closest('.zone');
    if (!zone) return;
    e.preventDefault();
    zone.classList.remove('drop-hover');
    const userId = e.dataTransfer.getData('text/plain');
    if (userId) rpc('move_player', { p_user_id: userId, p_zone_id: Number(zone.dataset.zone) });
  });
}

// ---------------------------------------------------------------------------
// Sussurro do jogador para o mestre (segurar botão ou tecla V)
// ---------------------------------------------------------------------------

function setupPlayerControls() {
  let whispering = false;
  const setWhisper = (active) => {
    if (active === whispering || !inCall) return;
    whispering = active;
    $('whisper-btn').classList.toggle('holding', active);
    $('whisper-btn').textContent = active ? '🤫 Sussurrando para o mestre…' : '🤫 Segure para sussurrar';
    rpc('set_whisper', { p_active: active });
  };
  const btn = $('whisper-btn');
  btn.addEventListener('pointerdown', (e) => {
    btn.setPointerCapture(e.pointerId);
    setWhisper(true);
  });
  btn.addEventListener('pointerup', () => setWhisper(false));
  btn.addEventListener('pointercancel', () => setWhisper(false));
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'v' || e.key === 'V') && !e.repeat && !e.target.closest('input, textarea')) setWhisper(true);
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'v' || e.key === 'V') setWhisper(false);
  });
  window.addEventListener('blur', () => setWhisper(false));
}

// ---------------------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------------------

function personHtml({ userId, displayName, online: isOnline, muted: isMuted, whisperToMaster, master, zoneId }) {
  const me = userId === user.id;
  const draggable = isMaster && !master;
  const zoneOptions =
    draggable && state.zones.length > 1
      ? `<select data-move="${escapeHtml(userId)}" title="Mover para…">${state.zones
          .map((z) => `<option value="${z.id}" ${z.id === zoneId ? 'selected' : ''}>${escapeHtml(z.name)}</option>`)
          .join('')}</select>`
      : '';
  const whisperBtn =
    isMaster && !master && isOnline
      ? `<button class="small ghost ${isWhisperTarget(userId) ? 'active' : ''}" data-action="whisper" data-user="${escapeHtml(userId)}" title="Falar só com este jogador">🤫</button>`
      : '';
  const sub = master ? (isOnline ? 'Mestre · na call' : 'Mestre · fora da call') : isOnline ? 'Na call' : 'Offline';
  return `
    <div class="person ${isOnline ? '' : 'offline'} ${me ? 'me' : ''} ${speaking.has(userId) ? 'speaking' : ''}"
         data-user="${escapeHtml(userId)}" ${draggable ? 'draggable="true"' : ''}>
      <div class="avatar">${master ? '🧙' : escapeHtml(initials(displayName))}</div>
      <div class="info">
        <div class="name">${escapeHtml(displayName)}${me ? ' <span class="muted">(você)</span>' : ''}</div>
        <div class="sub">${sub}</div>
      </div>
      <div class="badges">
        ${isMuted ? '<span class="badge muted-mic" title="Microfone mudo">🔇</span>' : ''}
        ${whisperToMaster && isOnline ? '<span class="badge whisper">sussurrando</span>' : ''}
      </div>
      ${zoneOptions || whisperBtn ? `<div class="controls">${zoneOptions}${whisperBtn}</div>` : ''}
    </div>`;
}

const isWhisperTarget = (userId) => state.masterTarget && state.masterTarget.type === 'player' && state.masterTarget.userId === userId;
const isZoneTarget = (zoneId) => state.masterTarget && state.masterTarget.type === 'zone' && state.masterTarget.zoneId === zoneId;

function render() {
  if (!state) return;
  const me = playerById(user.id);
  const myZone = me ? me.zoneId : null;

  $('master-row').innerHTML = personHtml({ ...state.master, master: true });

  $('zones').innerHTML = state.zones
    .map((zone) => {
      const members = state.players.filter((p) => p.zoneId === zone.id);
      const vol = typeof zoneVolumes[zone.id] === 'number' ? zoneVolumes[zone.id] : 1;
      return `
      <div class="zone ${zone.id === myZone ? 'mine' : ''} ${isZoneTarget(zone.id) ? 'narrating' : ''}" data-zone="${zone.id}">
        <div class="zone-head">
          <h3 title="${escapeHtml(zone.name)}">${escapeHtml(zone.name)}</h3>
          ${
            isMaster
              ? `<div class="tools">
                  <button class="small ghost" data-action="rename" data-zone="${zone.id}" title="Renomear">✏️</button>
                  ${state.zones.length > 1 ? `<button class="small ghost" data-action="delete" data-zone="${zone.id}" title="Excluir">🗑️</button>` : ''}
                </div>`
              : zone.id === myZone
                ? '<span class="pill">Você está aqui</span>'
                : ''
          }
        </div>
        <div class="zone-players">
          ${members.length ? members.map((p) => personHtml(p)).join('') : '<div class="hint">Ninguém aqui.</div>'}
        </div>
        ${
          isMaster
            ? `<div class="zone-foot">
                <button class="small ${isZoneTarget(zone.id) ? 'active' : ''}" data-action="narrate" data-zone="${zone.id}">📢 Narrar só para este ambiente</button>
                <div class="vol">🔊 <input type="range" min="0" max="1" step="0.05" value="${vol}" data-volume="${zone.id}" title="Quanto você ouve deste ambiente"></div>
              </div>`
            : ''
        }
      </div>`;
    })
    .join('');

  renderTalkStatus(myZone);
  if (isMaster) renderTargets();
  else renderHearing();
}

function renderTalkStatus(myZone) {
  const box = $('talk-status');
  const target = state.masterTarget;
  let label;
  let value;
  let hint = '';
  let whisper = false;

  if (isMaster) {
    label = 'Você está falando com';
    if (!target || target.type === 'all') value = '📣 Todos';
    else if (target.type === 'zone') {
      value = `📢 ${zoneById(target.zoneId).name}`;
      hint = 'Os outros ambientes continuam conversando entre si, sem ouvir você.';
    } else {
      value = `🤫 ${nameOf(target.userId)}`;
      hint = 'Só este jogador ouve você.';
      whisper = true;
    }
  } else {
    label = 'O mestre está falando com';
    const zoneName = myZone != null && zoneById(myZone) ? zoneById(myZone).name : '—';
    if (!state.master.online) value = 'Mestre fora da call';
    else if (!target) {
      value = 'Outro ambiente';
      hint = 'Você não está ouvindo o mestre agora.';
    } else if (target.type === 'all') value = '📣 Todos';
    else if (target.type === 'zone') value = '📢 Seu ambiente';
    else {
      value = '🤫 Você, em particular';
      whisper = true;
    }
    hint = `${hint} Você está em: ${zoneName}.`.trim();
  }
  box.classList.toggle('whisper', whisper);
  $('talk-label').textContent = label;
  $('talk-value').textContent = value;
  $('talk-hint').textContent = hint;
}

function renderTargets() {
  const t = state.masterTarget || { type: 'all' };
  const btn = (target, text, active) =>
    `<button class="small ${active ? 'active' : ''}" data-target='${escapeHtml(JSON.stringify(target))}'>${text}</button>`;
  const onlinePlayers = state.players.filter((p) => p.online);
  $('targets').innerHTML = [
    btn({ type: 'all' }, '📣 Todos', t.type === 'all'),
    '<div class="target-group">Ambientes</div>',
    ...state.zones.map((z) => {
      const count = onlinePlayers.filter((p) => p.zoneId === z.id).length;
      return btn({ type: 'zone', zoneId: z.id }, `📢 ${escapeHtml(z.name)} <span class="muted">(${count})</span>`, isZoneTarget(z.id));
    }),
    '<div class="target-group">Sussurro</div>',
    ...(onlinePlayers.length
      ? onlinePlayers.map((p) => btn({ type: 'player', userId: p.userId }, `🤫 ${escapeHtml(p.displayName)}`, isWhisperTarget(p.userId)))
      : ['<div class="hint">Nenhum jogador online.</div>']),
  ].join('');
}

function renderHearing() {
  const names = routing().hearFrom.map(nameOf);
  $('hearing').textContent = names.length ? names.join(', ') : inCall ? 'Ninguém no momento.' : '—';
}

// ---------------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------------

try {
  db = await loadData();
} catch (err) {
  console.error(err);
}
if (!db) {
  showOverlay('Sala indisponível', 'Sala não encontrada ou você não faz parte dela.', 'Voltar ao painel', () => location.replace('/painel'));
} else {
  isMaster = db.room.master_id === user.id;
  document.title = `${db.room.name} — Sistema RPG`;
  $('room-name').textContent = db.room.name;
  const inviteCode = db.room.room_invites && db.room.room_invites.code;
  if (isMaster && inviteCode) {
    $('invite').classList.remove('hidden');
    $('invite-code').textContent = inviteCode;
    $('invite').title = 'Clique para copiar';
    $('invite').style.cursor = 'pointer';
    $('invite').onclick = () => navigator.clipboard.writeText(inviteCode).then(() => toast('Código copiado!'));
  }
  $(isMaster ? 'master-panel' : 'player-panel').classList.remove('hidden');
  if (isMaster) setupMasterControls();
  else setupPlayerControls();
  $('join-btn').onclick = startCall;
  recompute();
}
