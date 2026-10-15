/**
 * Trava de IA (allowlist) — único ponto do app autorizado a instanciar o SDK da
 * Anthropic.
 *
 * POR QUE ESTA TRAVA EXISTE
 * ─────────────────────────
 * Decisão do dono do produto: **só a análise de edital sob demanda pode consumir
 * a API da Anthropic.** O app nasceu com 9 módulos chamando `new Anthropic()`
 * espalhados (triagem semântica em lote, impacto de circular, gap de habilitação,
 * sumário de preço, pós-mortem, síntese RAG do acervo, OCR de conformidade…),
 * vários deles em CRON — ou seja, gasto recorrente, invisível e não solicitado
 * por ninguém. A análise de edital é o único módulo cujo valor entregue justifica
 * o custo: ela é disparada por um humano, uma vez por licitação, e alimenta o
 * briefing e o pacote de orçamento.
 *
 * A trava é de CÓDIGO, não de configuração: mesmo que alguém ligue a
 * ANTHROPIC_API_KEY por engano (ou copie um .env de produção para um ambiente de
 * teste), os módulos fora da allowlist continuam incapazes de chamar a API —
 * `criarClienteAnthropic` LANÇA antes de qualquer requisição sair. Custo
 * previsível por construção.
 *
 * COMO USAR
 * ─────────
 *   • `iaPermitida(modulo)`  → gate GRACIOSO. Use quando o módulo tem um caminho
 *     alternativo (heurística, resposta sem síntese, mapa vazio): o fluxo segue
 *     funcionando, só sem IA. É o que mantém os crons verdes.
 *   • `criarClienteAnthropic(modulo)` → LANÇA se o módulo não estiver na
 *     allowlist. Onde não há fallback, esse é o comportamento desejado: a feature
 *     fica indisponível de forma barulhenta, em vez de silenciosamente cara.
 *
 * `ocr-anexo` está liberado porque é o passo de extrair texto de PDF escaneado
 * DENTRO do fluxo da análise (extrair-anexos.ts): sem ele a análise não recebe os
 * documentos. Não é um módulo autônomo — é pré-requisito da análise.
 */

import Anthropic from "@anthropic-ai/sdk";

/**
 * Os módulos que instanciam o SDK da Anthropic. `circular-impacto`,
 * `sugestao-preco` e `postmortem` saíram com as telas na limpeza de 2026-09.
 */
export type ModuloIA =
  | "analise-edital"
  | "ocr-anexo"
  | "triagem-semantica"
  | "gap-habilitacao"
  | "acervo-busca"
  | "ocr-conformidade";

/**
 * Allowlist — APENAS estes dois módulos podem consumir a API da Anthropic.
 *
 * `analise-edital` é a análise sob demanda; `ocr-anexo` é a extração de texto dos
 * PDFs escaneados que a alimenta. Qualquer outro módulo está bloqueado por
 * decisão de produto. NÃO acrescente entradas aqui sem essa decisão.
 */
export const MODULOS_IA_PERMITIDOS: readonly ModuloIA[] = [
  "analise-edital",
  "ocr-anexo",
];

/** True se a chave está configurada (não-vazia). */
function chaveConfigurada(): boolean {
  return (process.env.ANTHROPIC_API_KEY ?? "").trim().length > 0;
}

/**
 * Gate GRACIOSO: o módulo está na allowlist E existe chave configurada?
 *
 * Use antes de decidir entre o caminho com IA e o fallback (heurística, resposta
 * parcial, no-op). Não lança — só responde sim/não.
 */
export function iaPermitida(modulo: ModuloIA): boolean {
  return MODULOS_IA_PERMITIDOS.includes(modulo) && chaveConfigurada();
}

/**
 * Cria o cliente Anthropic para um módulo. **Único lugar do app com
 * `new Anthropic()`.**
 *
 * - Módulo fora da allowlist → lança (trava de produto; nenhuma requisição sai).
 * - Módulo permitido mas sem ANTHROPIC_API_KEY → lança (erro de configuração).
 * - Caso ok → cliente com `timeout` e `maxRetries` EXPLÍCITOS, sempre.
 *
 * TIMEOUT — o número aqui é uma decisão de CUSTO, não de latência.
 *
 * O timeout do SDK é POR TENTATIVA, e um timeout de conexão conta como erro
 * retryable: o SDK repete. Cada repetição é uma geração completa, faturada pela
 * Anthropic mesmo que o cliente já tenha desistido. Ou seja, um timeout curto
 * demais não "economiza" — ele MULTIPLICA a conta por (1 + maxRetries) e ainda
 * devolve erro.
 *
 * Havia 120000 aqui, herdado de quando a análise usava max_tokens 8192. Com
 * 16000, uma saída grande de tool_use passa de 120s e o SDK pagava a mesma
 * análise 3 vezes (~US$ 0,60) para no fim lançar. O próprio SDK sabe disso:
 * `calculateNonstreamingTimeout()` dimensiona o timeout pelo max_tokens (para
 * 16000 daria ~600s) — mas essa proteção só roda quando o cliente NÃO define
 * `timeout`. Ao fixar 120s, nós a desligávamos sem perceber.
 *
 * 600s alinha com o que o próprio fornecedor considera seguro para este teto de
 * saída. A análise ainda usa `.stream()` (ver claude.ts), que torna o estouro
 * improvável; este número é o cinto de segurança do caminho não-streaming (OCR
 * de anexo, que manda PDF inteiro em base64).
 *
 * maxRetries: 2 fica — 429 (rate limit) e 529 (overloaded) NÃO são faturados, e
 * repetir esses é o comportamento certo.
 */
export function criarClienteAnthropic(modulo: ModuloIA): Anthropic {
  if (!MODULOS_IA_PERMITIDOS.includes(modulo)) {
    throw new Error(
      `IA bloqueada para o módulo "${modulo}": só a análise de edital pode consumir a API da Anthropic (ver lib/ia/gate.ts).`,
    );
  }

  if (!chaveConfigurada()) {
    throw new Error(
      `IA indisponível para o módulo "${modulo}": falta ANTHROPIC_API_KEY no ambiente.`,
    );
  }

  return new Anthropic({ timeout: 600_000, maxRetries: 2 });
}
