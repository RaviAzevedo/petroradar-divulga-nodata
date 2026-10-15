/**
 * Redação de PII (CPF e e-mail) em texto livre do acervo.
 *
 * POR QUE ESTE MÓDULO EXISTE, E POR QUE A VERSÃO ANTERIOR ERA PERIGOSA
 * ───────────────────────────────────────────────────────────────────
 * A redação anterior (`conf_cofre_documentos._redigir_pii`, só no BFF) pegava
 * CPF sem pontuação com `(?<!\d)\d{11}(?!\d)`. O lookbehind exclui apenas
 * DÍGITO — então, num acervo cheio de número de ART do CREA, ela destruía
 * identificador legítimo:
 *
 *     "ART BA20230012345"  →  "ART BA[CPF-REMOVIDO]"
 *
 * ART é um dos maiores tipos de documento do acervo, e o número da ART é
 * exatamente o que se procura numa busca de habilitação — e é nele que aparece
 * a sequência de 11 dígitos nua.
 *
 * DUAS DEFESAS, e as duas são necessárias:
 *
 *   1. FRONTEIRA ALFANUMÉRICA, não só de dígito — `BA20230012345` tem letra
 *      colada, então os 11 dígitos de dentro não são candidatos.
 *   2. DÍGITO VERIFICADOR — só é redigido o que fecha como CPF. Sem isso,
 *      "protocolo 12345678901" viraria `[CPF-REMOVIDO]`, e um acervo de
 *      engenharia é feito de números.
 *
 * A validação vale também para o CPF FORMATADO: um `000.000.000-00` de
 * formulário em branco não é dado pessoal de ninguém, e redigi-lo só apaga a
 * informação de que o campo estava vazio.
 *
 * Sem lookbehind de propósito (tsconfig target = ES2017; lookbehind é ES2018).
 * Espelho exato de bff/app/routers/migrated/_pii.py.
 */

export const MARCA_CPF = "[CPF-REMOVIDO]";
export const MARCA_EMAIL = "[EMAIL-REMOVIDO]";

const RE_CPF_FMT = /\d{3}\.\d{3}\.\d{3}-\d{2}/g;
/** Grupo 1 = a fronteira à esquerda, devolvida intacta na substituição. */
const RE_CPF_NU = /(^|[^0-9A-Za-z])(\d{11})(?![0-9A-Za-z])/g;
const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Confere os dois dígitos verificadores. Espelho de cpf_valido() no Python. */
export function cpfValido(digitos: string): boolean {
  const d = (digitos ?? "").replace(/\D/g, "");
  if (d.length !== 11) return false;
  // 111.111.111-11 e afins passam na conta do DV, mas não são CPF de ninguém.
  if (new Set(d).size === 1) return false;
  for (const corte of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < corte; i++) soma += Number(d[i]) * (corte + 1 - i);
    const dv = ((soma * 10) % 11) % 10;
    if (dv !== Number(d[corte])) return false;
  }
  return true;
}

/** Remove CPF e e-mail de texto livre. Idempotente. */
export function redigirPii<T extends string | null | undefined>(texto: T): T {
  if (!texto) return texto;
  let t = (texto as string).replace(RE_CPF_FMT, (m) => (cpfValido(m) ? MARCA_CPF : m));
  t = t.replace(RE_CPF_NU, (_m, antes: string, num: string) =>
    cpfValido(num) ? `${antes}${MARCA_CPF}` : `${antes}${num}`,
  );
  return t.replace(RE_EMAIL, MARCA_EMAIL) as T;
}
