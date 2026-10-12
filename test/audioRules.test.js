import test from 'node:test';
import assert from 'node:assert/strict';
import { canHear, computeRouting, normalizeMasterTarget } from '../public/js/audioRules.js';

const FOGUEIRA = 1;
const FLORESTA = 2;
const MESTRE = 10;
const ANA = 11; // floresta
const BETO = 12; // fogueira
const CAIO = 13; // fogueira

function mesa(masterTarget = { type: 'all' }, overrides = {}) {
  const participants = new Map([
    [MESTRE, { role: 'mestre', zoneId: null }],
    [ANA, { role: 'jogador', zoneId: FLORESTA }],
    [BETO, { role: 'jogador', zoneId: FOGUEIRA }],
    [CAIO, { role: 'jogador', zoneId: FOGUEIRA }],
  ]);
  for (const [id, patch] of Object.entries(overrides)) Object.assign(participants.get(Number(id)), patch);
  return { masterTarget, participants };
}

test('jogadores do mesmo ambiente se ouvem; de ambientes diferentes não', () => {
  const s = mesa();
  assert.equal(canHear(s, BETO, CAIO), true);
  assert.equal(canHear(s, CAIO, BETO), true);
  assert.equal(canHear(s, ANA, BETO), false);
  assert.equal(canHear(s, BETO, ANA), false);
});

test('o mestre ouve todos os jogadores, de qualquer ambiente', () => {
  const s = mesa({ type: 'zone', zoneId: FLORESTA });
  for (const id of [ANA, BETO, CAIO]) assert.equal(canHear(s, id, MESTRE), true);
});

test('mestre falando com todos: todos ouvem', () => {
  const s = mesa({ type: 'all' });
  for (const id of [ANA, BETO, CAIO]) assert.equal(canHear(s, MESTRE, id), true);
});

test('mestre narrando para a floresta: só quem está lá ouve, e a fogueira segue conversando', () => {
  const s = mesa({ type: 'zone', zoneId: FLORESTA });
  assert.equal(canHear(s, MESTRE, ANA), true);
  assert.equal(canHear(s, MESTRE, BETO), false);
  assert.equal(canHear(s, MESTRE, CAIO), false);
  assert.equal(canHear(s, BETO, CAIO), true);
});

test('mestre sussurrando para um jogador: só ele ouve', () => {
  const s = mesa({ type: 'player', userId: BETO });
  assert.equal(canHear(s, MESTRE, BETO), true);
  assert.equal(canHear(s, MESTRE, CAIO), false);
  assert.equal(canHear(s, MESTRE, ANA), false);
  // o jogador continua sendo ouvido pelo próprio ambiente
  assert.equal(canHear(s, BETO, CAIO), true);
});

test('jogador sussurrando para o mestre: só o mestre ouve', () => {
  const s = mesa({ type: 'all' }, { [BETO]: { whisperToMaster: true } });
  assert.equal(canHear(s, BETO, MESTRE), true);
  assert.equal(canHear(s, BETO, CAIO), false);
  // mas ele continua ouvindo o ambiente
  assert.equal(canHear(s, CAIO, BETO), true);
});

test('ninguém ouve a si mesmo', () => {
  const s = mesa();
  for (const id of [MESTRE, ANA, BETO]) assert.equal(canHear(s, id, id), false);
});

test('computeRouting gera listas sendTo/hearFrom simétricas', () => {
  const r = computeRouting(mesa({ type: 'zone', zoneId: FLORESTA }));
  assert.deepEqual(r[MESTRE].sendTo, [ANA]);
  assert.deepEqual(r[MESTRE].hearFrom.sort(), [ANA, BETO, CAIO]);
  assert.deepEqual(r[BETO].sendTo.sort(), [MESTRE, CAIO]);
  assert.deepEqual(r[ANA].hearFrom, [MESTRE]);
  assert.deepEqual(r[ANA].sendTo, [MESTRE]);
});

test('normalizeMasterTarget volta para "todos" quando o alvo some', () => {
  const ctx = { zoneIds: [1, 2], playerIds: [11] };
  assert.deepEqual(normalizeMasterTarget({ type: 'zone', zoneId: 3 }, ctx), { type: 'all' });
  assert.deepEqual(normalizeMasterTarget({ type: 'player', userId: 99 }, ctx), { type: 'all' });
  assert.deepEqual(normalizeMasterTarget({ type: 'zone', zoneId: 2 }, ctx), { type: 'zone', zoneId: 2 });
  assert.deepEqual(normalizeMasterTarget(null, ctx), { type: 'all' });
});
