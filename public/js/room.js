import { supabase, currentUser, escapeHtml, friendlyError, initials, toast } from './supabase.js';
import { ICE_SERVERS } from './config.js';

// Servidores STUN/TURN; trocados pelos da Vercel (/api/ice) ao entrar na call.
let iceServers = ICE_SERVERS;
import { computeRouting, normalizeMasterTarget } from './audioRules.js';
import { effectiveScene, parseYouTube, targetIncludes } from './sceneRules.js';
import { formatTime, trackEnded, trackPosition, tracksForDest, tracksForZone } from './musicRules.js';
import { hydrateIcons, icon } from './icons.js';
import { describeDice, diceRange, parseDice } from './dice.js';

hydrateIcons();

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

let db = null; // { room, zones, members, media } vindo do banco
let online = new Map(); // userId -> { sessionId, joinedAt, muted, sharing, shareTarget }
let state = null; // visão calculada para renderizar e rotear
let channel = null;
let inCall = false;
let localStream = null;
let micTrack = null;
let screenTrack = null;
let screenAudioTrack = null; // áudio da aba/tela compartilhada (opcional)
let shareTarget = { type: 'all' };
let audioCtx = null;
let muted = false;
let isMaster = false;
const peers = new Map(); // userId -> peer
const analysers = new Map(); // userId -> AnalyserNode
const speaking = new Set();
const mediaUrls = new Map(); // mediaId -> { url, signedAt }
const activeSfx = new Set();

function readStored(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}
function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* armazenamento indisponível: vale só nesta aba */
  }
}
const zoneVolumes = readStored(`rpg-volumes-${roomId}`, {});
let playerSceneVolume = readStored('rpg-scene-volume', 1);

const emptyRouting = { sendTo: [], hearFrom: [] };
const routing = () => (state && state.routing) || emptyRouting;
const playerById = (id) => state && state.players.find((p) => p.userId === id);
const zoneById = (id) => state && state.zones.find((z) => z.id === id);
const mediaById = (id) => db && db.media.find((m) => m.id === id);
const mediaUrl = (id) => (mediaUrls.get(id) || {}).url || null;
function nameOf(id) {
  if (state && state.master && state.master.userId === id) return `${state.master.displayName} (mestre)`;
  const p = playerById(id);
  return p ? p.displayName : 'Alguém';
}
const myZoneId = () => (playerById(user.id) || {}).zoneId ?? null;

// ---------------------------------------------------------------------------
// Dados do banco
// ---------------------------------------------------------------------------

const SCENE_COLS = 'scene_media_id, ambient_youtube, scene_caption, ambient_volume';
const TRACK_COLS = 'id, zone_id, title, youtube, position, volume, loop, chain, status, offset_s, started_at, duration_s';

async function loadData() {
  const [roomRes, zonesRes, membersRes, mediaRes, tracksRes] = await Promise.all([
    supabase
      .from('rooms')
      // '*' para funcionar antes e depois da migração 17 (expires_at)
      .select('*, master:profiles!rooms_master_id_fkey(display_name), room_invites(code)')
      .eq('id', roomId)
      .maybeSingle(),
    supabase.from('zones').select(`id, name, position, ${SCENE_COLS}`).eq('room_id', roomId).eq('archived', false).order('position').order('id'),
    supabase.from('room_members').select('*, profile:profiles(display_name)').eq('room_id', roomId),
    supabase.from('room_media').select('id, kind, name, storage_path, created_at').eq('room_id', roomId).order('created_at'),
    supabase.from('music_tracks').select(TRACK_COLS).eq('room_id', roomId).eq('archived', false).order('position'),
  ]);
  const error = roomRes.error || zonesRes.error || membersRes.error || mediaRes.error || tracksRes.error;
  if (error) throw error;
  if (!roomRes.data) return null;
  await signMediaUrls(mediaRes.data);
  return { room: roomRes.data, zones: zonesRes.data, members: membersRes.data, media: mediaRes.data, tracks: tracksRes.data };
}

/** Gera links temporários (6h) para os arquivos da biblioteca que ainda não têm. */
async function signMediaUrls(media) {
  const stale = Date.now() - 5 * 3600 * 1000;
  const missing = media.filter((m) => !mediaUrls.has(m.id) || mediaUrls.get(m.id).signedAt < stale);
  if (!missing.length) return;
  const { data, error } = await supabase.storage.from('midia').createSignedUrls(missing.map((m) => m.storage_path), 6 * 3600);
  if (error) return console.error('signed urls', error);
  for (const item of data) {
    const m = missing.find((x) => x.storage_path === item.path);
    if (m && item.signedUrl) mediaUrls.set(m.id, { url: item.signedUrl, signedAt: Date.now() });
  }
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
        whisperRequested: m.whisper_requested,
        mutedByMaster: Boolean(m.muted_by_master),
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt-BR'));

  const masterTarget = normalizeMasterTarget(db.room.master_target, { zoneIds, playerIds: players.map((p) => p.userId) });

  const participants = new Map();
  if (masterOnline) participants.set(masterId, { role: 'mestre', zoneId: null });
  for (const p of players) if (p.online) participants.set(p.userId, { role: 'jogador', zoneId: p.zoneId, whisperToMaster: p.whisperToMaster });

  const allRouting = computeRouting({ participants, masterTarget });
  // Jogador silenciado pelo mestre: não envia voz e ninguém o ouve
  for (const p of players) {
    if (!p.mutedByMaster) continue;
    if (allRouting[p.userId]) allRouting[p.userId] = { ...allRouting[p.userId], sendTo: [] };
    for (const id of Object.keys(allRouting)) {
      allRouting[id] = { ...allRouting[id], hearFrom: allRouting[id].hearFrom.filter((x) => x !== p.userId) };
    }
  }
  const myRouting = allRouting[user.id] || emptyRouting;
  const masterSpeaksToMe = Boolean(masterOnline && allRouting[masterId] && allRouting[masterId].sendTo.includes(user.id));

  if (shareTarget.type === 'zone' && !zoneIds.includes(shareTarget.zoneId)) shareTarget = { type: 'all' };

  state = {
    zones,
    players,
    master: {
      userId: masterId,
      displayName: (db.room.master && db.room.master.display_name) || 'Mestre',
      online: Boolean(masterOnline),
      muted: masterOnline ? masterOnline.muted : false,
    },
    // Para jogadores, o alvo do mestre só aparece quando inclui eles.
    masterTarget: isMaster || masterSpeaksToMe ? masterTarget : null,
    routing: inCall ? myRouting : emptyRouting,
  };

  render();
  updateStage();
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
// Realtime: presença + mudanças no banco + sinalização + efeitos sonoros
// ---------------------------------------------------------------------------

/**
 * Conecta ao canal da sala. Se a rede cair, o cliente do Supabase reconecta sozinho
 * e avisa de novo com SUBSCRIBED; aí refazemos a presença e recarregamos o estado.
 * O canal nunca é recriado (o cliente reaproveita canais pelo nome).
 */
function connectRealtime(firstTimeout = 25000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ch = supabase.channel(`room:${roomId}`, { config: { private: true, presence: { key: sessionId } } });
    channel = ch;
    const failTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('timeout'));
    }, firstTimeout);
    const onChange = () => scheduleRefresh();
    channel
      // Atualizações frequentes (alvo do mestre, mover jogador, sussurro) são aplicadas na hora, sem recarregar.
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` }, ({ new: row }) => {
        if (db && row) Object.assign(db.room, pick(row, ['master_target', 'scene_media_id', 'ambient_youtube', 'scene_caption', 'ambient_volume', 'name']));
        recompute();
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'room_members', filter: `room_id=eq.${roomId}` }, ({ new: row }) => {
        const member = db && row && db.members.find((m) => m.user_id === row.user_id);
        if (!member) return onChange();
        const newRequest = row.whisper_requested && !member.whisper_requested;
        member.zone_id = row.zone_id;
        member.whisper_to_master = row.whisper_to_master;
        member.whisper_requested = row.whisper_requested;
        member.muted_by_master = row.muted_by_master;
        if (isMaster && newRequest) toast(`${(member.profile && member.profile.display_name) || 'Um jogador'} pediu para falar em particular.`, 6000);
        recompute();
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_members', filter: `room_id=eq.${roomId}` }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'zones', filter: `room_id=eq.${roomId}` }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'room_media', filter: `room_id=eq.${roomId}` }, onChange)
      // Exclusões não aceitam filtro: qualquer exclusão nessas tabelas faz recarregar.
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'room_members' }, onChange)
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'rooms' }, onChange)
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'room_media' }, onChange)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'signals', filter: `to_user=eq.${user.id}` }, ({ new: row }) => onSignalRow(row))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'signals', filter: `to_user=eq.${user.id}` }, ({ new: row }) => onSignalRow(row))
      .on('broadcast', { event: 'sfx' }, ({ payload }) => onSfx(payload))
      .on('broadcast', { event: 'sfx-stop' }, () => stopAllSfx())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dice_rolls', filter: `room_id=eq.${roomId}` }, () => scheduleRolls())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'music_tracks', filter: `room_id=eq.${roomId}` }, () => scheduleTracks())
      .on('presence', { event: 'sync' }, onPresenceSync)
      .subscribe(async (status, err) => {
        if (ch !== channel) return;
        if (status === 'SUBSCRIBED') {
          await trackPresence();
          scheduleRefresh(); // pega qualquer mudança que aconteceu enquanto estava desconectado
          scheduleRolls();
          if (!settled) {
            settled = true;
            clearTimeout(failTimer);
            resolve();
          }
        } else {
          if (err) console.warn('realtime', status, err.message);
          updateConnStatus(false);
        }
      });
  });
}

// Conferência periódica: se algum aviso em tempo real se perder, o estado se corrige sozinho.
let safetyTicks = 0;
setInterval(() => {
  if (!inCall) return;
  safetyTicks += 1;
  scheduleRolls();
  reconcilePeers();
  if (safetyTicks % 6 === 0) scheduleRefresh();
}, 5000);

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

function trackPresence() {
  if (!channel) return Promise.resolve();
  return channel.track({ userId: user.id, joinedAt, muted, sharing: Boolean(screenTrack), shareTarget });
}

function onPresenceSync() {
  // presenceState(): { <sessionId da aba>: [{ userId, joinedAt, muted, sharing, shareTarget }] }
  const next = new Map();
  for (const [key, metas] of Object.entries(channel.presenceState())) {
    for (const m of metas) {
      if (!m.userId) continue;
      const entry = { sessionId: key, joinedAt: m.joinedAt || 0, muted: Boolean(m.muted), sharing: Boolean(m.sharing), shareTarget: m.shareTarget || null };
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
// Cada conexão tem um canal de áudio (voz) e um de vídeo (tela do mestre).
// ---------------------------------------------------------------------------

// Numeração sempre crescente das mensagens desta aba, mesmo se a conexão for recriada
let signalSeq = Date.now();

async function sendSignal(peer, data) {
  signalSeq += 1;
  peer.seq = signalSeq;
  const { error } = await supabase.from('signals').upsert(
    { room_id: roomId, from_session: sessionId, to_user: peer.id, to_session: peer.sessionId, payload: { ...data, seq: peer.seq } },
    { onConflict: 'from_session,to_session' },
  );
  if (error) console.error('signal', error);
}

/** Espera o navegador reunir os candidatos de rede, para mandar tudo numa mensagem só. */
function waitForIce(pc, timeout = 2500, maxWait = 10000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  const start = Date.now();
  const hasCandidate = () => /\ba=candidate:/.test((pc.localDescription && pc.localDescription.sdp) || '');
  return new Promise((resolve) => {
    let timer;
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    // Sem nenhum caminho de rede na descrição a conexão não fecha; espera mais.
    const tick = () => {
      if (hasCandidate() || Date.now() - start >= maxWait) done();
      else timer = setTimeout(tick, 250);
    };
    timer = setTimeout(tick, timeout);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

async function sendDescription(peer) {
  await waitForIce(peer.pc);
  await sendSignal(peer, { description: peer.pc.localDescription.toJSON() });
}

// O navegador (principalmente no celular) pode bloquear o som que chega sem um
// toque recente. Nesse caso mostramos um aviso e tentamos de novo no próximo toque.
const blockedAudio = new Set();
function playRemote(el) {
  el.play().then(
    () => {
      blockedAudio.delete(el);
      renderAudioUnlock();
    },
    (err) => {
      if (err && err.name === 'NotAllowedError') {
        blockedAudio.add(el);
        renderAudioUnlock();
      }
    },
  );
}
function unlockAudio() {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  for (const el of [...blockedAudio]) playRemote(el);
}
function renderAudioUnlock() {
  $('audio-unlock').classList.toggle('hidden', !inCall || blockedAudio.size === 0);
}
$('audio-unlock').onclick = unlockAudio;

async function loadIceServers() {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session && data.session.access_token;
    const res = await fetch('/api/ice', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) return;
    const body = await res.json();
    if (Array.isArray(body.iceServers) && body.iceServers.length) iceServers = body.iceServers;
    if (!body.turn) console.warn('call sem TURN: jogadores em 4G ou redes restritas podem não se conectar');
  } catch (err) {
    console.warn('ice', err);
  }
}

function createPeer(peerId, peerSession, initiator) {
  const pc = new RTCPeerConnection({ iceServers });
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
    audioTx: null, // voz (microfone)
    videoTx: null, // tela compartilhada
    screenAudioTx: null, // áudio da tela compartilhada
    videoTrack: null,
    screenAudio: null,
    seq: 0,
    lastSeq: 0,
    queue: Promise.resolve(),
  };
  peers.set(peerId, peer);

  if (initiator) {
    // A ordem importa: 0 = voz, 1 = vídeo da tela, 2 = áudio da tela
    peer.audioTx = pc.addTransceiver('audio', { direction: 'sendrecv' });
    peer.videoTx = pc.addTransceiver('video', { direction: 'sendrecv' });
    peer.screenAudioTx = pc.addTransceiver('audio', { direction: 'sendrecv' });
  }

  pc.ontrack = ({ track, transceiver }) => {
    const index = pc.getTransceivers().indexOf(transceiver);
    if (track.kind === 'audio' && index === 2) {
      peer.screenAudioTx = peer.screenAudioTx || transceiver;
      peer.screenAudio = peer.screenAudio || new Audio();
      peer.screenAudio.autoplay = true;
      peer.screenAudio.srcObject = new MediaStream([track]);
      peer.screenAudio.volume = Math.min(1, playerSceneVolume);
      playRemote(peer.screenAudio);
      return;
    }
    if (track.kind === 'video') {
      peer.videoTx = peer.videoTx || transceiver;
      peer.videoTrack = track;
      track.onunmute = updateStage;
      track.onmute = updateStage;
      updateStage();
      return;
    }
    peer.audioTx = peer.audioTx || transceiver;
    const stream = new MediaStream([track]);
    audio.srcObject = stream;
    playRemote(audio);
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
    if (pc.connectionState === 'failed') {
      peer.failedSince = peer.failedSince || Date.now();
      pc.restartIce();
    } else {
      peer.failedSince = null;
    }
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
  if (peer.screenAudio) peer.screenAudio.srcObject = null;
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

/**
 * Abre/fecha conexões conforme quem está na call. Quem entrou por último inicia.
 * Se alguém some da presença por um instante (queda do canal de tempo real), a
 * conexão de voz/vídeo continua: só fechamos depois de 15s sumido ou se ela falhar.
 */
const PRESENCE_GRACE_MS = 15000;
function reconcilePeers() {
  const now = Date.now();
  for (const [peerId, peer] of peers) {
    const presence = online.get(peerId);
    const dead = peer.pc.connectionState === 'closed' || (peer.failedSince && now - peer.failedSince > PRESENCE_GRACE_MS);
    if (!isParticipant(peerId) || (presence && presence.sessionId !== peer.sessionId) || dead) {
      closePeer(peerId);
    } else if (!presence) {
      peer.missingSince = peer.missingSince || now;
      if (now - peer.missingSince > PRESENCE_GRACE_MS) closePeer(peerId);
    } else {
      peer.missingSince = null;
    }
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
  peer.queue = peer.queue
    .then(() => handleDescription(peer, data.description))
    .catch((err) => {
      console.error('signal', err);
      // O outro lado recriou a conexão (oferta nova que não encaixa na antiga): começa do zero
      if (data.description && data.description.type === 'offer' && peers.get(row.from_user) === peer) {
        closePeer(row.from_user);
        const fresh = createPeer(row.from_user, row.from_session, false);
        fresh.lastSeq = data.seq || 0;
        fresh.queue = fresh.queue.then(() => handleDescription(fresh, data.description)).catch((e) => console.error('signal', e));
      }
    });
}

async function handleDescription(peer, description) {
  if (!description) return;
  const { pc } = peer;
  const collision = description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
  peer.ignoreOffer = !peer.polite && collision;
  if (peer.ignoreOffer) return;
  await pc.setRemoteDescription(description);
  if (description.type === 'offer') {
    const ts = pc.getTransceivers();
    peer.audioTx = peer.audioTx || ts[0] || null;
    peer.videoTx = peer.videoTx || ts[1] || null;
    peer.screenAudioTx = peer.screenAudioTx || ts[2] || null;
    for (const t of ts) t.direction = 'sendrecv';
    await applyPeerRouting(peer);
    await pc.setLocalDescription();
    await sendDescription(peer);
  }
}

/** Para quem a tela do mestre vai (todos os jogadores ou só um ambiente). */
function shareIncludes(peerId) {
  const p = playerById(peerId);
  return Boolean(p) && targetIncludes(shareTarget, { userId: peerId, zoneId: p.zoneId });
}

/**
 * Aplica as regras a uma conexão:
 *  - só ENVIA o microfone se as regras dizem que esse peer pode nos ouvir;
 *  - só TOCA o áudio recebido se as regras dizem que podemos ouvir esse peer;
 *  - (mestre) só envia a tela para quem está no alvo do compartilhamento.
 */
async function applyPeerRouting(peer) {
  const r = routing();
  const replace = async (sender, track) => {
    if (!sender || sender.track === track) return;
    try {
      await sender.replaceTrack(track);
    } catch (err) {
      console.error('replaceTrack', err);
    }
  };
  await replace(peer.audioTx && peer.audioTx.sender, r.sendTo.includes(peer.id) ? micTrack : null);
  const sharing = isMaster && screenTrack && shareIncludes(peer.id);
  await replace(peer.videoTx && peer.videoTx.sender, sharing ? screenTrack : null);
  if (sharing) tuneScreenSender(peer);
  await replace(peer.screenAudioTx && peer.screenAudioTx.sender, sharing && screenAudioTrack ? screenAudioTrack : null);
  if (peer.screenAudio) peer.screenAudio.volume = Math.min(1, playerSceneVolume);
  peer.audio.muted = !r.hearFrom.includes(peer.id);
  peer.audio.volume = volumeFor(peer.id);
}

/** Pede ao navegador para manter a resolução da tela (mapas e textos legíveis). */
function tuneScreenSender(peer) {
  const sender = peer.videoTx && peer.videoTx.sender;
  if (!sender || peer.screenTunedFor === screenTrack) return;
  peer.screenTunedFor = screenTrack;
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) return; // ainda não negociado
    params.encodings[0].maxBitrate = 3_000_000;
    params.encodings[0].maxFramerate = 24;
    sender.setParameters(params).catch((err) => console.warn('screen params', err));
  } catch (err) {
    console.warn('screen params', err);
  }
}

// Volume de cada pessoa, escolhido por quem ouve (fica salvo neste aparelho)
const personVolumes = readStored('rpg-person-volumes', {});
function personVolume(userId) {
  const v = personVolumes[userId];
  return typeof v === 'number' ? v : 1;
}

function volumeFor(userId) {
  let vol = personVolume(userId);
  if (!isMaster || !state) return vol;
  const p = playerById(userId);
  if (!p) return vol;
  const v = zoneVolumes[p.zoneId];
  return typeof v === 'number' ? vol * v : vol;
}

document.addEventListener('input', (e) => {
  const input = e.target.closest && e.target.closest('input[data-pvol]');
  if (!input) return;
  personVolumes[input.dataset.pvol] = Number(input.value);
  store('rpg-person-volumes', personVolumes);
  applyAllRouting();
});

function applyAllRouting() {
  for (const peer of peers.values()) applyPeerRouting(peer);
}

// ---------------------------------------------------------------------------
// Compartilhamento de tela (mestre)
// ---------------------------------------------------------------------------

const canShareScreen = Boolean(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

async function startShare() {
  if (!canShareScreen) {
    toast('Este navegador não permite compartilhar a tela (celulares não suportam). Use Chrome, Edge ou Firefox no computador.', 7000);
    return;
  }
  if (!inCall) return toast('Entre na call para compartilhar a tela.');
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 24, max: 30 } },
      audio: true, // no Chrome/Edge, marque "Compartilhar áudio da aba" para enviar o som
      selfBrowserSurface: 'exclude', // não oferece a própria aba do site (evita o efeito espelho)
      surfaceSwitching: 'include',
      systemAudio: 'include',
    });
    screenTrack = stream.getVideoTracks()[0];
    screenAudioTrack = stream.getAudioTracks()[0] || null;
    screenTrack.contentHint = 'detail';
    screenTrack.onended = stopShare;
  } catch (err) {
    if (err && err.name === 'NotAllowedError') return; // cancelou a escolha
    console.error('share', err);
    toast('Não foi possível compartilhar a tela. Verifique a permissão do navegador.', 6000);
    return;
  }
  if (!screenAudioTrack) toast('Tela compartilhada sem som. Para enviar o som, compartilhe uma aba e marque "Compartilhar áudio".', 7000);
  await trackPresence();
  applyAllRouting();
  renderShareControls();
  updateStage();
}

async function stopShare() {
  if (screenTrack) {
    screenTrack.onended = null;
    screenTrack.stop();
  }
  if (screenAudioTrack) screenAudioTrack.stop();
  screenTrack = null;
  screenAudioTrack = null;
  await trackPresence();
  applyAllRouting();
  renderShareControls();
  updateStage();
}

// ---------------------------------------------------------------------------
// Palco (tela compartilhada) e ambiente imersivo (fundo da página + música)
// ---------------------------------------------------------------------------

let stageKey = 'none';

function targetName(target) {
  if (!target || target.type === 'all') return 'todos';
  if (target.type === 'zone') return (zoneById(target.zoneId) || {}).name || 'ambiente';
  return nameOf(target.userId);
}

function updateStage() {
  if (!state) return;
  const stage = $('stage');
  const mediaBox = $('stage-media');
  let key = 'none';
  let label = '';
  let build = null;

  const masterPresence = online.get(state.master.userId);
  const masterPeer = peers.get(state.master.userId);
  const me = { userId: user.id, zoneId: myZoneId() };

  if (isMaster && screenTrack) {
    key = `preview:${screenTrack.id}`;
    label = `Você está compartilhando a tela${screenAudioTrack ? ' com som' : ''} com ${targetName(shareTarget)}`;
    build = () => videoEl(new MediaStream([screenTrack]), 'screen');
  } else if (!isMaster && inCall && masterPresence && masterPresence.sharing && masterPeer && masterPeer.videoTrack && !masterPeer.videoTrack.muted && targetIncludes(masterPresence.shareTarget, me)) {
    key = `screen:${masterPeer.videoTrack.id}`;
    label = 'Tela do mestre';
    build = () => videoEl(new MediaStream([masterPeer.videoTrack]), 'screen');
  }
  if (!isMaster) {
    const zoneRow = db.zones.find((z) => z.id === me.zoneId);
    updateEnvironment(effectiveScene(db.room, zoneRow), zoneRow);
  }

  stage.classList.toggle('hidden', key === 'none');
  $('stage-caption').textContent = '';
  $('stage-label').textContent = label;
  $('stage-label').classList.toggle('hidden', !label);
  if (key !== stageKey) {
    stageKey = key;
    mediaBox.replaceChildren();
    if (build) mediaBox.appendChild(build());
  }
}

function videoEl(src, kind) {
  const v = document.createElement('video');
  v.autoplay = true;
  v.playsInline = true;
  v.muted = true;
  if (kind === 'screen') {
    v.className = 'screen';
    v.srcObject = src;
  } else {
    v.loop = true;
    v.src = src;
  }
  v.play().catch(() => {});
  return v;
}

// ----- Ambiente imersivo -----

let bgKey = null;
let bgFront = 'a';
let locationKey = null;
let titleTimer = null;

function updateEnvironment(scene, zone) {
  const immersive = Boolean(scene);
  document.body.classList.toggle('immersive', immersive);
  $('ui-toggle').classList.toggle('hidden', !immersive);
  if (!immersive) setUiHidden(false);

  // Texto da cena
  const text = $('scene-text');
  const caption = scene ? scene.caption : '';
  if (text.textContent !== caption) {
    text.textContent = caption;
    text.style.animation = 'none';
    void text.offsetWidth;
    text.style.animation = '';
  }

  // Imagem (ou vídeo) do ambiente, com troca suave
  const visual = scene && scene.visualId ? mediaById(scene.visualId) : null;
  const url = visual && mediaUrl(visual.id);
  const key = url ? `${visual.kind}:${visual.id}` : null;
  if (key !== bgKey) {
    bgKey = key;
    setBackground(visual, url, key);
  }

  // Nome do lugar ao chegar
  const placeKey = immersive && inCall ? `${zone ? zone.id : 'room'}:${key}` : null;
  if (placeKey && placeKey !== locationKey) showLocation(zone ? zone.name : db.room.name);
  locationKey = placeKey;

  syncMusic();
}

function setBackground(visual, url, key) {
  const backId = bgFront === 'a' ? 'b' : 'a';
  const front = $(`scene-layer-${bgFront}`);
  const back = $(`scene-layer-${backId}`);
  back.replaceChildren();
  back.style.backgroundImage = '';
  const reveal = () => {
    if (bgKey !== key) return; // já mudou de novo
    back.classList.add('show');
    front.classList.remove('show');
    bgFront = backId;
    setTimeout(() => {
      if (!front.classList.contains('show')) {
        front.replaceChildren();
        front.style.backgroundImage = '';
      }
    }, 2000);
  };
  if (!visual || !url) {
    front.classList.remove('show');
    return;
  }
  if (visual.kind === 'video') {
    const v = videoEl(url, 'scene');
    v.addEventListener('loadeddata', reveal, { once: true });
    back.appendChild(v);
  } else {
    const img = new Image();
    img.onload = () => {
      back.style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`;
      reveal();
    };
    img.src = url;
  }
}

function showLocation(name) {
  const el = $('location-title');
  el.textContent = name;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(titleTimer);
  titleTimer = setTimeout(() => el.classList.remove('show'), 3800);
}

function setUiHidden(hidden) {
  document.body.classList.toggle('ui-hidden', hidden);
  $('ui-restore').classList.toggle('hidden', !hidden);
}
$('ui-toggle').onclick = () => setUiHidden(true);
$('ui-restore').onclick = () => setUiHidden(false);
document.addEventListener('keydown', (e) => {
  if ((e.key === 'h' || e.key === 'H') && !e.repeat && !e.target.closest('input, textarea, select') && document.body.classList.contains('immersive')) {
    setUiHidden(!document.body.classList.contains('ui-hidden'));
  }
});

// No ambiente imersivo a interface esmaece depois de alguns segundos parada,
// e volta com qualquer movimento, toque ou tecla. Não esmaece enquanto a
// pessoa digita ou tem o mouse sobre um painel.
const IDLE_MS = 6000;
let idleTimer = null;
function wakeUi() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const active = document.activeElement;
    const typing = active && active.closest && active.closest('input, textarea, select');
    const hovering = document.querySelector('.side:hover, .topbar:hover');
    const overlay = !$('join-overlay').classList.contains('hidden') || !$('dice-prompt').classList.contains('hidden');
    if (typing || hovering || overlay) return wakeUi();
    if (document.body.classList.contains('immersive')) document.body.classList.add('idle');
  }, IDLE_MS);
}
['pointermove', 'pointerdown', 'keydown', 'wheel', 'focusin'].forEach((ev) => document.addEventListener(ev, wakeUi, { passive: true }));
wakeUi();

// ----- Música (mixer do mestre, faixas do YouTube) -----
// Cada faixa ativa do ambiente vira um player escondido do YouTube. O estado
// (tocando, pausada, posição, volume, repetir) vem do banco; aqui só seguimos.

let ytApi = null;
const musicPlayers = new Map(); // trackId -> { key, player, ready, reported }
let musicMuted = readStored('rpg-music-muted', false);
let musicBlocked = false;
let musicBlockTimer = null;
let clockSkew = 0; // relógio do servidor - relógio local (ms)
const serverNow = () => Date.now() + clockSkew;

async function syncClock() {
  const t0 = Date.now();
  const { data, error } = await supabase.rpc('server_now');
  if (error || !data) return;
  const t1 = Date.now();
  clockSkew = Date.parse(data) - (t0 + t1) / 2;
}

function loadYouTubeApi() {
  if (!ytApi) {
    ytApi = new Promise((resolve) => {
      if (window.YT && window.YT.Player) return resolve(window.YT);
      window.onYouTubeIframeAPIReady = () => resolve(window.YT);
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(script);
    });
  }
  return ytApi;
}

/** Faixas que este aparelho deve tocar agora. */
function myMusicTracks() {
  if (!db || !inCall) return [];
  if (isMaster) return musicMonitor ? tracksForDest(db.tracks, musicDest) : [];
  return tracksForZone(db.tracks, myZoneId());
}

function setMusicBlocked(blocked) {
  if (blocked && !musicBlocked) toast('Toque em "Toque para ativar a música" para ouvir o ambiente.', 5000);
  musicBlocked = blocked;
  renderMusicChip();
}

function renderMusicChip() {
  if (isMaster) return;
  const active = myMusicTracks().filter((t) => t.status === 'playing');
  $('music-chip').classList.toggle('hidden', !active.length);
  $('music-chip').classList.toggle('blocked', musicBlocked);
  const names = active.map((t) => t.title || 'Música ambiente');
  $('music-label').textContent = musicBlocked ? 'Toque para ativar a música' : names.join(' · ');
  $('music-toggle').innerHTML = icon(musicMuted ? 'volumeOff' : 'volume', 15);
  $('music-toggle').title = musicMuted ? 'Ativar música' : 'Silenciar música';
}

function destroyMusicPlayer(id) {
  const entry = musicPlayers.get(id);
  if (!entry) return;
  try {
    if (entry.player && entry.player.destroy) entry.player.destroy();
  } catch {}
  const el = document.getElementById(`yt-${id}`);
  if (el) el.remove();
  musicPlayers.delete(id);
}

function destroyMusic() {
  for (const id of [...musicPlayers.keys()]) destroyMusicPlayer(id);
  clearTimeout(musicBlockTimer);
  musicBlocked = false;
}

/** Ajusta um player ao estado da faixa (play/pausa, volume, posição). */
function applyTrack(entry, track) {
  const p = entry.player;
  if (!entry.ready || !p || !p.getPlayerState) return;
  const YT = window.YT;
  const vol = Math.round(Math.min(1, (Number(track.volume) || 0) * playerSceneVolume) * 100);
  if (musicMuted || vol === 0) p.mute();
  else {
    p.unMute();
    p.setVolume(vol);
  }
  const now = serverNow();
  const shouldPlay = track.status === 'playing' && !trackEnded(track, now);
  const state = p.getPlayerState();
  if (!entry.isList) {
    const want = trackPosition(track, now);
    const cur = p.getCurrentTime ? p.getCurrentTime() : 0;
    if (Math.abs(cur - want) > 2.5 && !(track.duration_s && want >= track.duration_s - 0.5)) p.seekTo(want, true);
  }
  if (shouldPlay && state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING) p.playVideo();
  if (!shouldPlay && (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING)) p.pauseVideo();
}

async function createMusicPlayer(track, parsed, key) {
  const entry = { key, player: null, ready: false, reported: false, isList: Boolean(parsed.listId && !parsed.videoId) };
  musicPlayers.set(track.id, entry);
  const holder = document.createElement('div');
  holder.id = `yt-${track.id}`;
  $('yt-holder').appendChild(holder);
  const YT = await loadYouTubeApi();
  if (musicPlayers.get(track.id) !== entry) return;
  const playerVars = { autoplay: 0, controls: 0, disablekb: 1, playsinline: 1, rel: 0, fs: 0, iv_load_policy: 3 };
  if (parsed.listId) Object.assign(playerVars, { listType: 'playlist', list: parsed.listId, loop: 1 });
  entry.player = new YT.Player(holder.id, {
    width: 200,
    height: 113,
    videoId: parsed.videoId || undefined,
    playerVars,
    events: {
      onReady: () => {
        entry.ready = true;
        const t = (db.tracks || []).find((x) => x.id === track.id);
        if (t) applyTrack(entry, t);
      },
      onStateChange: (e) => {
        const t = (db.tracks || []).find((x) => x.id === track.id);
        if (e.data === YT.PlayerState.PLAYING) {
          setMusicBlocked(false);
          // Informa duração e título uma vez (o mestre precisa para saber quando a faixa acaba)
          if (!entry.reported && t && !entry.isList) {
            const duration = e.target.getDuration ? e.target.getDuration() : 0;
            const data = e.target.getVideoData ? e.target.getVideoData() : {};
            if (duration > 0 && (!t.duration_s || !t.title)) {
              entry.reported = true;
              supabase.rpc('report_track_meta', { p_track_id: t.id, p_duration: duration, p_title: (data && data.title) || '' }).then(() => {});
            }
          }
        }
        // Fim do vídeo: com repetição volta ao começo; sem repetição, o mestre passa para a próxima
        if (e.data === YT.PlayerState.ENDED && t && t.loop && !entry.isList) {
          e.target.seekTo(0, true);
          e.target.playVideo();
        }
      },
      onError: (e) => {
        const t = (db.tracks || []).find((x) => x.id === track.id);
        if (!isMaster) toast(`${(t && t.title) || 'Uma música'}: ${e && (e.data === 101 || e.data === 150) ? 'o dono do vídeo não permite tocar fora do YouTube' : 'indisponível'}.`, 6000);
      },
    },
  });
}

/** Cria, ajusta e remove players conforme as faixas do ambiente. */
function syncMusic() {
  const wanted = myMusicTracks().filter((t) => t.status !== 'stopped');
  const wantedIds = new Set();
  for (const track of wanted) {
    const parsed = parseYouTube(track.youtube);
    if (!parsed) continue;
    const key = `${parsed.videoId}|${parsed.listId}`;
    wantedIds.add(track.id);
    const entry = musicPlayers.get(track.id);
    if (entry && entry.key !== key) destroyMusicPlayer(track.id);
    if (!musicPlayers.has(track.id)) {
      if (track.status === 'playing') createMusicPlayer(track, parsed, key);
      continue;
    }
    applyTrack(musicPlayers.get(track.id), track);
  }
  for (const id of [...musicPlayers.keys()]) if (!wantedIds.has(id)) destroyMusicPlayer(id);

  // Navegador bloqueou o som automático? Avisa para tocar na tela.
  clearTimeout(musicBlockTimer);
  if (!isMaster && wanted.some((t) => t.status === 'playing')) {
    musicBlockTimer = setTimeout(() => {
      const YT = window.YT;
      const stuck = [...musicPlayers.entries()].some(([id, en]) => {
        const t = (db.tracks || []).find((x) => x.id === id);
        if (!t || t.status !== 'playing' || trackEnded(t, serverNow()) || !en.ready || !YT) return false;
        const st = en.player.getPlayerState();
        return st !== YT.PlayerState.PLAYING && st !== YT.PlayerState.BUFFERING;
      });
      if (stuck) setMusicBlocked(true);
    }, 4000);
  }
  renderMusicChip();
}

$('music-toggle').onclick = (e) => {
  e.stopPropagation();
  musicMuted = !musicMuted;
  store('rpg-music-muted', musicMuted);
  syncMusic();
};
$('music-chip').onclick = () => {
  if (!musicBlocked) return;
  for (const entry of musicPlayers.values()) if (entry.ready && entry.player.playVideo) entry.player.playVideo();
  setTimeout(syncMusic, 300);
};

// Carrega as faixas da sala (separado do resto para mudar rápido)
let tracksTimer = null;
function scheduleTracks() {
  clearTimeout(tracksTimer);
  tracksTimer = setTimeout(loadTracks, 60);
}
async function loadTracks() {
  const { data, error } = await supabase
    .from('music_tracks')
    .select(TRACK_COLS)
    .eq('room_id', roomId)
    .eq('archived', false)
    .order('position');
  if (error) return console.error('tracks', error);
  if (!db) return;
  db.tracks = data;
  syncMusic();
  if (isMaster) renderMixer();
}

// A cada segundo: barras de progresso do mixer, correção de atraso e fim das faixas
const endedSent = new Set();
let musicTicks = 0;
setInterval(() => {
  if (!db || !db.tracks) return;
  if (isMaster) {
    updateMixerProgress();
    // O mestre avisa o banco quando uma faixa termina, para tocar a próxima
    for (const t of db.tracks) {
      const sig = `${t.id}:${t.started_at}`;
      if (trackEnded(t, serverNow()) && !endedSent.has(sig)) {
        endedSent.add(sig);
        supabase.rpc('music_control', { p_track_id: t.id, p_action: 'ended' }).then(({ error }) => error && console.warn('ended', error.message));
      }
    }
  }
  musicTicks += 1;
  if (inCall && musicPlayers.size && musicTicks % 4 === 0) syncMusic();
}, 1000);

$('stage-full').onclick = () => {
  const stage = $('stage');
  if (document.fullscreenElement) document.exitFullscreen();
  else if (stage.requestFullscreen) stage.requestFullscreen();
};

// ---------------------------------------------------------------------------
// Efeitos sonoros
// ---------------------------------------------------------------------------

function playSfx(mediaId, volume = 1) {
  const url = mediaUrl(mediaId);
  if (!url) return;
  const a = new Audio(url);
  a.volume = Math.min(1, volume);
  activeSfx.add(a);
  a.onended = () => activeSfx.delete(a);
  a.play().catch(() => activeSfx.delete(a));
}

function stopAllSfx() {
  for (const a of activeSfx) a.pause();
  activeSfx.clear();
}

function onSfx(payload) {
  if (!inCall || isMaster || !payload) return;
  if (!targetIncludes(payload.target, { userId: user.id, zoneId: myZoneId() })) return;
  playSfx(Number(payload.mediaId), playerSceneVolume);
}

// ---------------------------------------------------------------------------
// Dados (quem sorteia é o banco; aqui só pedimos, mostramos e animamos)
// ---------------------------------------------------------------------------

const QUICK_DICE = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100'];
let rolls = []; // rolagens que eu posso ver (mais recentes primeiro)
let rollsLoaded = false;
const revealedRolls = new Set();
const revealQueue = [];
let revealing = false;
let revealTimers = [];
let requestsKey = '';

async function callRpc(name, params) {
  const { error } = await supabase.rpc(name, params);
  if (error) toast(friendlyError(error));
  scheduleRolls();
  return !error;
}

let rollsTimer = null;
function scheduleRolls() {
  clearTimeout(rollsTimer);
  rollsTimer = setTimeout(loadRolls, 60);
}

async function loadRolls() {
  const { data, error } = await supabase
    .from('dice_rolls')
    .select('id, roller_id, created_by, expression, label, status, visibility, result, total, created_at, rolled_at')
    .eq('room_id', roomId)
    .order('created_at', { ascending: false })
    .limit(60);
  if (error) return console.error('rolls', error);
  const fresh = [];
  for (const r of data) {
    if (r.status !== 'rolled' || revealedRolls.has(r.id)) continue;
    revealedRolls.add(r.id);
    if (rollsLoaded && Date.now() - new Date(r.rolled_at).getTime() < 60000) fresh.push(r);
  }
  if (isMaster && rollsLoaded) {
    for (const r of data) {
      if (r.status === 'requested' && !rolls.some((x) => x.id === r.id)) toast(`${nameOf(r.roller_id)} pediu para rolar ${r.expression}.`, 6000);
    }
  }
  rolls = data;
  rollsLoaded = true;
  fresh.reverse().forEach(queueReveal);
  renderDice();
}

function rollerName(id) {
  if (id === user.id) return 'Você';
  return state && state.master && state.master.userId === id ? state.master.displayName : nameOf(id);
}

/** Dados de cada termo, com mantidos/descartados e máximos/mínimos destacados. */
function diceDetailHtml(result, limit = 80) {
  if (!result || !Array.isArray(result.terms)) return '';
  let shown = 0;
  return result.terms
    .map((t, i) => {
      const op = t.sign < 0 ? '− ' : i > 0 ? '+ ' : '';
      if (t.type === 'const') return `${op}${t.value}`;
      const items = [];
      for (let j = 0; j < t.rolls.length; j++) {
        if (shown >= limit) {
          items.push(`… mais ${t.rolls.length - j}`);
          break;
        }
        shown++;
        const v = t.rolls[j];
        const cls = ['die'];
        if (!t.kept[j]) cls.push('dropped');
        else if (t.faces > 1 && v === t.faces) cls.push('max');
        else if (t.faces > 1 && v === 1) cls.push('min');
        items.push(`<span class="${cls.join(' ')}">${v}</span>`);
      }
      return `${op}${t.count}d${t.faces}${t.mode ? t.mode + t.k : ''} [${items.join(', ')}]`;
    })
    .join(' ');
}

function logEntryHtml(r) {
  const secret = r.visibility === 'secret';
  return `<div class="dice-entry ${secret ? 'secret' : ''}">
    <div class="meta"><b>${escapeHtml(rollerName(r.roller_id))}</b>${r.label ? ` · ${escapeHtml(r.label)}` : ''}${secret ? ' · secreta' : ''}</div>
    <div class="total">${r.total}</div>
    <div class="detail" title="${escapeHtml(r.expression)}">${escapeHtml(r.expression)} = ${diceDetailHtml(r.result, 24)}</div>
  </div>`;
}

function renderDiceLog(el) {
  const done = rolls.filter((r) => r.status === 'rolled').slice(0, 30);
  el.innerHTML = done.length ? done.map(logEntryHtml).join('') : '<div class="hint">Nenhuma rolagem ainda.</div>';
}

function renderDice() {
  if (!state) return;
  if (isMaster) {
    const requests = rolls.filter((r) => r.status === 'requested').reverse();
    const key = requests.map((r) => r.id).join(',');
    if (key !== requestsKey) {
      requestsKey = key;
      $('dice-requests').innerHTML = requests.length
        ? `<p class="eyebrow" style="margin-top:0">Pedidos dos jogadores</p>${requests
            .map(
              (r) => `<div class="dice-card request" data-roll="${r.id}">
                <div class="who"><b>${escapeHtml(rollerName(r.roller_id))}</b> quer rolar${r.label ? ` · ${escapeHtml(r.label)}` : ''}</div>
                <div class="actions"><input type="text" value="${escapeHtml(r.expression)}" data-expr aria-label="Expressão" maxlength="200"></div>
                <div class="actions">
                  <label class="check"><input type="checkbox" data-secret> Secreto</label>
                  <span style="flex:1"></span>
                  <button class="sm primary" data-approve>Aprovar</button>
                  <button class="sm" data-deny>Recusar</button>
                </div>
              </div>`,
            )
            .join('')}<hr class="divider">`
        : '';
    }
    $('dice-badge').textContent = requests.length;
    $('dice-badge').classList.toggle('hidden', !requests.length);

    const ordered = rolls.filter((r) => r.status === 'ordered').reverse();
    $('dice-ordered').innerHTML = ordered.length
      ? `<p class="eyebrow" style="margin-top:1rem">Aguardando jogadores</p>${ordered
          .map(
            (r) => `<div class="dice-card" data-roll="${r.id}">
              <div class="who"><b>${escapeHtml(rollerName(r.roller_id))}</b> deve rolar <span class="expr">${escapeHtml(r.expression)}</span>${r.label ? ` · ${escapeHtml(r.label)}` : ''}${r.visibility === 'secret' ? ' · secreta' : ''}</div>
              <div class="actions"><span style="flex:1"></span><button class="sm" data-cancel-order>Cancelar</button></div>
            </div>`,
          )
          .join('')}`
      : '';

    const who = $('master-dice-who');
    const current = who.value || 'me';
    who.innerHTML = [`<option value="me">Eu (mestre)</option>`, ...state.players.map((p) => `<option value="${escapeHtml(p.userId)}">${escapeHtml(p.displayName)}${p.online ? '' : ' (fora da call)'}</option>`)].join('');
    who.value = [...who.options].some((o) => o.value === current) ? current : 'me';
    $('master-dice-submit').textContent = who.value === 'me' ? 'Rolar' : 'Mandar rolar';
    renderDiceLog($('master-dice-log'));
  } else {
    const mine = rolls.filter((r) => r.roller_id === user.id);
    const ordered = mine.filter((r) => r.status === 'ordered').reverse();
    renderDicePrompt(ordered[0]);

    const pending = mine.filter((r) => r.status === 'requested').reverse();
    const recentDenied = mine.filter((r) => r.status === 'denied' && Date.now() - new Date(r.created_at).getTime() < 10 * 60000).slice(0, 2);
    $('player-dice-pending').innerHTML = [
      ...pending.map(
        (r) => `<div class="dice-card" data-roll="${r.id}" style="margin-top:0.6rem">
          <div class="who">Aguardando o mestre: <span class="expr">${escapeHtml(r.expression)}</span>${r.label ? ` · ${escapeHtml(r.label)}` : ''}</div>
          <div class="actions"><span style="flex:1"></span><button class="sm" data-cancel-request>Cancelar pedido</button></div>
        </div>`,
      ),
      ...recentDenied.map((r) => `<div class="hint" style="margin-top:0.5rem">O mestre recusou ${escapeHtml(r.expression)}${r.label ? ` (${escapeHtml(r.label)})` : ''}.</div>`),
    ].join('');
    $('player-dice-submit').disabled = pending.length >= 3;
    renderDiceLog($('player-dice-log'));
  }
}

let promptKey = null;
function renderDicePrompt(r) {
  const el = $('dice-prompt');
  const key = r ? String(r.id) : null;
  if (key === promptKey) return;
  promptKey = key;
  if (!r) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  const parsed = parseDice(r.expression);
  el.innerHTML = `<div class="eyebrow">O mestre pediu uma rolagem</div>
    ${r.label ? `<div style="font-family:var(--font-display);font-size:1.25rem;margin-top:0.3rem">${escapeHtml(r.label)}</div>` : ''}
    <div class="expr">${escapeHtml(r.expression)}</div>
    <div class="hint">${escapeHtml(describeDice(parsed))}${r.visibility === 'secret' ? ' · só você e o mestre verão o resultado' : ''}</div>
    <button class="primary" data-perform="${r.id}">${icon('dice', 18)}Rolar</button>`;
  el.classList.remove('hidden');
}

function queueReveal(r) {
  revealQueue.push(r);
  if (!revealing) nextReveal();
}

// ----- Dados rolando na tela -----

/** Forma (SVG) de cada tipo de dado. Dados com outros lados viram uma esfera. */
const DIE_SHAPES = {
  4: { poly: '50,6 95,90 5,90', text: 66 },
  6: { rect: true, text: 58 },
  8: { poly: '50,3 96,50 50,97 4,50', text: 58 },
  10: { poly: '50,3 95,42 50,97 5,42', text: 54 },
  12: { poly: '50,4 95,37 78,94 22,94 5,37', text: 60 },
  20: { poly: '50,3 94,27 94,73 50,97 6,73 6,27', inner: '50,20 78,68 22,68', text: 58 },
  100: { poly: '50,3 95,42 50,97 5,42', text: 54 },
};

function dieSvg(faces, value) {
  const shape = DIE_SHAPES[faces];
  const body = !shape
    ? '<circle cx="50" cy="50" r="45" class="die-body"/>'
    : shape.rect
      ? '<rect x="7" y="7" width="86" height="86" rx="16" class="die-body"/>'
      : `<polygon points="${shape.poly}" class="die-body"/>${shape.inner ? `<polygon points="${shape.inner}" class="die-edge"/>` : ''}`;
  const size = String(value).length >= 4 ? 22 : String(value).length === 3 ? 28 : 36;
  return `<svg viewBox="0 0 100 100" aria-hidden="true">${body}<text x="50" y="${shape ? shape.text : 58}" text-anchor="middle" dominant-baseline="middle" font-size="${size}" class="die-num">${value}</text></svg>
    <span class="die-type">d${faces}</span>`;
}

/** Dados que vão aparecer rolando (no máximo 14; o resto entra no total). */
function diceToShow(result) {
  const out = [];
  let hidden = 0;
  for (const t of (result && result.terms) || []) {
    if (t.type !== 'dice') continue;
    t.rolls.forEach((v, j) => {
      if (out.length < 14) out.push({ faces: t.faces, value: v, kept: t.kept[j], negative: t.sign < 0 });
      else hidden += 1;
    });
  }
  return { dice: out, hidden };
}

function nextReveal() {
  revealTimers.forEach((t) => { clearTimeout(t); clearInterval(t); });
  revealTimers = [];
  const el = $('dice-reveal');
  const r = revealQueue.shift();
  if (!r) {
    revealing = false;
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  revealing = true;
  const { dice, hidden } = diceToShow(r.result);
  const consts = ((r.result && r.result.terms) || []).filter((t) => t.type === 'const');
  const bonus = consts.reduce((sum, t) => sum + t.sign * t.value, 0);
  el.innerHTML = `<div class="box">
      <div class="who">${escapeHtml(rollerName(r.roller_id))} ${r.roller_id === user.id ? 'rolou' : 'está rolando'}</div>
      ${r.label ? `<div class="label">${escapeHtml(r.label)}</div>` : ''}
      <div class="tray ${dice.length > 6 ? 'many' : ''}"></div>
      ${hidden ? `<div class="hint" style="color:rgba(244,239,228,0.7)">e mais ${hidden} ${hidden === 1 ? 'dado' : 'dados'}</div>` : ''}
      <div class="total" style="visibility:hidden">${r.total}</div>
      <div class="expr">${escapeHtml(r.expression)}${bonus ? ` <span class="bonus">(${bonus > 0 ? '+' : '−'}${Math.abs(bonus)})</span>` : ''}</div>
      <div class="detail" style="visibility:hidden">${diceDetailHtml(r.result, 120)}</div>
      ${r.visibility === 'secret' ? '<div class="secret-tag"><span class="tag whisper">Rolagem secreta</span></div>' : ''}
    </div>`;
  el.classList.remove('hidden');

  const tray = el.querySelector('.tray');
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let longest = 0;
  dice.forEach((d, i) => {
    const node = document.createElement('div');
    node.className = `die-3d${d.negative ? ' negative' : ''}`;
    node.innerHTML = dieSvg(d.faces, d.faces === 1 ? 1 : Math.ceil(Math.random() * d.faces));
    tray.appendChild(node);
    const delay = reduced ? 0 : i * 70;
    const dur = reduced ? 0 : 1150 + Math.random() * 550;
    longest = Math.max(longest, delay + dur);
    const settle = () => {
      node.innerHTML = dieSvg(d.faces, d.value);
      node.classList.add('landed');
      if (!d.kept) node.classList.add('dropped');
      else if (d.faces > 1 && d.value === d.faces) node.classList.add('crit');
      else if (d.faces > 1 && d.value === 1) node.classList.add('fumble');
    };
    if (reduced) return settle();

    // Vem rolando de um canto da tela, quica e gira até parar
    const side = Math.random() < 0.5 ? -1 : 1;
    const fromX = side * (window.innerWidth * 0.55 + Math.random() * 120);
    const fromY = window.innerHeight * (0.15 + Math.random() * 0.25);
    const spin = side * (540 + Math.random() * 540);
    const endRot = (Math.random() - 0.5) * 24;
    const anim = node.animate(
      [
        { transform: `translate(${fromX}px, ${fromY}px) rotate(0deg) scale(0.55)`, opacity: 0 },
        { transform: `translate(${fromX * 0.5}px, ${-90 - Math.random() * 60}px) rotate(${spin * 0.45}deg) scale(1.08)`, opacity: 1, offset: 0.34 },
        { transform: `translate(${fromX * 0.18}px, 6px) rotate(${spin * 0.75}deg) scale(1)`, offset: 0.58 },
        { transform: `translate(${fromX * 0.06}px, -26px) rotate(${spin * 0.9}deg) scale(1.02)`, offset: 0.76 },
        { transform: `translate(${fromX * 0.015}px, 0px) rotate(${spin * 0.97 + endRot}deg)`, offset: 0.9 },
        { transform: `translate(0px, 0px) rotate(${endRot}deg) scale(1)`, opacity: 1 },
      ],
      { duration: dur, delay, easing: 'cubic-bezier(.25,.7,.35,1)', fill: 'both' },
    );
    // Números trocando enquanto rola
    const flicker = setInterval(() => {
      if (d.faces > 1) node.querySelector('.die-num').textContent = Math.ceil(Math.random() * d.faces);
    }, 75);
    revealTimers.push(flicker);
    anim.onfinish = () => {
      clearInterval(flicker);
      settle();
    };
    // Batidas na mesa em cada quique
    if (i < 10) [0.34, 0.58, 0.76, 0.9].forEach((o, k) => scheduleDiceHit((delay + dur * o) / 1000, 1 - k * 0.22, d.faces));
  });

  const showTotal = () => {
    const who = el.querySelector('.who');
    if (who) who.textContent = `${rollerName(r.roller_id)} rolou`;
    const total = el.querySelector('.total');
    total.style.visibility = 'visible';
    total.classList.add('landed');
    el.querySelector('.detail').style.visibility = 'visible';
    playDiceThud();
  };
  revealTimers.push(setTimeout(showTotal, longest + 150));
  revealTimers.push(setTimeout(nextReveal, longest + 4200));
}
$('dice-reveal').onclick = () => nextReveal();
// Celulares suspendem o áudio até um toque; qualquer toque reativa o som dos dados.
document.addEventListener('pointerdown', unlockAudio);

/** Som de um dado batendo na mesa (sintetizado, sem arquivo). */
function scheduleDiceHit(inSeconds, strength = 1, faces = 20) {
  if (!audioCtx || audioCtx.state === 'closed') return;
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  try {
    const t = audioCtx.currentTime + Math.max(0, inSeconds);
    const vol = Math.max(0, Math.min(1, playerSceneVolume)) * 0.5 * strength;
    if (vol <= 0) return;
    // estalo (ruído filtrado)
    const len = Math.floor(audioCtx.sampleRate * 0.04);
    const buffer = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let j = 0; j < len; j++) data[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / len, 4);
    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer;
    const band = audioCtx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 2400 + Math.random() * 1800;
    band.Q.value = 1.2;
    const g1 = audioCtx.createGain();
    g1.gain.value = vol;
    noise.connect(band).connect(g1).connect(audioCtx.destination);
    noise.start(t);
    // corpo do dado (tom curto; dados menores soam mais agudos)
    const osc = audioCtx.createOscillator();
    osc.type = 'triangle';
    const base = faces <= 6 ? 1150 : faces <= 12 ? 950 : 800;
    osc.frequency.setValueAtTime(base + Math.random() * 250, t);
    osc.frequency.exponentialRampToValueAtTime(base * 0.55, t + 0.06);
    const g2 = audioCtx.createGain();
    g2.gain.setValueAtTime(vol * 0.45, t);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    osc.connect(g2).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.08);
  } catch (err) {
    console.warn('dice sound', err);
  }
}

/** Som do resultado aparecendo. */
function playDiceThud() {
  if (!audioCtx || audioCtx.state === 'closed') return;
  try {
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(70, t + 0.25);
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.35 * Math.min(1, playerSceneVolume), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.4);
  } catch (err) {
    console.warn('dice sound', err);
  }
}

function setupDiceControls() {
  // Chips de dados rápidos
  document.querySelectorAll('.dice-chips').forEach((box) => {
    const input = $(box.dataset.for);
    box.innerHTML = QUICK_DICE.map((d) => `<button type="button" class="sm" data-die="${d}">${d}</button>`).join('');
    box.onclick = (e) => {
      const btn = e.target.closest('[data-die]');
      if (!btn) return;
      const v = input.value.trim();
      input.value = v ? `${v}+1${btn.dataset.die}` : `1${btn.dataset.die}`;
      input.dispatchEvent(new Event('input'));
      input.focus();
    };
  });
  // Prévia ao digitar
  const preview = (inputId, previewId) => {
    const input = $(inputId);
    const out = $(previewId);
    input.addEventListener('input', () => {
      const v = input.value.trim();
      if (!v) {
        out.textContent = '';
        out.classList.remove('bad');
        return;
      }
      const parsed = parseDice(v);
      out.classList.toggle('bad', !parsed.ok);
      if (!parsed.ok) out.textContent = parsed.error;
      else {
        const range = diceRange(parsed);
        out.textContent = `${describeDice(parsed)}. Resultado entre ${range.min} e ${range.max}.`;
      }
    });
  };

  if (isMaster) {
    preview('master-dice-expr', 'master-dice-preview');
    $('master-dice-who').onchange = (e) => ($('master-dice-submit').textContent = e.target.value === 'me' ? 'Rolar' : 'Mandar rolar');
    $('master-dice-form').addEventListener('submit', async () => {
      const expr = $('master-dice-expr').value.trim();
      const parsed = parseDice(expr);
      if (!parsed.ok) return toast(parsed.error);
      const who = $('master-dice-who').value;
      const params = { p_room_id: roomId, p_expression: parsed.expression, p_label: $('master-dice-label').value.trim(), p_secret: $('master-dice-secret').checked };
      const ok = who === 'me' ? await callRpc('master_roll', params) : await callRpc('order_roll', { ...params, p_user_id: who });
      if (ok && who !== 'me') toast(`Pedido enviado para ${nameOf(who)}.`);
    });
    $('dice-requests').onclick = (e) => {
      const card = e.target.closest('[data-roll]');
      if (!card) return;
      const id = Number(card.dataset.roll);
      if (e.target.closest('[data-approve]')) {
        const expr = card.querySelector('[data-expr]').value.trim();
        const parsed = parseDice(expr);
        if (!parsed.ok) return toast(parsed.error);
        callRpc('approve_roll', { p_roll_id: id, p_expression: parsed.expression, p_secret: card.querySelector('[data-secret]').checked });
      } else if (e.target.closest('[data-deny]')) {
        callRpc('deny_roll', { p_roll_id: id });
      }
    };
    $('dice-ordered').onclick = (e) => {
      const card = e.target.closest('[data-roll]');
      if (card && e.target.closest('[data-cancel-order]')) callRpc('deny_roll', { p_roll_id: Number(card.dataset.roll) });
    };
  } else {
    preview('player-dice-expr', 'player-dice-preview');
    $('player-dice-form').addEventListener('submit', async () => {
      const parsed = parseDice($('player-dice-expr').value.trim());
      if (!parsed.ok) return toast(parsed.error);
      const ok = await callRpc('request_roll', { p_room_id: roomId, p_expression: parsed.expression, p_label: $('player-dice-label').value.trim() });
      if (ok) toast('Pedido enviado ao mestre.');
    });
    $('player-dice-pending').onclick = (e) => {
      const card = e.target.closest('[data-roll]');
      if (card && e.target.closest('[data-cancel-request]')) callRpc('cancel_roll', { p_roll_id: Number(card.dataset.roll) });
    };
    $('dice-prompt').onclick = (e) => {
      const btn = e.target.closest('[data-perform]');
      if (!btn) return;
      btn.disabled = true;
      callRpc('perform_roll', { p_roll_id: Number(btn.dataset.perform) });
    };
  }
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
  // Sem microfone (permissão negada, aparelho sem mic) a pessoa ainda entra para
  // ouvir, ver a tela do mestre, o ambiente e os dados de todos.
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    micTrack = localStream.getAudioTracks()[0];
  } catch (err) {
    console.warn('sem microfone', err);
    localStream = null;
    micTrack = null;
    toast('Microfone indisponível: você entrou só para ouvir e assistir. Libere o microfone no navegador e recarregue para falar.', 9000);
  }
  try {
    audioCtx = new AudioContext();
  } catch {
    audioCtx = null;
  }
  if (localStream) watchLevel(user.id, localStream);
  await Promise.all([loadIceServers(), syncClock()]);
  inCall = true;
  try {
    await connectRealtime();
  } catch (err) {
    console.error(err);
    stopCall();
    $('join-btn').disabled = false;
    $('join-btn').textContent = 'Tentar de novo';
    $('join-btn').onclick = () => location.reload();
    $('join-error').textContent = 'Não foi possível conectar à sala em tempo real. Verifique sua internet e tente de novo.';
    return;
  }
  $('join-overlay').classList.add('hidden');
  $('mute-btn').disabled = !micTrack;
  recompute();
}

function stopCall() {
  inCall = false;
  if (channel) {
    supabase.removeChannel(channel);
    channel = null;
  }
  if (screenTrack) screenTrack.stop();
  if (screenAudioTrack) screenAudioTrack.stop();
  screenTrack = null;
  screenAudioTrack = null;
  closeAllPeers();
  stopAllSfx();
  destroyMusic();
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
  el.classList.remove('ok', 'bad', 'accent');
  let text;
  if (!connected || !inCall) {
    el.classList.add('bad');
    text = 'Desconectado';
  } else {
    const total = peers.size;
    const ok = [...peers.values()].filter((p) => p.pc.connectionState === 'connected').length;
    text = total ? `${ok} de ${total} conectados` : 'Na call';
    el.classList.add(ok === total ? 'ok' : 'accent');
  }
  el.lastElementChild.textContent = text;
}

function renderMuteButton() {
  $('mute-btn').innerHTML = `${icon(muted ? 'micOff' : 'mic', 16)}<span>${muted ? 'Microfone desligado' : 'Microfone'}</span>`;
  $('mute-btn').classList.toggle('active', muted);
}
renderMuteButton();

// Jogador silenciado pelo mestre: avisa e trava o botão do microfone
let silencedByMaster = false;
function renderMasterMute() {
  const me = playerById(user.id);
  const silenced = Boolean(me && me.mutedByMaster);
  if (silenced !== silencedByMaster) {
    toast(silenced ? 'O mestre silenciou você. Ninguém ouve sua voz agora.' : 'O mestre liberou sua voz.', 6000);
    silencedByMaster = silenced;
  }
  if (silenced) {
    $('mute-btn').innerHTML = `${icon('micOff', 16)}<span>Silenciado pelo mestre</span>`;
    $('mute-btn').classList.add('active');
    $('mute-btn').disabled = true;
  } else {
    renderMuteButton();
    $('mute-btn').disabled = !inCall || !micTrack;
  }
}

$('leave-btn').onclick = () => {
  stopCall();
  location.href = '/painel';
};
$('mute-btn').onclick = () => {
  muted = !muted;
  if (micTrack) micTrack.enabled = !muted;
  renderMuteButton();
  trackPresence();
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
  return !error;
}

// ---------------------------------------------------------------------------
// Controles do mestre
// ---------------------------------------------------------------------------

function setTarget(target) {
  rpc('set_master_target', { p_target: target });
}

/** Opções de alvo para selects: todos, ambientes e (opcional) jogadores online. */
function targetOptions(selected, { players = false } = {}) {
  const opt = (value, text) => `<option value='${escapeHtml(JSON.stringify(value))}' ${JSON.stringify(value) === JSON.stringify(selected) ? 'selected' : ''}>${escapeHtml(text)}</option>`;
  const parts = [opt({ type: 'all' }, 'Todos')];
  parts.push(`<optgroup label="Ambientes">${state.zones.map((z) => opt({ type: 'zone', zoneId: z.id }, z.name)).join('')}</optgroup>`);
  if (players) {
    const on = state.players.filter((p) => p.online);
    if (on.length) parts.push(`<optgroup label="Jogadores">${on.map((p) => opt({ type: 'player', userId: p.userId }, p.displayName)).join('')}</optgroup>`);
  }
  return parts.join('');
}

let sfxTarget = { type: 'all' };
let sceneDest = 'room'; // 'room' ou id do ambiente
let pendingSceneZone = null; // nome do ambiente criado pela aba Cena, até ele chegar do banco
let sceneDraft = null;

function setupMasterControls() {
  // Abas
  document.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('[data-tab]').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
      document.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
    });
  });

  $('zone-form').addEventListener('submit', () => {
    const name = $('zone-name').value.trim();
    if (!name) return;
    rpc('create_zone', { p_name: name });
    $('zone-name').value = '';
  });

  $('targets').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.target) setTarget(JSON.parse(btn.dataset.target));
    if (btn.dataset.whisperStart) rpc('start_whisper', { p_user_id: btn.dataset.whisperStart });
    if (btn.dataset.whisperEnd) rpc('end_whisper', { p_user_id: btn.dataset.whisperEnd });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.target.closest('input, textarea, select')) setTarget({ type: 'all' });
  });

  const zonesEl = $('zones');
  zonesEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const zoneId = Number(btn.dataset.zone);
    if (btn.dataset.action === 'narrate') setTarget({ type: 'zone', zoneId });
    if (btn.dataset.action === 'whisper-start') rpc('start_whisper', { p_user_id: btn.dataset.user });
    if (btn.dataset.action === 'whisper-end') rpc('end_whisper', { p_user_id: btn.dataset.user });
    if (btn.dataset.action === 'mute') rpc('set_member_muted', { p_user_id: btn.dataset.user, p_muted: btn.dataset.muted !== '1' });
    if (btn.dataset.action === 'kick') kickPlayer(btn.dataset.user);
    if (btn.dataset.action === 'rename') {
      const name = prompt('Novo nome do ambiente:', zoneById(zoneId).name);
      if (name && name.trim()) rpc('rename_zone', { p_zone_id: zoneId, p_name: name.trim() });
    }
    if (btn.dataset.action === 'delete' && confirm('Excluir este ambiente? Os jogadores nele vão para outro ambiente.')) {
      rpc('archive_zone', { p_zone_id: zoneId });
    }
    if (btn.dataset.action === 'edit-scene') {
      openSceneEditor(zoneId);
    }
  });
  async function kickPlayer(userId) {
    if (!confirm(`Remover ${nameOf(userId)} da sala? Para voltar, a pessoa vai precisar do código de convite.`)) return;
    const { error } = await supabase.from('room_members').delete().eq('room_id', roomId).eq('user_id', userId);
    if (error) return toast(friendlyError(error));
    toast(`${nameOf(userId)} foi removido da sala.`);
    scheduleRefresh();
  }
  zonesEl.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-move]');
    if (sel) rpc('move_player', { p_user_id: sel.dataset.move, p_zone_id: Number(sel.value) });
  });
  zonesEl.addEventListener('input', (e) => {
    const range = e.target.closest('input[data-volume]');
    if (!range) return;
    zoneVolumes[range.dataset.volume] = Number(range.value);
    store(`rpg-volumes-${roomId}`, zoneVolumes);
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

  // Compartilhamento de tela
  $('share-controls').classList.remove('hidden');
  $('share-btn').onclick = () => (screenTrack ? stopShare() : startShare());
  $('share-target').onchange = async (e) => {
    shareTarget = JSON.parse(e.target.value);
    await trackPresence();
    applyAllRouting();
    updateStage();
  };

  // Cena
  $('scene-dest').onchange = (e) => {
    sceneDest = e.target.value === 'room' ? 'room' : Number(e.target.value);
    loadSceneDraft();
    renderSceneEditor();
  };
  $('scene-visuals').onclick = (e) => {
    const thumb = e.target.closest('[data-visual]');
    if (!thumb) return;
    sceneDraft.visualId = thumb.dataset.visual === 'none' ? null : Number(thumb.dataset.visual);
    renderSceneEditor();
  };
  $('scene-caption').oninput = (e) => (sceneDraft.caption = e.target.value);
  $('scene-new-zone').onclick = async () => {
    const name = (prompt('Nome do novo ambiente (ex.: Floresta, Caverna):') || '').trim().slice(0, 40);
    if (!name) return;
    if (!(await rpc('create_zone', { p_name: name }))) return;
    pendingSceneZone = name;
    scheduleRefresh();
  };
  $('scene-apply').onclick = () => applyScene(sceneDraft);
  $('scene-clear').onclick = () => applyScene({ visualId: null, youtube: '', caption: '', volume: 0.6 }, true);

  $('media-input').onchange = (e) => {
    uploadFiles([...e.target.files]);
    e.target.value = '';
  };
  $('media-list').onclick = async (e) => {
    const btn = e.target.closest('button[data-delete-media]');
    if (!btn) return;
    const m = mediaById(Number(btn.dataset.deleteMedia));
    if (!m || !confirm(`Remover "${m.name}" da biblioteca?`)) return;
    const { error } = await supabase.from('room_media').delete().eq('id', m.id);
    if (error) return toast(friendlyError(error));
    await supabase.storage.from('midia').remove([m.storage_path]);
    scheduleRefresh();
  };

  // Sons
  $('sfx-target').onchange = (e) => (sfxTarget = JSON.parse(e.target.value));
  $('sfx-grid').onclick = (e) => {
    const btn = e.target.closest('button[data-sfx]');
    if (!btn) return;
    const mediaId = Number(btn.dataset.sfx);
    if (!channel) return toast('Entre na call para tocar efeitos.');
    channel.send({ type: 'broadcast', event: 'sfx', payload: { mediaId, target: sfxTarget } });
    playSfx(mediaId);
  };
  $('sfx-stop').onclick = () => {
    if (channel) channel.send({ type: 'broadcast', event: 'sfx-stop', payload: {} });
    stopAllSfx();
  };
}

function sceneSource(dest) {
  return dest === 'room' ? db.room : db.zones.find((z) => z.id === dest);
}

function loadSceneDraft() {
  const src = sceneSource(sceneDest) || {};
  sceneDraft = {
    visualId: src.scene_media_id ?? null,
    youtube: src.ambient_youtube || '',
    caption: src.scene_caption || '',
    volume: typeof src.ambient_volume === 'number' ? src.ambient_volume : 0.6,
  };
  $('scene-caption').value = sceneDraft.caption;
}

function openSceneEditor(zoneId) {
  document.querySelector('[data-tab="cena"]').click();
  sceneDest = zoneId;
  loadSceneDraft();
  renderSceneEditor();
  $('master-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function applyScene(draft, clear = false) {
  const ok = await rpc('set_environment', {
    p_zone_id: sceneDest === 'room' ? null : sceneDest,
    p_scene_media_id: draft.visualId,
    p_ambient_youtube: null, // a música agora fica no mixer (aba Música)
    p_caption: draft.caption,
    p_ambient_volume: draft.volume,
  });
  if (ok) {
    toast(clear ? 'Cena limpa.' : 'Cena aplicada.');
    scheduleRefresh();
    if (clear) setTimeout(() => {
      loadSceneDraft();
      renderSceneEditor();
    }, 400);
  }
}

async function uploadFiles(files) {
  const status = $('upload-status');
  let done = 0;
  for (const file of files) {
    const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : null;
    if (!kind) {
      toast(`"${file.name}" não é imagem, vídeo nem áudio.`);
      continue;
    }
    if (file.size > 50 * 1024 * 1024) {
      toast(`"${file.name}" passa de 50 MB.`);
      continue;
    }
    status.textContent = `Enviando ${file.name}…`;
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
    const path = `${roomId}/${crypto.randomUUID()}.${ext}`;
    const { error: upError } = await supabase.storage.from('midia').upload(path, file, { contentType: file.type, upsert: false });
    if (upError) {
      toast(friendlyError(upError));
      continue;
    }
    const name = file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'arquivo';
    const { error } = await supabase.from('room_media').insert({ room_id: roomId, kind, name, storage_path: path });
    if (error) {
      await supabase.storage.from('midia').remove([path]);
      toast(friendlyError(error));
      continue;
    }
    done += 1;
  }
  status.textContent = done ? `${done} ${done === 1 ? 'arquivo enviado' : 'arquivos enviados'}.` : 'Imagens (ou vídeos) dos ambientes, até 50 MB.';
  scheduleRefresh();
}

// ---------------------------------------------------------------------------
// Sussurro do jogador para o mestre (segurar botão ou tecla V)
// ---------------------------------------------------------------------------

function setupPlayerControls() {
  $('whisper-btn').onclick = () => {
    const me = playerById(user.id);
    if (!inCall || !me || me.whisperToMaster) return;
    rpc('request_whisper', { p_active: !me.whisperRequested });
  };

  const vol = $('player-scene-volume');
  vol.value = playerSceneVolume;
  vol.oninput = () => {
    playerSceneVolume = Number(vol.value);
    store('rpg-scene-volume', playerSceneVolume);
    updateStage();
    applyAllRouting();
    syncMusic();
  };
}

// ---------------------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------------------

function personHtml({ userId, displayName, online: isOnline, muted: isMuted, whisperToMaster, whisperRequested, mutedByMaster, master, zoneId }) {
  const me = userId === user.id;
  const draggable = isMaster && !master;
  const zoneOptions =
    draggable && state.zones.length > 1
      ? `<select data-move="${escapeHtml(userId)}" title="Mover para">${state.zones
          .map((z) => `<option value="${z.id}" ${z.id === zoneId ? 'selected' : ''}>${escapeHtml(z.name)}</option>`)
          .join('')}</select>`
      : '';
  const whisperBtn =
    isMaster && !master && isOnline
      ? whisperToMaster
        ? `<button class="sm icon-only whisper-active" data-action="whisper-end" data-user="${escapeHtml(userId)}" title="Encerrar sussurro com ${escapeHtml(displayName)}">${icon('whisper', 15)}</button>`
        : `<button class="sm icon-only ${whisperRequested ? 'whisper-active' : ''}" data-action="whisper-start" data-user="${escapeHtml(userId)}" title="${whisperRequested ? 'Aceitar pedido de' : 'Iniciar sussurro com'} ${escapeHtml(displayName)}">${icon('whisper', 15)}</button>`
      : '';
  const name = escapeHtml(displayName);
  // Mestre: silenciar e remover jogadores
  const canMute = db.members.some((m) => 'muted_by_master' in m); // existe depois da migração 17
  const masterBtns =
    isMaster && !master
      ? `${canMute ? `<button class="sm icon-only ${mutedByMaster ? 'whisper-active' : ''}" data-action="mute" data-user="${escapeHtml(userId)}" data-muted="${mutedByMaster ? 1 : 0}" title="${mutedByMaster ? `Deixar ${name} falar de novo` : `Silenciar ${name} para todos`}">${icon(mutedByMaster ? 'micOff' : 'mic', 15)}</button>` : ''}
         <button class="sm icon-only danger" data-action="kick" data-user="${escapeHtml(userId)}" title="Remover ${name} da sala">${icon('logout', 15)}</button>`
      : '';
  // Qualquer um: volume de cada pessoa só para si
  const volume =
    !me && isOnline
      ? `<span class="pvol" title="Volume de ${name} para você">${icon('volume', 13)}<input type="range" min="0" max="1" step="0.05" value="${personVolume(userId)}" data-pvol="${escapeHtml(userId)}" aria-label="Volume de ${name}"></span>`
      : '';
  const sub = master ? (isOnline ? 'Na call' : 'Fora da call') : isOnline ? 'Na call' : 'Fora da call';
  return `
    <div class="person ${isOnline ? '' : 'offline'} ${master ? 'master' : ''} ${me ? 'me' : ''} ${speaking.has(userId) ? 'speaking' : ''}"
         data-user="${escapeHtml(userId)}" ${draggable ? 'draggable="true"' : ''}>
      <div class="avatar">${escapeHtml(initials(displayName))}</div>
      <div class="info">
        ${master ? '<div class="role">Mestre</div>' : ''}
        <div class="name">${escapeHtml(displayName)}${me ? ' <span class="muted">(você)</span>' : ''}</div>
        <div class="sub">${sub}</div>
      </div>
      <div class="badges">
        ${mutedByMaster ? '<span class="tag danger" title="O mestre silenciou este jogador">silenciado</span>' : isMuted ? `<span title="Microfone desligado">${icon('micOff', 15)}</span>` : ''}
        ${whisperToMaster && isOnline ? '<span class="tag whisper">em sussurro</span>' : ''}
        ${whisperRequested && !whisperToMaster && isOnline ? '<span class="tag accent">pediu sussurro</span>' : ''}
      </div>
      ${zoneOptions || whisperBtn || masterBtns || volume ? `<div class="controls">${volume}${zoneOptions}${whisperBtn}${masterBtns}</div>` : ''}
    </div>`;
}

const isWhisperTarget = (userId) => state.masterTarget && state.masterTarget.type === 'player' && state.masterTarget.userId === userId;
const isZoneTarget = (zoneId) => state.masterTarget && state.masterTarget.type === 'zone' && state.masterTarget.zoneId === zoneId;

function sceneSummary(zone) {
  const scene = effectiveScene(db.room, zone);
  const playing = tracksForZone(db.tracks, zone ? zone.id : null).filter((t) => t.status === 'playing');
  if (!scene && !playing.length) return '<span class="muted">Sem cena</span>';
  const visual = scene && scene.visualId && mediaById(scene.visualId);
  const parts = [];
  if (visual) parts.push(`<span>${icon(visual.kind === 'video' ? 'film' : 'image', 13)}${escapeHtml(visual.name)}</span>`);
  if (playing.length) parts.push(`<span>${icon('music', 13)}${escapeHtml(playing.map((t) => t.title || 'Música').join(' · ').slice(0, 60))}</span>`);
  if (scene && !visual && scene.caption) parts.push(`<span>“${escapeHtml(scene.caption.slice(0, 40))}”</span>`);
  if (scene && scene.from === 'room') parts.push('<span class="muted">(cena padrão)</span>');
  return parts.join('');
}

function render() {
  if (!state) return;
  const myZone = myZoneId();

  $('master-row').innerHTML = personHtml({ ...state.master, master: true });

  // Jogador só vê o ambiente em que está; o mestre vê todos
  $('zones').innerHTML = (isMaster ? state.zones : state.zones.filter((z) => z.id === myZone))
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
                  <button class="sm quiet icon-only" data-action="edit-scene" data-zone="${zone.id}" title="Editar cena deste ambiente">${icon('image', 15)}</button>
                  <button class="sm quiet icon-only" data-action="rename" data-zone="${zone.id}" title="Renomear">${icon('pencil', 15)}</button>
                  ${state.zones.length > 1 ? `<button class="sm quiet icon-only" data-action="delete" data-zone="${zone.id}" title="Excluir">${icon('trash', 15)}</button>` : ''}
                </div>`
              : zone.id === myZone
                ? '<span class="tag accent">Você está aqui</span>'
                : ''
          }
        </div>
        ${isMaster ? `<div class="zone-scene">${sceneSummary(zone)}</div>` : ''}
        <div class="zone-players">
          ${members.length ? members.map((p) => personHtml(p)).join('') : '<div class="hint" style="padding:0.25rem 0.5rem">Ninguém aqui.</div>'}
        </div>
        ${
          isMaster
            ? `<div class="zone-foot">
                <button class="sm ${isZoneTarget(zone.id) ? 'active' : ''}" data-action="narrate" data-zone="${zone.id}">${icon('broadcast', 15)}Narrar só para este ambiente</button>
                <div class="vol" title="Quanto você ouve deste ambiente">${icon('volume', 15)}<input type="range" min="0" max="1" step="0.05" value="${vol}" data-volume="${zone.id}"></div>
              </div>`
            : ''
        }
      </div>`;
    })
    .join('');

  renderTalkStatus(myZone);
  if (isMaster) {
    renderTargets();
    renderShareControls();
    renderSceneEditor();
    renderSfx();
    renderMixer();
    syncMusic();
    renderDice();
  } else {
    renderHearing();
    renderPlayerWhisper();
    renderMasterMute();
    renderDice();
  }
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
    if (!target || target.type === 'all') value = 'Todos';
    else if (target.type === 'zone') {
      value = zoneById(target.zoneId).name;
      hint = 'Os outros ambientes continuam conversando entre si, sem ouvir você.';
    } else {
      value = nameOf(target.userId);
      hint = 'Sussurro: só este jogador ouve você.';
      whisper = true;
    }
  } else {
    label = 'O mestre está falando com';
    const zoneName = myZone != null && zoneById(myZone) ? zoneById(myZone).name : '—';
    if (!state.master.online) value = 'Mestre fora da call';
    else if (!target) {
      value = 'Outro ambiente';
      hint = 'Você não está ouvindo o mestre agora.';
    } else if (target.type === 'all') value = 'Todos';
    else if (target.type === 'zone') value = 'Seu ambiente';
    else {
      value = 'Você, em particular';
      whisper = true;
    }
    const me = playerById(user.id);
    if (me && me.whisperToMaster) {
      label = 'Conversa particular';
      value = 'Você e o mestre';
      hint = 'Só o mestre ouve você.';
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
  const btn = (target, text, active, extra = '', cls = 'active') =>
    `<button class="sm ${active ? cls : ''}" data-target='${escapeHtml(JSON.stringify(target))}'>${text}${extra}</button>`;
  const onlinePlayers = state.players.filter((p) => p.online);
  $('targets').innerHTML = [
    btn({ type: 'all' }, `${icon('broadcast', 15)}Todos`, t.type === 'all'),
    '<p class="eyebrow group-label">Ambientes</p>',
    ...state.zones.map((z) => {
      const count = onlinePlayers.filter((p) => p.zoneId === z.id).length;
      return btn({ type: 'zone', zoneId: z.id }, escapeHtml(z.name), isZoneTarget(z.id), `<span class="count">${count}</span>`);
    }),
    '<p class="eyebrow group-label">Sussurro</p>',
    ...(onlinePlayers.length
      ? onlinePlayers
          .slice()
          .sort((a, b) => Number(b.whisperRequested) - Number(a.whisperRequested))
          .map((p) => {
            const name = escapeHtml(p.displayName);
            if (p.whisperToMaster) {
              return `<button class="sm whisper-active" data-whisper-end="${escapeHtml(p.userId)}">${icon('whisper', 15)}${name}<span class="count">Encerrar</span></button>`;
            }
            if (p.whisperRequested) {
              return `<div class="request"><span>${icon('whisper', 15)}${name} pediu para falar</span>
                <span class="inline"><button class="sm primary" data-whisper-start="${escapeHtml(p.userId)}">Aceitar</button><button class="sm" data-whisper-end="${escapeHtml(p.userId)}">Recusar</button></span></div>`;
            }
            return `<button class="sm" data-whisper-start="${escapeHtml(p.userId)}">${icon('whisper', 15)}${name}<span class="count">Sussurrar</span></button>`;
          })
      : ['<div class="hint">Nenhum jogador na call.</div>']),
  ].join('');
}

function renderShareControls() {
  if (!isMaster || !state) return;
  $('share-target').innerHTML = targetOptions(shareTarget);
  const btn = $('share-btn');
  btn.classList.toggle('active', Boolean(screenTrack));
  btn.lastElementChild.textContent = screenTrack ? 'Parar compartilhamento' : 'Compartilhar tela';
  btn.disabled = !inCall;
}

function renderSceneEditor() {
  if (!isMaster || !state) return;
  // Ambiente recém-criado pelo botão "Novo ambiente": já abre a cena dele
  if (pendingSceneZone) {
    const created = db.zones.filter((z) => z.name === pendingSceneZone).sort((x, y) => y.id - x.id)[0];
    if (created) {
      pendingSceneZone = null;
      sceneDest = created.id;
      loadSceneDraft();
    }
  }
  if (!sceneDraft || (sceneDest !== 'room' && !db.zones.some((z) => z.id === sceneDest))) {
    sceneDest = sceneDest !== 'room' && db.zones.some((z) => z.id === sceneDest) ? sceneDest : 'room';
    loadSceneDraft();
  }
  $('scene-dest').innerHTML = [
    `<option value="room" ${sceneDest === 'room' ? 'selected' : ''}>Cena padrão (quem estiver em ambiente sem cena)</option>`,
    ...state.zones.map((z) => `<option value="${z.id}" ${sceneDest === z.id ? 'selected' : ''}>${escapeHtml(z.name)}</option>`),
  ].join('');

  const visuals = db.media.filter((m) => m.kind === 'image' || m.kind === 'video');
  $('scene-visuals').innerHTML = [
    `<button class="thumb ${sceneDraft.visualId == null ? 'selected' : ''}" data-visual="none" title="Sem imagem">Nenhuma</button>`,
    ...visuals.map((m) => {
      const url = mediaUrl(m.id);
      const inner = !url ? escapeHtml(m.name) : m.kind === 'video' ? `<video src="${escapeHtml(url)}#t=0.5" muted preload="metadata"></video>` : `<img src="${escapeHtml(url)}" alt="" loading="lazy">`;
      return `<button class="thumb ${sceneDraft.visualId === m.id ? 'selected' : ''}" data-visual="${m.id}" title="${escapeHtml(m.name)}">${inner}${m.kind === 'video' ? `<span class="kind">${icon('film', 12)}</span>` : ''}</button>`;
    }),
  ].join('');

  $('media-list').innerHTML = db.media.length
    ? db.media
        .map(
          (m) => `<div class="media-item">${icon(m.kind === 'audio' ? 'music' : m.kind === 'video' ? 'film' : 'image', 15)}<span class="name" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</span>
            <button class="sm quiet icon-only" data-delete-media="${m.id}" title="Remover">${icon('trash', 14)}</button></div>`,
        )
        .join('')
    : '<div class="hint">A biblioteca está vazia.</div>';
}

// ---------------------------------------------------------------------------
// Mixer de música (mestre)
// ---------------------------------------------------------------------------

let musicDest = 'room'; // 'room' (cena padrão) ou id do ambiente
let musicMonitor = readStored('rpg-music-monitor', false);
let mixerPending = false; // re-render adiado enquanto o mestre arrasta um volume

function mixerTracks() {
  return tracksForDest(db.tracks, musicDest);
}

function musicControl(trackId, action, value) {
  return supabase.rpc('music_control', { p_track_id: trackId, p_action: action, p_value: value === undefined ? null : value }).then(({ error }) => {
    if (error) toast(friendlyError(error));
    scheduleTracks();
    return !error;
  });
}

function trackTimeText(t) {
  const now = serverNow();
  const pos = trackPosition(t, now);
  return t.duration_s ? `${formatTime(pos)} / ${formatTime(t.duration_s)}` : formatTime(pos);
}

function renderMixer() {
  if (!isMaster || !db) return;
  if (musicDest !== 'room' && !db.zones.some((z) => z.id === musicDest)) musicDest = 'room';
  const count = (dest) => tracksForDest(db.tracks, dest).filter((t) => t.status === 'playing').length;
  const label = (name, dest) => `${escapeHtml(name)}${count(dest) ? ` (${count(dest)} tocando)` : ''}`;
  $('music-dest').innerHTML = [
    `<option value="room" ${musicDest === 'room' ? 'selected' : ''}>${label('Cena padrão', 'room')}</option>`,
    ...db.zones.map((z) => `<option value="${z.id}" ${musicDest === z.id ? 'selected' : ''}>${label(z.name, z.id)}</option>`),
  ].join('');
  $('mixer-monitor').checked = musicMonitor;

  const mixer = $('mixer');
  if (mixer.contains(document.activeElement) && document.activeElement.type === 'range') {
    mixerPending = true;
    return;
  }
  mixerPending = false;
  const list = mixerTracks();
  if (!list.length) {
    mixer.innerHTML = '<div class="hint mixer-empty">Nenhuma faixa aqui. Cole um link do YouTube acima.</div>';
    return;
  }
  mixer.innerHTML = list
    .map((t, i) => {
      const playing = t.status === 'playing' && !trackEnded(t, serverNow());
      const pct = t.duration_s ? Math.min(100, (trackPosition(t, serverNow()) / t.duration_s) * 100) : 0;
      const isList = (parseYouTube(t.youtube) || {}).listId && !(parseYouTube(t.youtube) || {}).videoId;
      return `<div class="track ${playing ? 'playing' : t.status}" data-track="${t.id}">
        <div class="track-top">
          <button class="track-play icon-only" data-mix="toggle" title="${playing ? 'Pausar' : 'Tocar'}">${icon(playing ? 'pause' : 'play', 16)}</button>
          <div class="track-info">
            <span class="track-title" title="${escapeHtml(t.youtube)}">${escapeHtml(t.title || `Faixa ${i + 1}`)}</span>
            <span class="track-time mono" data-time>${isList ? 'Playlist' : trackTimeText(t)}</span>
          </div>
          <button class="sm quiet icon-only" data-mix="stop" title="Parar e voltar ao início" ${t.status === 'stopped' ? 'disabled' : ''}>${icon('stop', 14)}</button>
          ${i < list.length - 1 ? `<button class="sm quiet icon-only" data-mix="next" title="Ir para a próxima faixa">${icon('next', 14)}</button>` : ''}
        </div>
        ${t.duration_s && !isList
          ? `<input type="range" class="track-seek" min="0" max="${Math.floor(t.duration_s)}" step="1" value="${Math.floor(trackPosition(t, serverNow()))}" data-mix-seek title="Arraste para escolher a minutagem" style="--pct:${pct}%">`
          : `<div class="track-bar" title="A minutagem fica disponível depois que a faixa tocar uma vez"><span data-bar style="width:${pct}%"></span></div>`}
        <div class="track-controls">
          <button class="chip-toggle ${t.loop ? 'on' : ''}" data-mix="loop" title="Repetir esta faixa sem parar">${icon('repeat', 13)}Repetir</button>
          <button class="chip-toggle ${t.chain && !t.loop ? 'on' : ''}" data-mix="chain" title="Ao terminar, tocar a faixa de baixo" ${t.loop ? 'disabled' : ''}>${icon('next', 13)}Depois</button>
          <span class="track-vol" title="Volume desta faixa">${icon('volume', 14)}<input type="range" min="0" max="1" step="0.05" value="${t.volume}" data-mix-volume></span>
          <span class="track-order">
            <button class="sm quiet icon-only" data-mix="up" title="Subir" ${i === 0 ? 'disabled' : ''}>${icon('up', 14)}</button>
            <button class="sm quiet icon-only" data-mix="down" title="Descer" ${i === list.length - 1 ? 'disabled' : ''}>${icon('down', 14)}</button>
            <button class="sm quiet icon-only" data-mix="remove" title="Remover faixa">${icon('trash', 14)}</button>
          </span>
        </div>
      </div>`;
    })
    .join('');
}

/** Atualiza só tempo e barra (a cada segundo), sem redesenhar o mixer. */
function updateMixerProgress() {
  if (!isMaster || !db) return;
  const now = serverNow();
  for (const row of document.querySelectorAll('#mixer .track')) {
    const t = db.tracks.find((x) => x.id === Number(row.dataset.track));
    if (!t || t.status !== 'playing') continue;
    const time = row.querySelector('[data-time]');
    if (time && time.textContent !== 'Playlist') time.textContent = trackTimeText(t);
    const bar = row.querySelector('[data-bar]');
    if (bar && t.duration_s) bar.style.width = `${Math.min(100, (trackPosition(t, now) / t.duration_s) * 100)}%`;
    const seek = row.querySelector('[data-mix-seek]');
    if (seek && seek !== document.activeElement && t.duration_s) {
      seek.value = Math.floor(trackPosition(t, now));
      seek.style.setProperty('--pct', `${Math.min(100, (trackPosition(t, now) / t.duration_s) * 100)}%`);
    }
  }
}

function setupMixerControls() {
  $('music-dest').onchange = (e) => {
    musicDest = e.target.value === 'room' ? 'room' : Number(e.target.value);
    renderMixer();
    syncMusic();
  };
  $('track-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = $('track-url').value.trim();
    if (!parseYouTube(url)) return toast('Cole um link válido do YouTube (vídeo ou playlist).');
    const { error } = await supabase.rpc('add_track', {
      p_room_id: roomId,
      p_zone_id: musicDest === 'room' ? null : musicDest,
      p_youtube: url,
      p_title: $('track-title').value.trim(),
    });
    if (error) return toast(friendlyError(error));
    $('track-url').value = '';
    $('track-title').value = '';
    scheduleTracks();
  });
  $('mixer').onclick = async (e) => {
    const btn = e.target.closest('button[data-mix]');
    if (!btn) return;
    const id = Number(btn.closest('[data-track]').dataset.track);
    const t = db.tracks.find((x) => x.id === id);
    if (!t) return;
    const action = btn.dataset.mix;
    if (action === 'toggle') {
      const playing = t.status === 'playing' && !trackEnded(t, serverNow());
      return musicControl(id, playing ? 'pause' : trackEnded(t, serverNow()) ? 'restart' : 'play');
    }
    if (action === 'next') {
      const list = mixerTracks();
      const next = list[list.findIndex((x) => x.id === id) + 1];
      await musicControl(id, 'stop');
      if (next) musicControl(next.id, 'restart');
      return;
    }
    if (action === 'remove' && !confirm(`Remover "${t.title || 'esta faixa'}" do mixer?`)) return;
    musicControl(id, action);
  };
  let volTimer = null;
  $('mixer').oninput = (e) => {
    if (e.target.matches('[data-mix-seek]')) {
      // Mostra a minutagem enquanto arrasta; envia ao soltar
      const t = db.tracks.find((x) => x.id === Number(e.target.closest('[data-track]').dataset.track));
      const time = e.target.closest('.track').querySelector('[data-time]');
      if (t && time) time.textContent = `${formatTime(e.target.value)} / ${formatTime(t.duration_s)}`;
      e.target.style.setProperty('--pct', `${(e.target.value / e.target.max) * 100}%`);
      return;
    }
    if (!e.target.matches('[data-mix-volume]')) return;
    const id = Number(e.target.closest('[data-track]').dataset.track);
    const value = Number(e.target.value);
    const t = db.tracks.find((x) => x.id === id);
    if (t) t.volume = value; // aplica na hora para quem está ouvindo aqui
    syncMusic();
    clearTimeout(volTimer);
    volTimer = setTimeout(() => musicControl(id, 'volume', value), 250);
  };
  $('mixer').onchange = (e) => {
    if (e.target.matches('[data-mix-seek]')) {
      const id = Number(e.target.closest('[data-track]').dataset.track);
      const value = Number(e.target.value);
      const t = db.tracks.find((x) => x.id === id);
      // Aplica na hora para quem ouve aqui; o banco avisa os jogadores
      if (t) {
        t.offset_s = value;
        if (t.status === 'playing') t.started_at = new Date(serverNow()).toISOString();
        else if (t.status === 'stopped') t.status = 'paused';
      }
      e.target.blur();
      syncMusic();
      musicControl(id, 'seek', value);
      return;
    }
    if (!e.target.matches('[data-mix-volume]')) return;
    e.target.blur();
    if (mixerPending) setTimeout(renderMixer, 300);
  };
  $('mixer-pause-all').onclick = () => {
    const playing = mixerTracks().filter((t) => t.status === 'playing');
    if (!playing.length) return toast('Nada tocando aqui.');
    playing.forEach((t) => musicControl(t.id, 'pause'));
  };
  $('mixer-monitor').onchange = (e) => {
    musicMonitor = e.target.checked;
    store('rpg-music-monitor', musicMonitor);
    if (musicMonitor && !inCall) toast('Entre na call para ouvir.');
    syncMusic();
  };
}

function renderSfx() {
  $('sfx-target').innerHTML = targetOptions(sfxTarget, { players: true });
  const audios = db.media.filter((m) => m.kind === 'audio');
  $('sfx-grid').innerHTML = audios.length
    ? audios.map((m) => `<button class="sm" data-sfx="${m.id}" title="${escapeHtml(m.name)}">${icon('play', 13)}<span>${escapeHtml(m.name)}</span></button>`).join('')
    : '<div class="hint" style="grid-column:1/-1">Nenhum áudio na biblioteca.</div>';
}

function renderPlayerWhisper() {
  const me = playerById(user.id);
  const btn = $('whisper-btn');
  const label = btn.lastElementChild;
  const hint = $('whisper-hint');
  btn.classList.remove('holding', 'active');
  btn.disabled = !inCall || !state.master.online;
  if (me && me.whisperToMaster) {
    btn.classList.add('holding');
    btn.disabled = true;
    label.textContent = 'Em conversa particular';
    hint.textContent = 'Só o mestre ouve você. O mestre encerra a conversa.';
  } else if (me && me.whisperRequested) {
    btn.classList.add('active');
    label.textContent = 'Cancelar pedido';
    hint.textContent = 'Pedido enviado. Aguardando o mestre aceitar.';
  } else {
    label.textContent = 'Pedir para falar com o mestre';
    hint.textContent = !state.master.online ? 'O mestre não está na call.' : 'O mestre decide quando a conversa começa e termina.';
  }
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
    $('copy-invite').onclick = () => navigator.clipboard.writeText(inviteCode).then(() => toast('Código copiado.'));
  }
  $(isMaster ? 'master-panel' : 'player-panel').classList.remove('hidden');
  // Toda sala é excluída 8 h depois de criada: mostra quanto falta e avisa perto do fim
  const expiresAt = Date.parse(db.room.expires_at);
  let warnedExpiry = false;
  const updateExpiry = () => {
    const min = Math.ceil((expiresAt - Date.now()) / 60000);
    const el = $('expires-tag');
    el.classList.toggle('hidden', !(min > 0));
    el.textContent = min > 60 ? `Expira em ${Math.floor(min / 60)}h ${min % 60}min` : `Expira em ${Math.max(0, min)} min`;
    el.classList.toggle('accent', min <= 30);
    if (min <= 15 && min > 0 && !warnedExpiry) {
      warnedExpiry = true;
      toast(`Esta sala será excluída em ${min} min.`, 8000);
    }
  };
  if (expiresAt) {
    updateExpiry();
    setInterval(updateExpiry, 30000);
  }
  setupDiceControls();
  loadRolls();
  if (isMaster) {
    setupMasterControls();
    setupMixerControls();
  }
  else setupPlayerControls();
  $('join-btn').onclick = startCall;
  recompute();
}
