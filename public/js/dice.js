/**
 * Notação de dados (a mesma regra usada pelo banco, que é quem de fato rola).
 *   NdM        N dados de M lados (1d1 até 1000d1000); "dM" = 1dM; "d%" = d100
 *   NdMkhK     mantém os K maiores   (ex.: 2d20kh1 = vantagem)
 *   NdMklK     mantém os K menores   (ex.: 2d20kl1 = desvantagem)
 *   NdMdhK     descarta os K maiores
 *   NdMdlK     descarta os K menores (ex.: 4d6dl1)
 *   + e -      soma/subtrai termos e números (ex.: 3d6+1d4-2)
 * Até 20 termos e 5000 dados por rolagem.
 */

const TERM_RE = '(\\d{0,4}d\\d{1,4}((kh|kl|dh|dl)\\d{1,4})?|\\d{1,7})';
const FULL_RE = new RegExp(`^[+-]?${TERM_RE}([+-]${TERM_RE})*$`);
const PART_RE = /([+-]?)(?:(\d{0,4})d(\d{1,4})(?:(kh|kl|dh|dl)(\d{1,4}))?|(\d{1,7}))/g;

export const DICE_LIMITS = { maxCount: 1000, maxFaces: 1000, maxTerms: 20, maxDice: 5000 };

export function normalizeDice(expr) {
  return String(expr ?? '').replace(/\s+/g, '').toLowerCase().replace(/d%/g, 'd100');
}

/** Lê e valida a expressão. Devolve { ok, expression, terms, diceCount } ou { ok: false, error }. */
export function parseDice(input) {
  const expression = normalizeDice(input);
  const fail = (error) => ({ ok: false, error });
  if (!expression || expression.length > 200 || !FULL_RE.test(expression)) {
    return fail('Expressão inválida. Exemplos: 1d20, 2d6+3, 2d20kh1, 4d6dl1.');
  }
  const terms = [];
  let diceCount = 0;
  for (const m of expression.matchAll(PART_RE)) {
    if (terms.length >= DICE_LIMITS.maxTerms) return fail('Use no máximo 20 termos por rolagem.');
    const sign = m[1] === '-' ? -1 : 1;
    if (m[3] === undefined) {
      terms.push({ type: 'const', sign, value: Number(m[6]) });
      continue;
    }
    const count = m[2] ? Number(m[2]) : 1;
    const faces = Number(m[3]);
    if (count < 1 || count > DICE_LIMITS.maxCount || faces < 1 || faces > DICE_LIMITS.maxFaces) {
      return fail('Cada termo vai de 1d1 até 1000d1000.');
    }
    diceCount += count;
    if (diceCount > DICE_LIMITS.maxDice) return fail('No máximo 5000 dados por rolagem.');
    const mode = m[4] || null;
    const k = m[5] === undefined ? null : Number(m[5]);
    if ((mode === 'kh' || mode === 'kl') && (k < 1 || k > count)) {
      return fail('Manter (kh/kl) precisa ser entre 1 e a quantidade de dados.');
    }
    if ((mode === 'dh' || mode === 'dl') && (k < 0 || k >= count)) {
      return fail('Descartar (dh/dl) precisa deixar pelo menos um dado.');
    }
    terms.push({ type: 'dice', sign, count, faces, mode, k });
  }
  return { ok: true, expression, terms, diceCount };
}

const MODE_TEXT = {
  kh: (k) => (k === 1 ? 'fica com o maior' : `fica com os ${k} maiores`),
  kl: (k) => (k === 1 ? 'fica com o menor' : `fica com os ${k} menores`),
  dh: (k) => (k === 1 ? 'descarta o maior' : `descarta os ${k} maiores`),
  dl: (k) => (k === 1 ? 'descarta o menor' : `descarta os ${k} menores`),
};

/** Descrição em português da expressão, para a prévia. */
export function describeDice(parsed) {
  if (!parsed || !parsed.ok) return '';
  return parsed.terms
    .map((t, i) => {
      const op = t.sign < 0 ? 'menos ' : i > 0 ? 'mais ' : '';
      if (t.type === 'const') return `${op}${t.value}`;
      const dice = `${t.count} ${t.count === 1 ? 'dado' : 'dados'} de ${t.faces} ${t.faces === 1 ? 'lado' : 'lados'}`;
      return `${op}${dice}${t.mode ? ` (${MODE_TEXT[t.mode](t.k)})` : ''}`;
    })
    .join(', ');
}

/** Menor e maior resultado possíveis. */
export function diceRange(parsed) {
  if (!parsed || !parsed.ok) return null;
  let min = 0;
  let max = 0;
  for (const t of parsed.terms) {
    if (t.type === 'const') {
      min += t.sign * t.value;
      max += t.sign * t.value;
      continue;
    }
    const used = t.mode === 'kh' || t.mode === 'kl' ? t.k : t.mode ? t.count - t.k : t.count;
    const lo = used;
    const hi = used * t.faces;
    if (t.sign > 0) {
      min += lo;
      max += hi;
    } else {
      min -= hi;
      max -= lo;
    }
  }
  return { min, max };
}
