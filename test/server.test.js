const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createServer } = require('../server/index');
const { openDatabase } = require('../server/db');

async function startServer() {
  const ctx = createServer({ db: openDatabase(':memory:'), secret: 'test-secret', iceServers: [] });
  await new Promise((resolve) => ctx.server.listen(0, resolve));
  const base = `http://localhost:${ctx.server.address().port}`;
  const sockets = [];

  async function request(path, { method = 'GET', body, cookie } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    return { status: res.status, data: await res.json(), cookie: setCookie && setCookie.split(';')[0] };
  }

  async function register(username, role) {
    const res = await request('/api/register', { method: 'POST', body: { username, password: 'segredo123', role, displayName: username } });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    return { cookie: res.cookie, user: res.data.user };
  }

  function socketFor(cookie) {
    const s = connect(base, { extraHeaders: { Cookie: cookie }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    s.on('state', (st) => (s.lastState = st));
    return s;
  }

  async function close() {
    sockets.forEach((s) => s.disconnect());
    ctx.io.close();
    await new Promise((resolve) => ctx.server.close(resolve));
  }

  return { request, register, socketFor, close };
}

const emit = (s, event, payload) => new Promise((resolve) => s.emit(event, payload, resolve));
/** Resolve com o estado mais recente (já recebido ou futuro) que satisfaz o predicado. */
const nextState = (s, predicate = () => true) =>
  new Promise((resolve, reject) => {
    if (s.lastState && predicate(s.lastState)) return resolve(s.lastState);
    const timer = setTimeout(() => reject(new Error('timeout esperando state')), 2000);
    const handler = (st) => {
      if (predicate(st)) {
        clearTimeout(timer);
        s.off('state', handler);
        resolve(st);
      }
    };
    s.on('state', handler);
  });

test('fluxo de contas e salas', async (t) => {
  const srv = await startServer();
  t.after(srv.close);

  const mestre = await srv.register('mestre1', 'mestre');
  const jogador = await srv.register('jogador1', 'jogador');

  assert.equal((await srv.request('/api/register', { method: 'POST', body: { username: 'MESTRE1', password: 'segredo123', role: 'mestre' } })).status, 409);
  assert.equal((await srv.request('/api/login', { method: 'POST', body: { username: 'mestre1', password: 'errada' } })).status, 401);
  assert.equal((await srv.request('/api/login', { method: 'POST', body: { username: 'mestre1', password: 'segredo123' } })).status, 200);
  assert.equal((await srv.request('/api/me')).status, 401);

  // jogador não pode criar sala
  assert.equal((await srv.request('/api/rooms', { method: 'POST', body: { name: 'X' }, cookie: jogador.cookie })).status, 403);

  const created = await srv.request('/api/rooms', { method: 'POST', body: { name: 'Mesa de teste' }, cookie: mestre.cookie });
  assert.equal(created.status, 201);
  const { id, inviteCode } = created.data.room;

  // jogador ainda não vê a sala
  assert.equal((await srv.request(`/api/rooms/${id}`, { cookie: jogador.cookie })).status, 404);
  assert.equal((await srv.request('/api/rooms/join', { method: 'POST', body: { code: 'NAOEXISTE' }, cookie: jogador.cookie })).status, 404);
  const joined = await srv.request('/api/rooms/join', { method: 'POST', body: { code: inviteCode.toLowerCase() }, cookie: jogador.cookie });
  assert.equal(joined.data.roomId, id);

  const asPlayer = await srv.request(`/api/rooms/${id}`, { cookie: jogador.cookie });
  assert.equal(asPlayer.data.isMaster, false);
  assert.equal(asPlayer.data.room.inviteCode, undefined, 'jogador não vê o código de convite');
  assert.equal(asPlayer.data.zones.length, 1);
  assert.equal(asPlayer.data.players[0].zoneId, asPlayer.data.zones[0].id);

  const list = await srv.request('/api/rooms', { cookie: jogador.cookie });
  assert.equal(list.data.rooms.length, 1);
  assert.equal(list.data.rooms[0].inviteCode, null);

  // jogador não pode excluir a sala; mestre pode
  assert.equal((await srv.request(`/api/rooms/${id}`, { method: 'DELETE', cookie: jogador.cookie })).status, 403);
  assert.equal((await srv.request(`/api/rooms/${id}`, { method: 'DELETE', cookie: mestre.cookie })).status, 200);
  assert.equal((await srv.request('/api/rooms', { cookie: jogador.cookie })).data.rooms.length, 0);
});

test('call: ambientes, narração por ambiente e sussurros', async (t) => {
  const srv = await startServer();
  t.after(srv.close);

  const mestre = await srv.register('mestre', 'mestre');
  const ana = await srv.register('ana', 'jogador');
  const beto = await srv.register('beto', 'jogador');
  const caio = await srv.register('caio', 'jogador');
  const { id: roomId, inviteCode } = (await srv.request('/api/rooms', { method: 'POST', body: { name: 'Mesa' }, cookie: mestre.cookie })).data.room;
  for (const p of [ana, beto, caio]) await srv.request('/api/rooms/join', { method: 'POST', body: { code: inviteCode }, cookie: p.cookie });

  // estranho não entra na call
  const estranho = await srv.register('estranho', 'jogador');
  assert.ok((await emit(srv.socketFor(estranho.cookie), 'join', { roomId })).error);

  const sm = srv.socketFor(mestre.cookie);
  const sa = srv.socketFor(ana.cookie);
  const sb = srv.socketFor(beto.cookie);
  const sc = srv.socketFor(caio.cookie);
  assert.deepEqual((await emit(sm, 'join', { roomId })).peers, []);
  assert.deepEqual((await emit(sa, 'join', { roomId })).peers, [mestre.user.id]);
  await emit(sb, 'join', { roomId });
  const ackC = await emit(sc, 'join', { roomId });
  assert.equal(ackC.peers.length, 3);

  // todos começam no mesmo ambiente: todo mundo ouve todo mundo
  let st = await nextState(sm, (s) => s.players.filter((p) => p.online).length === 3);
  assert.equal(st.routing.sendTo.length, 3);

  // mestre cria a Floresta e manda a Ana para lá
  sm.emit('zone:create', { name: 'Floresta' });
  st = await nextState(sm, (s) => s.zones.length === 2);
  const floresta = st.zones.find((z) => z.name === 'Floresta').id;
  sm.emit('master:move', { userId: ana.user.id, zoneId: floresta });
  const stBeto = await nextState(sb, (s) => s.players.find((p) => p.userId === ana.user.id).zoneId === floresta);
  assert.deepEqual(stBeto.routing.hearFrom.sort(), [mestre.user.id, caio.user.id].sort());

  // mestre narra só para a Floresta
  sm.emit('master:target', { target: { type: 'zone', zoneId: floresta } });
  const [stA, stB] = await Promise.all([
    nextState(sa, (s) => s.masterTarget && s.masterTarget.type === 'zone'),
    nextState(sb, (s) => s.masterTarget === null),
  ]);
  assert.deepEqual(stA.routing.hearFrom, [mestre.user.id]);
  assert.deepEqual(stB.routing.hearFrom, [caio.user.id], 'Beto segue ouvindo o Caio, mas não o mestre');
  assert.equal(stB.masterTarget, null, 'Beto não fica sabendo para onde o mestre está narrando');

  // sussurro do mestre para o Caio
  sm.emit('master:target', { target: { type: 'player', userId: caio.user.id } });
  const stC = await nextState(sc, (s) => s.masterTarget && s.masterTarget.type === 'player');
  assert.ok(stC.routing.hearFrom.includes(mestre.user.id));
  st = await nextState(sm, (s) => s.masterTarget.type === 'player');
  assert.deepEqual(st.routing.sendTo, [caio.user.id]);

  // Caio sussurra para o mestre
  sc.emit('player:whisper', { active: true });
  const stB2 = await nextState(sb, (s) => s.players.find((p) => p.userId === caio.user.id).whisperToMaster);
  assert.deepEqual(stB2.routing.hearFrom, []);

  // jogador não consegue usar comandos de mestre
  sb.emit('master:target', { target: { type: 'all' } });
  sb.emit('zone:create', { name: 'Hack' });
  sc.emit('player:whisper', { active: false });
  st = await nextState(sm, (s) => !s.players.find((p) => p.userId === caio.user.id).whisperToMaster);
  assert.equal(st.zones.length, 2);
  assert.equal(st.masterTarget.type, 'player');

  // excluir a Floresta devolve a Ana ao grupo principal e o alvo volta a ser válido
  sm.emit('master:target', { target: { type: 'zone', zoneId: floresta } });
  await nextState(sm, (s) => s.masterTarget.type === 'zone');
  sm.emit('zone:delete', { zoneId: floresta });
  st = await nextState(sm, (s) => s.zones.length === 1);
  assert.equal(st.players.find((p) => p.userId === ana.user.id).zoneId, st.zones[0].id);
  assert.deepEqual(st.masterTarget, { type: 'all' });

  // sinalização só é repassada dentro da sala
  const got = new Promise((resolve) => sb.once('signal', resolve));
  sa.emit('signal', { to: beto.user.id, data: { hello: 1 } });
  assert.deepEqual(await got, { from: ana.user.id, data: { hello: 1 } });

  // a posição persiste no banco
  const info = await srv.request(`/api/rooms/${roomId}`, { cookie: mestre.cookie });
  assert.equal(info.data.zones.length, 1);
});
