/**
 * Contrato compartilhado de IA (H2) — espelho de shared/ai-contract.json.
 *
 * CANÔNICO na raiz do monorepo on-prem: ../shared/ai-contract.json
 * Este arquivo JSON em src/lib/ é o bundle importável pelo Next (server-side).
 * Ao editar prompt ou preços, atualize AMBOS (ou só shared/ e copie para cá).
 */

import contractJson from "./ai-contract.json";

export type AiContract = typeof contractJson;

export const aiContract: AiContract = contractJson;

/** Instrução-sistema da análise de edital (claude.ts / licitacoes_id_analise.py). */
export const INSTRUCAO_ANALISE_EDITAL = aiContract.instrucao_analise_edital;

/** IDs de modelo — env ANTHROPIC_MODEL_* ainda pode sobrescrever via config.ts. */
export const AI_MODELS = aiContract.models;

/** USD por 1K tokens (input/output/cache). */
export const AI_MODEL_PRICING = aiContract.model_pricing_usd_per_1k_tokens;
