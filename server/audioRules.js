/**
 * Regras de roteamento de áudio da call.
 *
 * Cada participante está em um ambiente (zona). As regras são:
 *  - Jogadores ouvem os outros jogadores do MESMO ambiente.
 *  - O mestre ouve todos os jogadores (de todos os ambientes).
 *  - Quem ouve o mestre depende do "alvo" que ele escolheu:
 *      { type: 'all' }                  -> todos ouvem
 *      { type: 'zone', zoneId }         -> só quem está naquele ambiente
 *      { type: 'player', userId }       -> só aquele jogador (sussurro)
 *  - Um jogador pode "sussurrar para o mestre": enquanto isso, só o mestre o ouve.
 *
 * O servidor calcula para cada participante a lista de pessoas para quem ele
 * deve ENVIAR áudio. O cliente só envia a faixa de microfone para essas pessoas,
 * então quem não deve ouvir simplesmente não recebe o áudio.
 */

function canHear(state, speakerId, listenerId) {
  if (speakerId === listenerId) return false;
  const speaker = state.participants.get(speakerId);
  const listener = state.participants.get(listenerId);
  if (!speaker || !listener) return false;

  if (speaker.role === 'mestre') {
    const target = state.masterTarget || { type: 'all' };
    if (target.type === 'zone') return listener.zoneId === target.zoneId;
    if (target.type === 'player') return listenerId === target.userId;
    return true;
  }

  if (listener.role === 'mestre') return true;
  if (speaker.whisperToMaster) return false;
  return speaker.zoneId != null && speaker.zoneId === listener.zoneId;
}

function computeRouting(state) {
  const ids = [...state.participants.keys()];
  const routing = {};
  for (const id of ids) routing[id] = { sendTo: [], hearFrom: [] };
  for (const speakerId of ids) {
    for (const listenerId of ids) {
      if (canHear(state, speakerId, listenerId)) {
        routing[speakerId].sendTo.push(listenerId);
        routing[listenerId].hearFrom.push(speakerId);
      }
    }
  }
  return routing;
}

/** Garante que o alvo do mestre ainda é válido (ambiente/jogador pode ter saído). */
function normalizeMasterTarget(target, { zoneIds, playerIds }) {
  if (!target || typeof target !== 'object') return { type: 'all' };
  if (target.type === 'zone' && zoneIds.includes(target.zoneId)) return { type: 'zone', zoneId: target.zoneId };
  if (target.type === 'player' && playerIds.includes(target.userId)) return { type: 'player', userId: target.userId };
  return { type: 'all' };
}

module.exports = { canHear, computeRouting, normalizeMasterTarget };
