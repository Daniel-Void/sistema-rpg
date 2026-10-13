import { supabase, currentUser, escapeHtml, friendlyError, initials, toast } from './supabase.js';
import { ICE_SERVERS } from './config.js';
import { computeRouting, normalizeMasterTarget } from './audioRules.js';
import { effectiveScene, parseYouTube, targetIncludes } from './sceneRules.js';
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

async function loadData() {
  const [roomRes, zonesRes, membersRes, mediaRes] = await Promise.all([
    supabase
      .from('rooms')
      .select(`id, name, description, master_id, master_target, ${SCENE_COLS}, master:profiles!rooms_master_id_fkey(display_name), room_invites(code)`)
      .eq('id', roomId)
      .maybeSingle(),
    supabase.from('zones').select(`id, name, position, ${SCENE_COLS}`).eq('room_id', roomId).eq('archived', false).order('position').order('id'),
    supabase.from('room_members').select('user_id, zone_id, whisper_to_master, whisper_requested, profile:profiles(display_name)').eq('room_id', roomId),
    supabase.from('room_media').select('id, kind, name, storage_path, created_at').eq('room_id', roomId).order('created_at'),
  ]);
  const error = roomRes.error || zonesRes.error || membersRes.error || mediaRes.error;
  if (error) throw error;
  if (!roomRes.data) return null;
  await signMediaUrls(mediaRes.data);
  return { room: roomRes.data, zones: zonesRes.data, members: membersRes.data, media: mediaRes.data };
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

function connectRealtime() {
  return new Promise((resolve, reject) => {
    channel = supabase.channel(`room:${roomId}`, { config: { private: true, presence: { key: sessionId } } });
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
      .on('presence', { event: 'sync' }, onPresenceSync)
      .subscribe(async (status, err) => {
        if (status === 'SUBSCRIBED') {
          await trackPresence();
          scheduleRefresh(); // pega qualquer mudança que aconteceu enquanto conectava
          scheduleRolls();
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
    audioTx: null,
    videoTx: null,
    videoTrack: null,
    seq: 0,
    lastSeq: 0,
    queue: Promise.resolve(),
  };
  peers.set(peerId, peer);

  if (initiator) {
    peer.audioTx = pc.addTransceiver('audio', { direction: 'sendrecv' });
    peer.videoTx = pc.addTransceiver('video', { direction: 'sendrecv' });
  }

  pc.ontrack = ({ track, transceiver }) => {
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
    for (const t of pc.getTransceivers()) {
      const kind = t.receiver.track.kind;
      if (kind === 'audio' && !peer.audioTx) peer.audioTx = t;
      if (kind === 'video' && !peer.videoTx) peer.videoTx = t;
      t.direction = 'sendrecv';
    }
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
  await replace(peer.videoTx && peer.videoTx.sender, isMaster && screenTrack && shareIncludes(peer.id) ? screenTrack : null);
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
// Compartilhamento de tela (mestre)
// ---------------------------------------------------------------------------

async function startShare() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
    screenTrack = stream.getVideoTracks()[0];
    screenTrack.contentHint = 'detail';
    screenTrack.onended = stopShare;
  } catch (err) {
    if (err && err.name !== 'NotAllowedError') toast('Não foi possível compartilhar a tela.');
    return;
  }
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
  screenTrack = null;
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
    label = `Você está compartilhando a tela com ${targetName(shareTarget)}`;
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

  updateMusic(scene);
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

// ----- Música do ambiente (YouTube) -----

let ytApi = null;
let ytPlayer = null;
let musicKey = null;
let musicVolume = 60;
let musicMuted = readStored('rpg-music-muted', false);
let musicCheck = null;

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

function applyMusicVolume() {
  if (!ytPlayer || !ytPlayer.setVolume) return;
  if (musicMuted) ytPlayer.mute();
  else {
    ytPlayer.unMute();
    ytPlayer.setVolume(musicVolume);
  }
  $('music-toggle').innerHTML = icon(musicMuted ? 'volumeOff' : 'volume', 15);
  $('music-toggle').title = musicMuted ? 'Ativar música' : 'Silenciar música';
}

function setMusicBlocked(blocked) {
  if (blocked && !$('music-chip').classList.contains('blocked')) toast('Toque em "Toque para ativar a música" para ouvir o ambiente.', 5000);
  $('music-chip').classList.toggle('blocked', blocked);
  $('music-label').textContent = blocked ? 'Toque para ativar a música' : 'Música ambiente';
}

function destroyMusic() {
  clearTimeout(musicCheck);
  if (ytPlayer && ytPlayer.destroy) ytPlayer.destroy();
  ytPlayer = null;
  $('yt-holder').innerHTML = '<div id="yt-player"></div>';
}

async function updateMusic(scene) {
  const parsed = inCall && scene && scene.youtube ? parseYouTube(scene.youtube) : null;
  const key = parsed ? `${parsed.videoId}|${parsed.listId}` : null;
  musicVolume = Math.round(Math.min(1, (scene ? scene.volume : 0.6) * playerSceneVolume) * 100);
  $('music-chip').classList.toggle('hidden', !key);
  applyMusicVolume();
  if (key === musicKey) return;
  musicKey = key;
  destroyMusic();
  if (!key) return;

  const YT = await loadYouTubeApi();
  if (musicKey !== key) return;
  const playerVars = { autoplay: 1, controls: 0, disablekb: 1, playsinline: 1, rel: 0, fs: 0, iv_load_policy: 3, loop: 1 };
  if (parsed.listId) Object.assign(playerVars, { listType: 'playlist', list: parsed.listId });
  else playerVars.playlist = parsed.videoId; // necessário para repetir um vídeo só
  ytPlayer = new YT.Player('yt-player', {
    width: 200,
    height: 113,
    videoId: parsed.videoId || undefined,
    playerVars,
    events: {
      onReady: (e) => {
        applyMusicVolume();
        e.target.playVideo();
        clearTimeout(musicCheck);
        musicCheck = setTimeout(() => {
          const st = ytPlayer && ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -1;
          if (st !== YT.PlayerState.PLAYING && st !== YT.PlayerState.BUFFERING) setMusicBlocked(true);
        }, 4000);
      },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.PLAYING) setMusicBlocked(false);
        if (e.data === YT.PlayerState.ENDED && !parsed.listId) {
          e.target.seekTo(0);
          e.target.playVideo();
        }
      },
      onError: (e) => {
        // 101/150: o dono do vídeo não permite tocar fora do YouTube
        $('music-label').textContent = e && (e.data === 101 || e.data === 150) ? 'Este vídeo não permite tocar aqui' : 'Música indisponível';
      },
    },
  });
}

$('music-toggle').onclick = (e) => {
  e.stopPropagation();
  musicMuted = !musicMuted;
  store('rpg-music-muted', musicMuted);
  applyMusicVolume();
};
$('music-chip').onclick = () => {
  if (!$('music-chip').classList.contains('blocked') || !ytPlayer) return;
  applyMusicVolume();
  ytPlayer.playVideo();
};

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

function nextReveal() {
  revealTimers.forEach(clearTimeout);
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
  el.innerHTML = `<div class="box">
      <div class="who">${escapeHtml(rollerName(r.roller_id))} ${r.roller_id === user.id ? 'rolou' : 'rolou'}</div>
      ${r.label ? `<div class="label">${escapeHtml(r.label)}</div>` : ''}
      <div class="total rolling">&nbsp;</div>
      <div class="expr">${escapeHtml(r.expression)}</div>
      <div class="detail" style="visibility:hidden">${diceDetailHtml(r.result, 120)}</div>
      ${r.visibility === 'secret' ? '<div class="secret-tag"><span class="tag whisper">Rolagem secreta</span></div>' : ''}
    </div>`;
  el.classList.remove('hidden');
  const totalEl = el.querySelector('.total');
  const range = diceRange(parseDice(r.expression)) || { min: 1, max: 20 };
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const land = () => {
    totalEl.textContent = r.total;
    totalEl.classList.remove('rolling');
    totalEl.classList.add('landed');
    el.querySelector('.detail').style.visibility = 'visible';
  };
  if (reduced) land();
  else {
    playDiceRattle();
    const started = Date.now();
    const spin = () => {
      if (Date.now() - started >= 900) return land();
      totalEl.textContent = Math.floor(range.min + Math.random() * (range.max - range.min + 1));
      revealTimers.push(setTimeout(spin, 55));
    };
    spin();
  }
  revealTimers.push(setTimeout(nextReveal, 5200));
}
$('dice-reveal').onclick = () => nextReveal();

/** Som curto de dados rolando, sintetizado (sem arquivo). */
function playDiceRattle() {
  if (!audioCtx || audioCtx.state === 'closed') return;
  try {
    const now = audioCtx.currentTime;
    for (let i = 0; i < 7; i++) {
      const t = now + i * 0.085 + Math.random() * 0.03;
      const len = Math.floor(audioCtx.sampleRate * 0.03);
      const buffer = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let j = 0; j < len; j++) data[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / len, 3);
      const src = audioCtx.createBufferSource();
      src.buffer = buffer;
      const filter = audioCtx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1800 + Math.random() * 1600;
      const gain = audioCtx.createGain();
      gain.gain.value = 0.25 * (1 - i / 9) * playerSceneVolume;
      src.connect(filter).connect(gain).connect(audioCtx.destination);
      src.start(t);
    }
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
  recompute();
}

function stopCall() {
  inCall = false;
  if (channel) {
    supabase.removeChannel(channel);
    channel = null;
  }
  if (screenTrack) screenTrack.stop();
  screenTrack = null;
  closeAllPeers();
  stopAllSfx();
  musicKey = null;
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
  $('scene-youtube').oninput = (e) => {
    sceneDraft.youtube = e.target.value.trim();
    renderYoutubeHint();
  };
  $('scene-volume').oninput = (e) => (sceneDraft.volume = Number(e.target.value));
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
  $('scene-youtube').value = sceneDraft.youtube;
  renderYoutubeHint();
  $('scene-volume').value = sceneDraft.volume;
}

function openSceneEditor(zoneId) {
  document.querySelector('[data-tab="cena"]').click();
  sceneDest = zoneId;
  loadSceneDraft();
  renderSceneEditor();
  $('master-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderYoutubeHint() {
  const value = $('scene-youtube').value.trim();
  const hint = $('scene-youtube-hint');
  if (!value) hint.textContent = 'Toca em loop para quem estiver no ambiente. Aceita vídeo ou playlist.';
  else if (parseYouTube(value)) hint.innerHTML = `Link reconhecido. <a href="${escapeHtml(value)}" target="_blank" rel="noopener noreferrer">Abrir no YouTube</a>`;
  else hint.textContent = 'Esse link não parece ser do YouTube.';
}

async function applyScene(draft, clear = false) {
  if (draft.youtube && !parseYouTube(draft.youtube)) return toast('Cole um link válido do YouTube.');
  const ok = await rpc('set_environment', {
    p_zone_id: sceneDest === 'room' ? null : sceneDest,
    p_scene_media_id: draft.visualId,
    p_ambient_youtube: draft.youtube || null,
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
  status.textContent = done ? `${done} ${done === 1 ? 'arquivo enviado' : 'arquivos enviados'}.` : 'Imagens dos ambientes e áudios de efeitos, até 50 MB.';
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
  };
}

// ---------------------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------------------

function personHtml({ userId, displayName, online: isOnline, muted: isMuted, whisperToMaster, whisperRequested, master, zoneId }) {
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
  const sub = master ? (isOnline ? 'Mestre, na call' : 'Mestre, fora da call') : isOnline ? 'Na call' : 'Fora da call';
  return `
    <div class="person ${isOnline ? '' : 'offline'} ${master ? 'master' : ''} ${me ? 'me' : ''} ${speaking.has(userId) ? 'speaking' : ''}"
         data-user="${escapeHtml(userId)}" ${draggable ? 'draggable="true"' : ''}>
      <div class="avatar">${escapeHtml(initials(displayName))}</div>
      <div class="info">
        <div class="name">${escapeHtml(displayName)}${me ? ' <span class="muted">(você)</span>' : ''}</div>
        <div class="sub">${sub}</div>
      </div>
      <div class="badges">
        ${isMuted ? `<span title="Microfone desligado">${icon('micOff', 15)}</span>` : ''}
        ${whisperToMaster && isOnline ? '<span class="tag whisper">em sussurro</span>' : ''}
        ${whisperRequested && !whisperToMaster && isOnline ? '<span class="tag accent">pediu sussurro</span>' : ''}
      </div>
      ${zoneOptions || whisperBtn ? `<div class="controls">${zoneOptions}${whisperBtn}</div>` : ''}
    </div>`;
}

const isWhisperTarget = (userId) => state.masterTarget && state.masterTarget.type === 'player' && state.masterTarget.userId === userId;
const isZoneTarget = (zoneId) => state.masterTarget && state.masterTarget.type === 'zone' && state.masterTarget.zoneId === zoneId;

function sceneSummary(zone) {
  const scene = effectiveScene(db.room, zone);
  if (!scene) return '<span class="muted">Sem cena</span>';
  const visual = scene.visualId && mediaById(scene.visualId);
  const parts = [];
  if (visual) parts.push(`<span>${icon(visual.kind === 'video' ? 'film' : 'image', 13)}${escapeHtml(visual.name)}</span>`);
  if (scene.youtube) parts.push(`<span>${icon('music', 13)}Música do YouTube</span>`);
  if (!visual && scene.caption) parts.push(`<span>“${escapeHtml(scene.caption.slice(0, 40))}”</span>`);
  if (scene.from === 'room') parts.push('<span class="muted">(cena padrão)</span>');
  return parts.join('');
}

function render() {
  if (!state) return;
  const myZone = myZoneId();

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
    renderDice();
  } else {
    renderHearing();
    renderPlayerWhisper();
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
  setupDiceControls();
  loadRolls();
  if (isMaster) setupMasterControls();
  else setupPlayerControls();
  $('join-btn').onclick = startCall;
  recompute();
}
