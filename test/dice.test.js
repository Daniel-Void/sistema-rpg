import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDice, describeDice, diceRange, normalizeDice } from '../public/js/dice.js';

test('normaliza espaços, maiúsculas e d%', () => {
  assert.equal(normalizeDice(' 2 D20 + d% '), '2d20+d100');
});

test('aceita as formas válidas', () => {
  for (const e of ['1d1', 'd20', '1000d1000', '2d20kh1', '2d20kl1', '4d6dl1', '4d6dh1', '3d6+1d4-2', '-1d4+10', 'd%', '5', '10 d 6 + 5']) {
    assert.equal(parseDice(e).ok, true, e);
  }
});

test('recusa as inválidas com mensagens iguais às do banco', () => {
  assert.match(parseDice('2d6*3').error, /inválida/);
  assert.match(parseDice('').error, /inválida/);
  assert.match(parseDice('abc').error, /inválida/);
  assert.match(parseDice('1001d6').error, /1d1 até 1000d1000/);
  assert.match(parseDice('1d1001').error, /1d1 até 1000d1000/);
  assert.match(parseDice('0d6').error, /1d1 até 1000d1000/);
  assert.match(parseDice('2d20kh3').error, /Manter/);
  assert.match(parseDice('4d6dl4').error, /Descartar/);
  assert.match(parseDice(Array(21).fill('6d1000').join('+')).error, /20 termos/);
  assert.match(parseDice(Array(6).fill('1000d1000').join('+')).error, /5000 dados/);
});

test('lê os termos', () => {
  const p = parseDice('2d20kh1+5-1d4');
  assert.deepEqual(p.terms, [
    { type: 'dice', sign: 1, count: 2, faces: 20, mode: 'kh', k: 1 },
    { type: 'const', sign: 1, value: 5 },
    { type: 'dice', sign: -1, count: 1, faces: 4, mode: null, k: null },
  ]);
  assert.equal(p.diceCount, 3);
});

test('descreve em português', () => {
  assert.equal(describeDice(parseDice('2d20kh1+3')), '2 dados de 20 lados (fica com o maior), mais 3');
  assert.equal(describeDice(parseDice('1d6-1')), '1 dado de 6 lados, menos 1');
});

test('calcula mínimo e máximo', () => {
  assert.deepEqual(diceRange(parseDice('1d20+5')), { min: 6, max: 25 });
  assert.deepEqual(diceRange(parseDice('4d6dl1')), { min: 3, max: 18 });
  assert.deepEqual(diceRange(parseDice('2d20kh1')), { min: 1, max: 20 });
  assert.deepEqual(diceRange(parseDice('10-1d4')), { min: 6, max: 9 });
  assert.deepEqual(diceRange(parseDice('1000d1000')), { min: 1000, max: 1000000 });
});
