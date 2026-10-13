import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveScene, hasScene, parseYouTube, targetIncludes } from '../public/js/sceneRules.js';

const room = { scene_media_id: 1, ambient_youtube: 'https://youtu.be/aaaaaaaaaaa', scene_caption: 'Taverna', ambient_volume: 0.5 };
const floresta = { id: 10, scene_media_id: 3, ambient_youtube: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', scene_caption: 'Floresta escura', ambient_volume: 0.8 };
const vazia = { id: 11, scene_media_id: null, ambient_youtube: null, scene_caption: '', ambient_volume: 0.6 };

test('ambiente com cena própria mostra a sua cena', () => {
  assert.deepEqual(effectiveScene(room, floresta), { visualId: 3, youtube: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', caption: 'Floresta escura', volume: 0.8, from: 'zone' });
});

test('ambiente sem cena usa a cena padrão da sala', () => {
  assert.equal(effectiveScene(room, vazia).visualId, 1);
  assert.equal(effectiveScene(room, vazia).from, 'room');
});

test('sem cena em lugar nenhum não mostra nada', () => {
  assert.equal(effectiveScene(vazia, vazia), null);
  assert.equal(effectiveScene(null, null), null);
});

test('só texto já conta como cena', () => {
  assert.equal(hasScene({ scene_caption: '  Anoitece  ' }), true);
  assert.equal(hasScene({ scene_caption: '   ' }), false);
});

test('alvos de efeito sonoro e tela compartilhada', () => {
  const ana = { userId: 'a', zoneId: 10 };
  assert.equal(targetIncludes({ type: 'all' }, ana), true);
  assert.equal(targetIncludes(null, ana), true);
  assert.equal(targetIncludes({ type: 'zone', zoneId: 10 }, ana), true);
  assert.equal(targetIncludes({ type: 'zone', zoneId: 11 }, ana), false);
  assert.equal(targetIncludes({ type: 'player', userId: 'a' }, ana), true);
  assert.equal(targetIncludes({ type: 'player', userId: 'b' }, ana), false);
  assert.equal(targetIncludes({ type: 'zone', zoneId: 10 }, { userId: 'm', zoneId: null }), false);
});

test('só música do YouTube já conta como cena', () => {
  assert.equal(hasScene({ ambient_youtube: 'https://youtu.be/aaaaaaaaaaa' }), true);
});

test('lê links do YouTube', () => {
  const id = 'dQw4w9WgXcQ';
  assert.deepEqual(parseYouTube(`https://www.youtube.com/watch?v=${id}`), { videoId: id, listId: null });
  assert.deepEqual(parseYouTube(`https://youtu.be/${id}?t=30`), { videoId: id, listId: null });
  assert.deepEqual(parseYouTube(`https://m.youtube.com/watch?v=${id}&feature=share`), { videoId: id, listId: null });
  assert.deepEqual(parseYouTube(`https://music.youtube.com/watch?v=${id}`), { videoId: id, listId: null });
  assert.deepEqual(parseYouTube(`https://www.youtube.com/shorts/${id}`), { videoId: id, listId: null });
  assert.deepEqual(parseYouTube(`https://www.youtube.com/embed/${id}`), { videoId: id, listId: null });
  assert.deepEqual(parseYouTube('https://www.youtube.com/playlist?list=PLabcdefghij123'), { videoId: null, listId: 'PLabcdefghij123' });
  assert.deepEqual(parseYouTube(`https://www.youtube.com/watch?v=${id}&list=PLabcdefghij123`), { videoId: id, listId: 'PLabcdefghij123' });
  assert.equal(parseYouTube('https://vimeo.com/123'), null);
  assert.equal(parseYouTube('https://www.youtube.com/@canal'), null);
  assert.equal(parseYouTube('javascript:alert(1)'), null);
  assert.equal(parseYouTube('não é link'), null);
});
