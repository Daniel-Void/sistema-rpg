const { COOKIE_NAME, parseCookies } = require('./auth');
const { computeRouting, normalizeMasterTarget } = require('./audioRules');

/**
 * Sessões de voz ao vivo.
 *
 * O áudio trafega direto entre os navegadores (WebRTC, malha P2P). O servidor
 * só faz a sinalização (troca de offers/answers/ICE) e decide, a cada mudança
 * de ambiente ou de alvo do mestre, para quem cada participante envia áudio.
 */
function createVoiceServer({ io, store, sessions }) {
  /** roomId -> { masterTarget, participants: Map<userId, participant> } */
  const live = new Map();

  io.use((socket, next) => {
    const userId = sessions.verifyToken(parseCookies(socket.handshake.headers.cookie)[COOKIE_NAME]);
    const user = userId && store.getUser(userId);
    if (!user) return next(new Error('unauthorized'));
    socket.data.user = user;
    next();
  });

  function liveRoom(roomId) {
    let room = live.get(roomId);
    if (!room) {
      room = { masterTarget: { type: 'all' }, participants: new Map() };
      live.set(roomId, room);
    }
    return room;
  }

  function broadcastState(roomId) {
    const room = live.get(roomId);
    if (!room) return;
    const zones = store.listZones(roomId);
    const zoneIds = zones.map((z) => z.id);
    const onlinePlayerIds = [...room.participants.values()].filter((p) => p.role === 'jogador').map((p) => p.userId);
    room.masterTarget = normalizeMasterTarget(room.masterTarget, { zoneIds, playerIds: onlinePlayerIds });

    const routing = computeRouting(room);
    const players = store.listMembers(roomId).map((m) => {
      const p = room.participants.get(m.id);
      return {
        userId: m.id,
        displayName: m.displayName,
        zoneId: m.zoneId,
        online: Boolean(p),
        muted: p ? p.muted : false,
        whisperToMaster: p ? p.whisperToMaster : false,
      };
    });
    const master = [...room.participants.values()].find((p) => p.role === 'mestre');

    for (const p of room.participants.values()) {
      const isMaster = p.role === 'mestre';
      const target = room.masterTarget;
      const masterSpeaksToMe = Boolean(master && routing[master.userId].sendTo.includes(p.userId));
      io.to(p.socketId).emit('state', {
        zones,
        players,
        master: master ? { userId: master.userId, displayName: master.displayName, muted: master.muted } : null,
        // Jogadores só ficam sabendo do alvo do mestre quando ele inclui eles.
        masterTarget: isMaster ? target : masterSpeaksToMe ? target : null,
        routing: routing[p.userId],
        allRouting: isMaster ? routing : undefined,
      });
    }
  }

  function leave(socket) {
    const { roomId, user } = socket.data;
    const room = roomId != null && live.get(roomId);
    if (!room) return;
    const p = room.participants.get(user.id);
    if (!p || p.socketId !== socket.id) return;
    room.participants.delete(user.id);
    socket.leave(`room:${roomId}`);
    socket.to(`room:${roomId}`).emit('peer-left', { userId: user.id });
    socket.data.roomId = null;
    if (room.participants.size === 0) live.delete(roomId);
    else broadcastState(roomId);
  }

  io.on('connection', (socket) => {
    const user = socket.data.user;
    const ctx = () => {
      const room = live.get(socket.data.roomId);
      const me = room && room.participants.get(user.id);
      return me && me.socketId === socket.id ? { roomId: socket.data.roomId, room, me } : null;
    };
    const masterCtx = () => {
      const c = ctx();
      return c && c.me.role === 'mestre' ? c : null;
    };

    socket.on('join', ({ roomId } = {}, ack = () => {}) => {
      roomId = Number(roomId);
      const info = store.getRoom(roomId);
      const isMaster = info && info.masterId === user.id;
      const membership = info && !isMaster && store.getMembership(roomId, user.id);
      if (!info || (!isMaster && !membership)) return ack({ error: 'Sala não encontrada.' });

      leave(socket);
      const room = liveRoom(roomId);
      const previous = room.participants.get(user.id);
      if (previous) {
        // Mesmo usuário abriu a sala em outra aba: derruba a conexão antiga.
        io.to(previous.socketId).emit('kicked', { reason: 'Você entrou nesta sala em outra aba.' });
        const oldSocket = io.sockets.sockets.get(previous.socketId);
        if (oldSocket) {
          oldSocket.leave(`room:${roomId}`);
          oldSocket.data.roomId = null;
        }
        room.participants.delete(user.id);
        socket.to(`room:${roomId}`).emit('peer-left', { userId: user.id });
      }

      const peers = [...room.participants.keys()];
      room.participants.set(user.id, {
        userId: user.id,
        displayName: user.displayName,
        role: isMaster ? 'mestre' : 'jogador',
        zoneId: isMaster ? null : membership.zoneId,
        whisperToMaster: false,
        muted: false,
        socketId: socket.id,
      });
      socket.data.roomId = roomId;
      socket.join(`room:${roomId}`);
      socket.to(`room:${roomId}`).emit('peer-joined', { userId: user.id });
      // Quem acabou de entrar é quem inicia as conexões com quem já estava.
      ack({ self: { userId: user.id, role: isMaster ? 'mestre' : 'jogador' }, peers });
      broadcastState(roomId);
    });

    socket.on('signal', ({ to, data } = {}) => {
      const c = ctx();
      const target = c && c.room.participants.get(Number(to));
      if (target) io.to(target.socketId).emit('signal', { from: user.id, data });
    });

    socket.on('mute', ({ muted } = {}) => {
      const c = ctx();
      if (!c) return;
      c.me.muted = Boolean(muted);
      broadcastState(c.roomId);
    });

    socket.on('player:whisper', ({ active } = {}) => {
      const c = ctx();
      if (!c || c.me.role !== 'jogador') return;
      c.me.whisperToMaster = Boolean(active);
      broadcastState(c.roomId);
    });

    socket.on('master:target', ({ target } = {}) => {
      const c = masterCtx();
      if (!c) return;
      c.room.masterTarget = {
        type: target && target.type,
        zoneId: target && Number(target.zoneId),
        userId: target && Number(target.userId),
      };
      broadcastState(c.roomId);
    });

    socket.on('master:move', ({ userId, zoneId } = {}) => {
      const c = masterCtx();
      if (!c) return;
      userId = Number(userId);
      zoneId = Number(zoneId);
      if (!store.listZones(c.roomId).some((z) => z.id === zoneId)) return;
      if (!store.getMembership(c.roomId, userId)) return;
      store.setMemberZone(c.roomId, userId, zoneId);
      const p = c.room.participants.get(userId);
      if (p) p.zoneId = zoneId;
      broadcastState(c.roomId);
    });

    socket.on('zone:create', ({ name } = {}) => {
      const c = masterCtx();
      const clean = typeof name === 'string' ? name.trim().slice(0, 40) : '';
      if (!c || !clean) return;
      store.createZone(c.roomId, clean);
      broadcastState(c.roomId);
    });

    socket.on('zone:rename', ({ zoneId, name } = {}) => {
      const c = masterCtx();
      const clean = typeof name === 'string' ? name.trim().slice(0, 40) : '';
      if (!c || !clean) return;
      store.renameZone(c.roomId, Number(zoneId), clean);
      broadcastState(c.roomId);
    });

    socket.on('zone:delete', ({ zoneId } = {}) => {
      const c = masterCtx();
      if (!c) return;
      zoneId = Number(zoneId);
      const zones = store.listZones(c.roomId);
      if (zones.length <= 1 || !zones.some((z) => z.id === zoneId)) return;
      const fallback = zones.find((z) => z.id !== zoneId);
      store.deleteZone(c.roomId, zoneId, fallback.id);
      for (const p of c.room.participants.values()) if (p.zoneId === zoneId) p.zoneId = fallback.id;
      broadcastState(c.roomId);
    });

    socket.on('leave', () => leave(socket));
    socket.on('disconnect', () => leave(socket));
  });

  return {
    onlineCount: (roomId) => (live.get(roomId) ? live.get(roomId).participants.size : 0),
    kick(roomId, userId) {
      const room = live.get(roomId);
      const p = room && room.participants.get(userId);
      if (!p) return;
      io.to(p.socketId).emit('kicked', { reason: 'Você foi removido da sala pelo mestre.' });
      const s = io.sockets.sockets.get(p.socketId);
      if (s) leave(s);
    },
    closeRoom(roomId) {
      const room = live.get(roomId);
      if (!room) return;
      io.to(`room:${roomId}`).emit('kicked', { reason: 'A sala foi encerrada pelo mestre.' });
      for (const p of [...room.participants.values()]) {
        const s = io.sockets.sockets.get(p.socketId);
        if (s) leave(s);
      }
      live.delete(roomId);
    },
  };
}

module.exports = { createVoiceServer };
