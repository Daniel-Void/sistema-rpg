/** Regras de cena: o que cada jogador vê/ouve, e quem recebe efeitos e a tela compartilhada. */

export function hasScene(source) {
  return Boolean(source && (source.scene_media_id || source.ambient_media_id || String(source.scene_caption || '').trim()));
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
    ambientId: source.ambient_media_id ?? null,
    caption: String(source.scene_caption || '').trim(),
    volume: typeof source.ambient_volume === 'number' ? source.ambient_volume : 0.6,
    from: source === zone ? 'zone' : 'room',
  };
}

/** Alvo: { type: 'all' } | { type: 'zone', zoneId } | { type: 'player', userId } */
export function targetIncludes(target, { userId, zoneId }) {
  if (!target || target.type === 'all') return true;
  if (target.type === 'zone') return zoneId != null && zoneId === target.zoneId;
  if (target.type === 'player') return userId === target.userId;
  return false;
}
