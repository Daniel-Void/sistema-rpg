const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');

const { openDatabase } = require('./db');
const { createStore } = require('./store');
const { createSessions } = require('./auth');
const { createApiRouter } = require('./api');
const { createVoiceServer } = require('./voice');

const DEFAULT_ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(__dirname, '..', 'data', '.session-secret');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}

function loadIceServers() {
  if (!process.env.ICE_SERVERS) return DEFAULT_ICE_SERVERS;
  try {
    return JSON.parse(process.env.ICE_SERVERS);
  } catch {
    console.warn('ICE_SERVERS inválido (precisa ser JSON). Usando STUN padrão.');
    return DEFAULT_ICE_SERVERS;
  }
}

function createServer({ db = openDatabase(), secret = loadSecret(), iceServers = loadIceServers(), secureCookies = process.env.NODE_ENV === 'production' } = {}) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  const store = createStore(db);
  const sessions = createSessions(secret);
  const voice = createVoiceServer({ io, store, sessions });

  app.disable('x-powered-by');
  app.get('/api/config', (_req, res) => res.json({ iceServers }));
  app.use('/api', createApiRouter({ store, sessions, voice, secureCookies }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
  app.get('/sala/:id', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'room.html')));

  return { app, server, io, store };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { server } = createServer();
  server.listen(port, () => console.log(`Sistema RPG rodando em http://localhost:${port}`));
}

module.exports = { createServer };
