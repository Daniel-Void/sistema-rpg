/** Regras de cena: o que cada jogador vê/ouve, e quem recebe efeitos e a tela compartilhada. */

export function hasScene(source) {
  return Boolean(
    source && (source.scene_media_id || source.ambient_youtube || source.ambient_media_id || String(source.scene_caption || '').trim()),
  );
}

/**
 * Cena efetiva para quem está em `zone`: a cena do ambiente, se houver;
 * senão a cena padrão da sala; senão nada.
 */
export function effectiveScene(room, zone) {
  const source = hasScene(zone) ? zone : hasScene(room) ? room : null;
  if (!source) return null;
  return {
    visualId: source.scene_media_id ?? null,
    youtube: source.ambient_youtube || null,
    caption: String(source.scene_caption || '').trim(),
    volume: typeof source.ambient_volume === 'number' ? source.ambient_volume : 0.6,
    from: source === zone ? 'zone' : 'room',
  };
}

/**
 * Lê um link do YouTube e devolve { videoId, listId } (ou null se não for um link válido).
 * Aceita watch?v=, youtu.be/, shorts/, embed/, live/, music.youtube.com e playlists.
 */
export function parseYouTube(url) {
  if (typeof url !== 'string') return null;
  let u;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  const isId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{11}$/.test(s);
  const listId = u.searchParams.get('list');
  const validList = listId && /^[A-Za-z0-9_-]{10,64}$/.test(listId) ? listId : null;
  let videoId = null;
  if (host === 'youtu.be') videoId = u.pathname.split('/')[1];
  else if (host === 'youtube.com') {
    const [, first, second] = u.pathname.split('/');
    if (first === 'watch') videoId = u.searchParams.get('v');
    else if (['shorts', 'embed', 'live'].includes(first)) videoId = second;
    else if (first !== 'playlist') return null;
  } else return null;
  if (!isId(videoId)) videoId = null;
  if (!videoId && !validList) return null;
  return { videoId, listId: validList };
}

/** Alvo: { type: 'all' } | { type: 'zone', zoneId } | { type: 'player', userId } */
export function targetIncludes(target, { userId, zoneId }) {
  if (!target || target.type === 'all') return true;
  if (target.type === 'zone') return zoneId != null && zoneId === target.zoneId;
  if (target.type === 'player') return userId === target.userId;
  return false;
}
