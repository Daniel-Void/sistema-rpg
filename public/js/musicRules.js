/**
 * Regras do mixer de música. O estado de cada faixa vem do banco:
 * status (stopped | playing | paused), offset_s (posição ao começar/pausar),
 * started_at (quando começou a tocar), duration_s, loop.
 * Todo mundo calcula a posição com o mesmo relógio (o do servidor), então
 * todos ouvem o mesmo trecho.
 */

/** Segundos tocados desde o início da faixa (sem considerar a repetição). */
export function trackElapsed(track, nowMs) {
  const offset = Number(track.offset_s) || 0;
  if (track.status !== 'playing' || !track.started_at) return offset;
  return offset + Math.max(0, (nowMs - Date.parse(track.started_at)) / 1000);
}

/** Posição atual dentro do vídeo (com repetição, volta ao começo). */
export function trackPosition(track, nowMs) {
  const elapsed = trackElapsed(track, nowMs);
  const duration = Number(track.duration_s) || 0;
  if (!duration) return elapsed;
  if (track.loop) return elapsed % duration;
  return Math.min(elapsed, duration);
}

/** A faixa tocou até o fim (e não repete)? */
export function trackEnded(track, nowMs) {
  const duration = Number(track.duration_s) || 0;
  return track.status === 'playing' && !track.loop && duration > 0 && trackElapsed(track, nowMs) >= duration - 0.5;
}

/**
 * Faixas que valem para quem está em `zoneId`: as do ambiente, se ele tiver
 * alguma; senão as da cena padrão da sala (zone_id nulo). Em ordem.
 */
export function tracksForZone(tracks, zoneId) {
  const live = (tracks || []).filter((t) => !t.archived);
  const own = zoneId == null ? [] : live.filter((t) => t.zone_id === zoneId);
  const list = own.length ? own : live.filter((t) => t.zone_id == null);
  return list.slice().sort((a, b) => a.position - b.position || a.id - b.id);
}

/** Faixas de um destino exato do mixer ('room' ou id do ambiente). */
export function tracksForDest(tracks, dest) {
  const zoneId = dest === 'room' ? null : dest;
  return (tracks || [])
    .filter((t) => !t.archived && (t.zone_id ?? null) === zoneId)
    .sort((a, b) => a.position - b.position || a.id - b.id);
}

/** 75 -> "1:15", 3725 -> "1:02:05" */
export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
