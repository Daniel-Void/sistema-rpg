import { api, currentUser, escapeHtml, initials, toast } from './api.js';

const roomId = Number(location.pathname.split('/').filter(Boolean).pop());
const $ = (id) => document.getElementById(id);

const user = await currentUser();
if (!user) location.replace(`/?next=${encodeURIComponent(location.pathname)}`);

let roomInfo;
try {
  roomInfo = await api(`/rooms/${roomId}`);
} catch (err) {
  $('overlay-title').textContent = 'Sala indisponível';
  $('overlay-text').textContent = err.message;
  $('join-btn').textContent = 'Voltar ao painel';
  $('join-btn').onclick = () => location.replace('/painel');
  throw err;
}
const { iceServers } = await api('/config');

const isMaster = roomInfo.isMaster;
document.title = `${roomInfo.room.name} — Sistema RPG`;
$('room-name').textContent = roomInfo.room.name;
if (isMaster) {
  $('invite').classList.remove('hidden');
  $('invite-code').textContent = roomInfo.room.inviteCode;
  $('invite').title = 'Clique para copiar';
  $('invite').style.cursor = 'pointer';
  $('invite').onclick = () => navigator.clipboard.writeText(roomInfo.room.inviteCode).then(() => toast('Código copiado!'));
}
$(isMaster ? 'master-panel' : 'player-panel').classList.remove('hidden');

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

let socket = null;
let localStream = null;
let micTrack = null;
let audioCtx = null;
let muted = false;
let state = null; // último 'state' recebido do servidor
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

const emptyRouting = { sendTo: [], hearFrom: [] };
const routing = () => (state && state.routing) || emptyRouting;
const playerById = (id) => state && state.players.find((p) => p.userId === id);
const zoneById = (id) => state && state.zones.find((z) => z.id === id);
function nameOf(id) {
  if (state && state.master && state.master.userId === id) return `${state.master.displayName} (mestre)`;
  const p = playerById(id);
  return p ? p.displayName : 'Alguém';
}
/** Ambiente efetivo do jogador (sem ambiente cai no primeiro). */
const zoneOf = (p) => (zoneById(p.zoneId) ? p.zoneId : state.zones[0] && state.zones[0].id);

// ---------------------------------------------------------------------------
// WebRTC (malha P2P com "perfect negotiation")
// ---------------------------------------------------------------------------

function send(to, data) {
  socket.emit('signal', { to, data });
}

function createPeer(peerId, initiator) {
  const pc = new RTCPeerConnection({ iceServers });
  const audio = new Audio();
  audio.autoplay = true;
  const peer = { id: peerId, pc, audio, polite: !initiator, makingOffer: false, ignoreOffer: false, transceiver: null, queue: Promise.resolve() };
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
  pc.onicecandidate = ({ candidate }) => candidate && send(peerId, { candidate });
  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      send(peerId, { description: pc.localDescription });
    } catch (err) {
      console.error('negotiation', err);
    } finally {
      peer.makingOffer = false;
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') pc.restartIce();
    updateConnStatus();
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
  updateConnStatus();
}

function closeAllPeers() {
  for (const id of [...peers.keys()]) closePeer(id);
}

function handleSignal({ from, data }) {
  const peer = peers.get(from) || createPeer(from, false);
  // Processa os sinais de cada peer em ordem, um de cada vez.
  peer.queue = peer.queue.then(async () => {
    const { pc } = peer;
    try {
      if (data.description) {
        const collision = data.description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          const t = pc.getTransceivers().find((tr) => tr.receiver.track.kind === 'audio');
          if (t) {
            peer.transceiver = t;
            t.direction = 'sendrecv';
          }
          await applyPeerRouting(peer);
          await pc.setLocalDescription();
          send(from, { description: pc.localDescription });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (!peer.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.error('signal', err);
    }
  });
}

/**
 * Aplica as regras de áudio a uma conexão:
 *  - só ENVIA o microfone se o servidor disse que esse peer pode nos ouvir;
 *  - só TOCA o áudio recebido se o servidor disse que podemos ouvir esse peer.
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
  const v = zoneVolumes[zoneOf(p)];
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
    document.querySelectorAll('.person[data-user]').forEach((el) => el.classList.toggle('speaking', speaking.has(Number(el.dataset.user))));
  }
}, 120);

// ---------------------------------------------------------------------------
// Socket / ciclo da call
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
  $('join-overlay').classList.add('hidden');
  $('mute-btn').disabled = false;

  socket = io();
  socket.on('connect', () => {
    closeAllPeers();
    socket.emit('join', { roomId }, (res) => {
      if (res.error) return showOverlay('Não foi possível entrar', res.error);
      for (const peerId of res.peers) createPeer(peerId, true);
      if (muted) socket.emit('mute', { muted: true });
      updateConnStatus();
    });
  });
  socket.on('disconnect', () => {
    closeAllPeers();
    updateConnStatus();
  });
  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') location.replace(`/?next=${encodeURIComponent(location.pathname)}`);
  });
  socket.on('peer-joined', ({ userId }) => closePeer(userId)); // quem entrou inicia a conexão
  socket.on('peer-left', ({ userId }) => closePeer(userId));
  socket.on('signal', handleSignal);
  socket.on('state', (msg) => {
    state = msg;
    render();
    applyAllRouting();
  });
  socket.on('kicked', ({ reason }) => {
    stopCall();
    showOverlay('Você saiu da call', reason, 'Voltar ao painel', () => location.replace('/painel'));
  });
}

function stopCall() {
  if (socket) {
    socket.off();
    socket.disconnect();
    socket = null;
  }
  closeAllPeers();
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close();
  analysers.clear();
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

function updateConnStatus() {
  const el = $('conn-status');
  if (!socket || !socket.connected) {
    el.textContent = '● Desconectado';
    el.style.color = 'var(--danger)';
    return;
  }
  const total = peers.size;
  const connected = [...peers.values()].filter((p) => p.pc.connectionState === 'connected').length;
  el.textContent = total ? `● ${connected}/${total} conectados` : '● Na call';
  el.style.color = connected === total ? 'var(--ok)' : 'var(--accent)';
}

$('join-btn').onclick = startCall;
$('leave-btn').onclick = () => {
  stopCall();
  location.href = '/painel';
};
$('mute-btn').onclick = () => {
  muted = !muted;
  if (micTrack) micTrack.enabled = !muted;
  $('mute-btn').textContent = muted ? '🔇 Microfone mudo' : '🎙️ Microfone ligado';
  $('mute-btn').classList.toggle('active', muted);
  if (socket) socket.emit('mute', { muted });
};

// ---------------------------------------------------------------------------
// Controles do mestre
// ---------------------------------------------------------------------------

function setTarget(target) {
  socket && socket.emit('master:target', { target });
}

if (isMaster) {
  $('zone-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('zone-name').value.trim();
    if (!name || !socket) return;
    socket.emit('zone:create', { name });
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
    if (!btn || !socket) return;
    const zoneId = Number(btn.dataset.zone);
    if (btn.dataset.action === 'narrate') setTarget({ type: 'zone', zoneId });
    if (btn.dataset.action === 'whisper') setTarget({ type: 'player', userId: Number(btn.dataset.user) });
    if (btn.dataset.action === 'rename') {
      const name = prompt('Novo nome do ambiente:', zoneById(zoneId).name);
      if (name && name.trim()) socket.emit('zone:rename', { zoneId, name });
    }
    if (btn.dataset.action === 'delete' && confirm('Excluir este ambiente? Os jogadores nele vão para outro ambiente.')) {
      socket.emit('zone:delete', { zoneId });
    }
  });
  zonesEl.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-move]');
    if (sel && socket) socket.emit('master:move', { userId: Number(sel.dataset.move), zoneId: Number(sel.value) });
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
    const userId = Number(e.dataTransfer.getData('text/plain'));
    if (userId && socket) socket.emit('master:move', { userId, zoneId: Number(zone.dataset.zone) });
  });
}

// ---------------------------------------------------------------------------
// Sussurro do jogador para o mestre (segurar botão ou tecla V)
// ---------------------------------------------------------------------------

if (!isMaster) {
  let whispering = false;
  const setWhisper = (active) => {
    if (active === whispering || !socket) return;
    whispering = active;
    $('whisper-btn').classList.toggle('holding', active);
    $('whisper-btn').textContent = active ? '🤫 Sussurrando para o mestre…' : '🤫 Segure para sussurrar';
    socket.emit('player:whisper', { active });
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

function personHtml({ userId, displayName, online, muted: isMuted, whisperToMaster, master, zoneId }) {
  const me = userId === user.id;
  const draggable = isMaster && !master;
  const zoneOptions =
    draggable && state.zones.length > 1
      ? `<select data-move="${userId}" title="Mover para…">${state.zones
          .map((z) => `<option value="${z.id}" ${z.id === zoneId ? 'selected' : ''}>${escapeHtml(z.name)}</option>`)
          .join('')}</select>`
      : '';
  const whisperBtn =
    isMaster && !master && online
      ? `<button class="small ghost ${isWhisperTarget(userId) ? 'active' : ''}" data-action="whisper" data-user="${userId}" title="Falar só com este jogador">🤫</button>`
      : '';
  return `
    <div class="person ${online ? '' : 'offline'} ${me ? 'me' : ''} ${speaking.has(userId) ? 'speaking' : ''}"
         data-user="${userId}" ${draggable ? 'draggable="true"' : ''}>
      <div class="avatar">${master ? '🧙' : escapeHtml(initials(displayName))}</div>
      <div class="info">
        <div class="name">${escapeHtml(displayName)}${me ? ' <span class="muted">(você)</span>' : ''}</div>
        <div class="sub">${master ? 'Mestre' : online ? 'Na call' : 'Offline'}</div>
      </div>
      <div class="badges">
        ${isMuted ? '<span class="badge muted-mic" title="Microfone mudo">🔇</span>' : ''}
        ${whisperToMaster ? '<span class="badge whisper">sussurrando</span>' : ''}
      </div>
      ${zoneOptions || whisperBtn ? `<div class="controls">${zoneOptions}${whisperBtn}</div>` : ''}
    </div>`;
}

const isWhisperTarget = (userId) => state.masterTarget && state.masterTarget.type === 'player' && state.masterTarget.userId === userId;
const isZoneTarget = (zoneId) => state.masterTarget && state.masterTarget.type === 'zone' && state.masterTarget.zoneId === zoneId;

function render() {
  if (!state) return;
  const me = playerById(user.id);
  const myZone = me ? zoneOf(me) : null;

  $('master-row').innerHTML = state.master
    ? personHtml({ ...state.master, online: true, master: true })
    : '<div class="person offline"><div class="avatar">🧙</div><div class="info"><div class="name">Mestre</div><div class="sub">Ainda não entrou na call</div></div></div>';

  $('zones').innerHTML = state.zones
    .map((zone) => {
      const members = state.players.filter((p) => zoneOf(p) === zone.id);
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

  renderTalkStatus(me, myZone);
  if (isMaster) renderTargets();
  else renderHearing();
}

function renderTalkStatus(me, myZone) {
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
    const zoneName = myZone ? zoneById(myZone).name : '—';
    if (!state.master) value = 'Mestre fora da call';
    else if (!target) {
      value = 'Outro ambiente';
      hint = 'Você não está ouvindo o mestre agora.';
    } else if (target.type === 'all') value = '📣 Todos';
    else if (target.type === 'zone') value = `📢 Seu ambiente`;
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
  const online = state.players.filter((p) => p.online);
  $('targets').innerHTML = [
    btn({ type: 'all' }, '📣 Todos', t.type === 'all'),
    '<div class="target-group">Ambientes</div>',
    ...state.zones.map((z) => {
      const count = online.filter((p) => zoneOf(p) === z.id).length;
      return btn({ type: 'zone', zoneId: z.id }, `📢 ${escapeHtml(z.name)} <span class="muted">(${count})</span>`, isZoneTarget(z.id));
    }),
    '<div class="target-group">Sussurro</div>',
    ...(online.length
      ? online.map((p) => btn({ type: 'player', userId: p.userId }, `🤫 ${escapeHtml(p.displayName)}`, isWhisperTarget(p.userId)))
      : ['<div class="hint">Nenhum jogador online.</div>']),
  ].join('');
}

function renderHearing() {
  const names = routing().hearFrom.map(nameOf);
  $('hearing').textContent = names.length ? names.join(', ') : 'Ninguém no momento.';
}
