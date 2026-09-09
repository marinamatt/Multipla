import { CAU_SC_ATIVOS } from './cau-sc-ativos.js';

/**
 * Forma canônica da lista oficial: 10 caracteres, zeros à esquerda + A + dígitos.
 * Aceita A765432-1, A7654321, 00A7654321, 7654321, etc.
 */
export function canonicalCau(cau) {
  let value = String(cau || '')
    .trim()
    .toUpperCase()
    .replace(/[\s.\-]/g, '')
    .replace(/^0+/, '');
  if (!value) return '';
  if (!value.startsWith('A')) value = `A${value}`;
  if (!/^A\d+$/.test(value)) return '';
  return value.padStart(10, '0');
}

export function validarRegistroCAU(cau) {
  const code = canonicalCau(cau);
  return Boolean(code) && CAU_SC_ATIVOS.has(code);
}

export function mensagemErroRegistroCAU(cau) {
  const raw = String(cau || '').trim();
  if (!raw) {
    return 'Informe o seu registro do CAU, como no SICCAU (ex.: A765432-1).';
  }
  if (!canonicalCau(raw)) {
    return 'Use o número do CAU com a letra A e os dígitos (ex.: A765432-1 ou 00A7654321).';
  }
  if (!validarRegistroCAU(raw)) {
    return 'Este número não consta na relação de profissionais ativos do CAU/SC. Confira no SICCAU ou no seu cartão.';
  }
  return '';
}
