import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackElapsed, trackPosition, trackEnded, tracksForZone, tracksForDest, formatTime } from '../public/js/musicRules.js';

const T0 = Date.parse('2026-10-13T18:00:00Z');
const at = (s) => T0 + s * 1000;
const playing = (extra = {}) => ({ status: 'playing', started_at: '2026-10-13T18:00:00Z', offset_s: 0, duration_s: 100, loop: false, ...extra });

test('posição de uma faixa tocando avança com o relógio', () => {
  assert.equal(trackElapsed(playing(), at(30)), 30);
  assert.equal(trackElapsed(playing({ offset_s: 20 }), at(30)), 50); // retomada depois de pausa
});

test('faixa pausada ou parada fica no lugar', () => {
  assert.equal(trackPosition({ status: 'paused', offset_s: 42, duration_s: 100 }, at(500)), 42);
  assert.equal(trackPosition({ status: 'stopped', offset_s: 0 }, at(500)), 0);
});

test('repetição volta ao começo; sem repetição para no fim', () => {
  assert.equal(trackPosition(playing({ loop: true }), at(250)), 50);
  assert.equal(trackPosition(playing(), at(250)), 100);
});

test('fim da faixa só conta tocando, sem repetição e com duração conhecida', () => {
  assert.equal(trackEnded(playing(), at(99.6)), true);
  assert.equal(trackEnded(playing(), at(50)), false);
  assert.equal(trackEnded(playing({ loop: true }), at(500)), false);
  assert.equal(trackEnded(playing({ duration_s: null }), at(500)), false);
  assert.equal(trackEnded({ ...playing(), status: 'paused' }, at(500)), false);
});

test('jogador ouve as faixas do seu ambiente; se não houver, as da cena padrão', () => {
  const tracks = [
    { id: 1, zone_id: null, position: 0 },
    { id: 2, zone_id: 7, position: 1 },
    { id: 3, zone_id: 7, position: 0 },
    { id: 4, zone_id: 7, position: 2, archived: true },
  ];
  assert.deepEqual(tracksForZone(tracks, 7).map((t) => t.id), [3, 2]);
  assert.deepEqual(tracksForZone(tracks, 9).map((t) => t.id), [1]);
  assert.deepEqual(tracksForZone(tracks, null).map((t) => t.id), [1]);
  assert.deepEqual(tracksForDest(tracks, 'room').map((t) => t.id), [1]);
  assert.deepEqual(tracksForDest(tracks, 7).map((t) => t.id), [3, 2]);
});

test('formata tempo', () => {
  assert.equal(formatTime(75), '1:15');
  assert.equal(formatTime(3725), '1:02:05');
  assert.equal(formatTime(null), '0:00');
});
