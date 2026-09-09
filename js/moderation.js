/**
 * Moderação no navegador: palavrões/ódio (PT/EN/ES) e formato anti-spam.
 * A checagem ocorre antes do insert no Supabase; não substitui moderação humana.
 */

export const MIN_CHARS = 15;
export const MAX_CHARS_POST = 1000;
export const MAX_CHARS_COMENTARIO = 800;

export const MENSAGEM_CONTEUDO_RETIDO =
  'Sua mensagem contém palavras inadequadas ou formato inválido. Por favor, revise seu texto antes de enviar.';

const PALAVRAS_BANIDAS = [
  // Português
  'arrombada',
  'arrombado',
  'babaca',
  'bct',
  'bicha',
  'bosta',
  'bostas',
  'buceta',
  'canalha',
  'caralho',
  'caralhos',
  'corno',
  'cu',
  'cuzao',
  'cuzinho',
  'desgracada',
  'desgracado',
  'escrota',
  'escroto',
  'fdp',
  'filhadaputa',
  'filhodaputa',
  'vaifoder',
  'vaisefoder',
  'foda',
  'fodase',
  'foder',
  'fudida',
  'fudido',
  'idiota',
  'idiotas',
  'imbecil',
  'kct',
  'krl',
  'merda',
  'merdas',
  'otaria',
  'otario',
  'pentelho',
  'pnc',
  'porra',
  'pqp',
  'punheta',
  'puta',
  'putas',
  'putinha',
  'puto',
  'retardada',
  'retardado',
  'sapatao',
  'tnc',
  'vadia',
  'vagabunda',
  'vagabundo',
  'viado',
  'vsf',
  'xoxota',
  // Inglês
  'asshole',
  'bastard',
  'bitch',
  'bullshit',
  'cunt',
  'dickhead',
  'faggot',
  'fuck',
  'fck',
  'fuk',
  'fucked',
  'fucker',
  'fucking',
  'motherfucker',
  'nigga',
  'nigger',
  'retard',
  'retarded',
  'shit',
  'slut',
  'whore',
  // Espanhol
  'cabron',
  'cabrona',
  'carajo',
  'chingada',
  'chingar',
  'gilipollas',
  'hijadeputa',
  'hijodeputa',
  'huevon',
  'joder',
  'jodido',
  'maricon',
  'mierda',
  'pendeja',
  'pendejo',
  'verga',
  'zorra',
];

const BANIDAS = new Set(PALAVRAS_BANIDAS);

const LEET = [
  [/@/g, 'a'],
  [/4/g, 'a'],
  [/3/g, 'e'],
  [/1/g, 'i'],
  [/0/g, 'o'],
  [/5/g, 's'],
  [/7/g, 't'],
  [/8/g, 'b'],
  [/\$/g, 's'],
];

function normalizarParaModeracao(texto) {
  let value = String(texto || '').toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '');
  for (const [from, to] of LEET) value = value.replace(from, to);
  value = value.replace(/[^a-z\s]+/g, ' ');
  value = value.replace(/(.)\1{2,}/g, '$1');
  value = value.replace(/\b(?:[a-z](?:\s+|$)){3,}/g, (chunk) => {
    const joined = chunk.replace(/\s+/g, '');
    return /\s$/.test(chunk) ? `${joined} ` : joined;
  });
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} texto
 * @returns {boolean} false se houver termo banido
 */
export function verificarConteudoApropriado(texto) {
  const normalizado = normalizarParaModeracao(texto);
  if (!normalizado) return true;

  for (const parte of normalizado.split(/\s+/).filter(Boolean)) {
    if (BANIDAS.has(parte)) return false;
  }
  return true;
}

export function soTemCaracteresRepetidos(texto) {
  const compacto = String(texto || '')
    .trim()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  if (compacto.length < 6) return false;
  return /^(.)\1+$/u.test(compacto);
}

export function verificarFormatoMensagem(texto, { min = MIN_CHARS, max = MAX_CHARS_POST } = {}) {
  const value = String(texto || '').trim();
  if (value.length < min || value.length > max) return false;
  if (soTemCaracteresRepetidos(value)) return false;
  return true;
}

export function podeEnviarMensagem(texto, limites = {}) {
  if (!verificarFormatoMensagem(texto, limites)) return false;
  return verificarConteudoApropriado(texto);
}
