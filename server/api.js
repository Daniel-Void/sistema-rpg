const express = require('express');
const { COOKIE_NAME, hashPassword, verifyPassword, parseCookies, sessionCookie, clearedCookie } = require('./auth');

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function createApiRouter({ store, sessions, voice, secureCookies }) {
  const router = express.Router();
  router.use(express.json({ limit: '32kb' }));

  router.use((req, _res, next) => {
    const userId = sessions.verifyToken(parseCookies(req.headers.cookie)[COOKIE_NAME]);
    req.user = userId ? store.getUser(userId) : null;
    next();
  });

  const requireAuth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Faça login para continuar.' }));

  function login(res, user) {
    res.setHeader('Set-Cookie', sessionCookie(sessions.createToken(user.id), { secure: secureCookies }));
    res.json({ user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role } });
  }

  router.post('/register', (req, res) => {
    const username = text(req.body.username, 32);
    const displayName = text(req.body.displayName, 40) || username;
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const role = req.body.role;
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Usuário deve ter de 3 a 32 caracteres (letras, números, _ . -).' });
    if (password.length < 6) return res.status(400).json({ error: 'A senha precisa ter pelo menos 6 caracteres.' });
    if (role !== 'mestre' && role !== 'jogador') return res.status(400).json({ error: 'Escolha se você é mestre ou jogador.' });
    if (store.getUserWithPassword(username)) return res.status(409).json({ error: 'Esse nome de usuário já está em uso.' });
    login(res, store.createUser({ username, displayName, passwordHash: hashPassword(password), role }));
  });

  router.post('/login', (req, res) => {
    const user = store.getUserWithPassword(text(req.body.username, 32));
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!user || !verifyPassword(password, user.passwordHash)) return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
    login(res, user);
  });

  router.post('/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearedCookie());
    res.json({ ok: true });
  });

  router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

  router.get('/rooms', requireAuth, (req, res) => {
    const rooms = store.listRoomsForUser(req.user.id).map((room) => ({
      ...room,
      isMaster: room.masterId === req.user.id,
      online: voice.onlineCount(room.id),
    }));
    res.json({ rooms });
  });

  router.post('/rooms', requireAuth, (req, res) => {
    if (req.user.role !== 'mestre') return res.status(403).json({ error: 'Apenas mestres podem criar salas.' });
    const name = text(req.body.name, 60);
    if (!name) return res.status(400).json({ error: 'Dê um nome para a sala.' });
    const roomId = store.createRoom({ name, description: text(req.body.description, 500), masterId: req.user.id });
    res.status(201).json({ room: store.getRoom(roomId) });
  });

  router.post('/rooms/join', requireAuth, (req, res) => {
    const room = store.getRoomByCode(text(req.body.code, 16).toUpperCase());
    if (!room) return res.status(404).json({ error: 'Código de convite inválido.' });
    if (room.masterId !== req.user.id) store.addMember(room.id, req.user.id);
    res.json({ roomId: room.id });
  });

  function loadRoomFor(req, res) {
    const room = store.getRoom(Number(req.params.id));
    const allowed = room && (room.masterId === req.user.id || store.getMembership(room.id, req.user.id));
    if (!allowed) {
      res.status(404).json({ error: 'Sala não encontrada.' });
      return null;
    }
    return room;
  }

  router.get('/rooms/:id', requireAuth, (req, res) => {
    const room = loadRoomFor(req, res);
    if (!room) return;
    const isMaster = room.masterId === req.user.id;
    res.json({
      room: { ...room, inviteCode: isMaster ? room.inviteCode : undefined },
      isMaster,
      zones: store.listZones(room.id),
      players: store.listMembers(room.id),
    });
  });

  router.delete('/rooms/:id', requireAuth, (req, res) => {
    const room = loadRoomFor(req, res);
    if (!room) return;
    if (room.masterId !== req.user.id) return res.status(403).json({ error: 'Apenas o mestre pode excluir a sala.' });
    voice.closeRoom(room.id);
    store.deleteRoom(room.id);
    res.json({ ok: true });
  });

  router.delete('/rooms/:id/members/:userId', requireAuth, (req, res) => {
    const room = loadRoomFor(req, res);
    if (!room) return;
    const userId = Number(req.params.userId);
    const isMaster = room.masterId === req.user.id;
    if (!isMaster && userId !== req.user.id) return res.status(403).json({ error: 'Apenas o mestre pode remover jogadores.' });
    store.removeMember(room.id, userId);
    voice.kick(room.id, userId);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createApiRouter };
