/**
 * Schemas Zod + JSON-schema da análise estruturada de editais.
 *
 * Esta camada substitui o parser frágil de JSON "na unha" do claude.ts.
 * A ideia é forçar o modelo a responder via tool-use (function calling) com
 * um JSON-schema rígido; o SDK devolve o `input` do tool_use já como objeto,
 * e nós validamos com Zod antes de confiar nos dados. Assim:
 *   - sem regex/balanceamento de chaves;
 *   - sem markdown/```json``` pra limpar;
 *   - campos faltantes/errados viram erro de validação (flag erro_parse), não
 *     dados silenciosamente corrompidos.
 *
 * Versão do schema (SCHEMA_VERSAO) acompanha analises_ia.schema_versao — quando
 * mudarmos a forma da análise, incrementamos aqui pra rastrear no banco.
 */

import { z } from "zod";

/** Versão corrente do schema de análise — persistida em analises_ia.schema_versao. */
export const SCHEMA_VERSAO = 2;

/** Nome do tool exposto ao Claude (function calling). */
export const TOOL_ANALISE_NOME = "registrar_analise_edital";

// ── Sub-schemas ────────────────────────────────────────────────────────────

const classificacaoRiscoSchema = z.enum(["ALTO", "MEDIO", "BAIXO"]);

const riscoAlertaSchema = z.object({
  descricao:     z.string(),
  classificacao: classificacaoRiscoSchema,
});

const equipeItemSchema = z.object({
  descricao:  z.string(),
  quantidade: z.number().int().nonnegative(),
});

/**
 * Requisito do edital com rastreabilidade.
 *
 * `codigo` deve seguir, quando possível, o vocabulário de SubcategoriaDocHab
 * (CND_FEDERAL, ISO_9001, ATESTADO_ACT, ...) pra casar com o cofre e habilitar
 * o Gap de Habilitação. `trechoCitado` é a citação literal do edital de onde o
 * requisito foi extraído (rastreabilidade), e `confianca` é o quão seguro o
 * modelo está (0..1).
 */
const requisitoEstruturadoSchema = z.object({
  codigo:       z.string().min(1),
  descricao:    z.string().min(1),
  obrigatorio:  z.boolean().default(true),
  trecho_citado: z.string().default(""),
  confianca:    z.number().min(0).max(1).default(0.7),
});
export type RequisitoEstruturado = z.infer<typeof requisitoEstruturadoSchema>;

// Checklist é deliberadamente permissivo (campos livres preenchidos pela skill
// de briefing). Mantemos como record pra não engessar a UI do checklist.
const checklistSchema = z.record(z.string(), z.unknown());

// ── Schema principal da análise ──────────────────────────────────────────────

const analiseEstruturadaSchema = z.object({
  resumo_executivo:   z.string().default(""),
  objeto_detalhado:   z.string().default(""),
  escopo_resumido:    z.string().default(""),
  exclusoes_escopo:   z.string().default(""),
  requisitos_tecnicos:    z.array(z.string()).default([]),
  criterios_habilitacao:  z.array(z.string()).default([]),
  criterios_julgamento:   z.string().default(""),
  valor_estimado:     z.string().default(""),
  prazos_importantes: z.array(z.string()).default([]),
  riscos_alertas:     z.array(riscoAlertaSchema).default([]),
  recomendacao:       z.string().default(""),
  // Requisitos rastreáveis: alimentam requisitos_edital (codigo/trecho/confianca)
  requisitos_estruturados: z.array(requisitoEstruturadoSchema).default([]),
  checklist:          checklistSchema.default({}),
});
export type AnaliseEstruturada = z.infer<typeof analiseEstruturadaSchema>;

/**
 * JSON-schema do tool entregue ao Anthropic SDK.
 *
 * Gerado a partir do Zod (zod v4 tem z.toJSONSchema nativo). Usamos `io: "input"`
 * pra que os defaults NÃO virem `required`, deixando o modelo livre pra omitir
 * campos que ele preencherá no nosso lado com o default. O resultado é tipado
 * como Tool.InputSchema (type: "object").
 */
export function buildToolInputSchema(): {
  type: "object";
  properties?: unknown;
  required?: string[];
  [k: string]: unknown;
} {
  const json = z.toJSONSchema(analiseEstruturadaSchema, {
    target: "draft-2020-12",
    io: "input",
    // Inlina $defs/$refs — a API da Anthropic prefere schema "flat" sem refs externas
    reused: "inline",
  }) as Record<string, unknown>;

  // Garante o shape exigido pela Anthropic (type: "object" no topo)
  return {
    ...json,
    type: "object",
  };
}

/**
 * Valida o `input` cru de um tool_use contra o schema.
 *
 * Retorna { ok, data, erro }. Em caso de falha, `data` traz o melhor esforço
 * (campos default) pra UI degradar com graça e a análise é marcada erro_parse.
 */
export function validarAnalise(
  inputCru: unknown,
): { ok: boolean; data: AnaliseEstruturada; erro?: string } {
  const parsed = analiseEstruturadaSchema.safeParse(inputCru);
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }
  // Fallback: aplica defaults sobre um objeto vazio pra não quebrar a UI
  const fallback = analiseEstruturadaSchema.parse({});
  return {
    ok: false,
    data: fallback,
    erro: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
  };
}
