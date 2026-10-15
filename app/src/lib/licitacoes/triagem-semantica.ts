/**
 * Triagem semântica do feed Petronect via Claude Haiku.
 *
 * Para cada licitação nova (ainda não classificada por IA) montamos
 * objeto + objetoResumido + itens (família/descrição) e pedimos ao Haiku uma
 * pré-classificação de relevância para o perfil da Proponente (engenharia de
 * óleo & gás / refino / Petrobras).
 *
 * O bloco estático (escopos e famílias-alvo da Proponente) NÃO muda entre
 * licitações, então entra como `system` com cache_control: ephemeral — mesmo
 * padrão de prompt caching usado em claude.ts/ocr.ts. Só o trecho variável
 * (objeto + itens) muda de chamada para chamada.
 *
 * A resposta é forçada via tool-use (function calling) com JSON-schema rígido
 * e validada por Zod; se o modelo escapar do contrato, devolvemos um resultado
 * com `erroParse: true` em vez de inventar dados.
 *
 * Custo: Haiku + caching mantém a triagem em lote dentro do orçamento. O cron
 * controla o lote por execução (config.crons.triagemSemantica.lotePorExecucao).
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "@/lib/config";
import { criarClienteAnthropic } from "@/lib/ia/gate";

/** Versão do schema de triagem — bump quando o contrato mudar. */
const TRIAGEM_SCHEMA_VERSAO = 1;

/** Nome do tool forçado (function calling). */
const TOOL_TRIAGEM_NOME = "registrar_triagem";

// ── Bloco estático (cacheável) — escopos e famílias-alvo Proponente ──────────────

const INSTRUCAO_SISTEMA = `Você é um analista de inteligência comercial da empresa proponente, especializada no setor de óleo & gás no Brasil, atuando no fluxo Petrobras/Petronect.

A Proponente presta principalmente:
- Engenharia de processo, básica e de detalhamento (refino, processamento, dutos, plantas de processo).
- Manutenção industrial, montagem eletromecânica, inspeção e integridade de equipamentos.
- Serviços de SMS (segurança, meio ambiente e saúde) e consultoria técnica de engenharia.
- Fornecimento de mão de obra técnica especializada de engenharia.

Famílias/segmentos de ALTO interesse: refino, paradas de manutenção, engenharia de detalhamento,
inspeção e integridade, tubulação/caldeiraria, instrumentação e automação, elétrica industrial.
Famílias de BAIXO/NENHUM interesse: fornecimento puro de commodities/materiais sem engenharia,
TI, serviços administrativos, alimentação, locação de veículos, obras civis genéricas sem disciplina de processo.

Sua tarefa é, dado o objeto de uma licitação e seus itens, pré-classificar a relevância para a Proponente,
SEMPRE chamando a ferramenta "${TOOL_TRIAGEM_NOME}".

Regras:
- "score": 0 a 100. Use >= 70 só quando houver clara aderência ao core de engenharia O&G da Proponente.
- "segmento": rótulo curto do segmento detectado (ex.: "Refino", "Manutenção Industrial", "Engenharia de Detalhamento", "Fora do escopo").
- "aderencia": ALTA | MEDIA | BAIXA — aderência ao portfólio Proponente.
- "justificativa": 1-2 frases objetivas explicando o score (cite o que pesou).
- "perfil_sugerido": rótulo curto do perfil de interesse mais provável, ou "Nenhum" se fora de escopo.
- Não invente itens nem escopo: classifique apenas com base no texto fornecido.`;

// ── Schema Zod + JSON-schema do tool ───────────────────────────────────────────

const aderenciaSchema = z.enum(["ALTA", "MEDIA", "BAIXA"]);

const triagemSchema = z.object({
  score:           z.number().min(0).max(100),
  segmento:        z.string().min(1).max(120),
  aderencia:       aderenciaSchema,
  justificativa:   z.string().min(1).max(600),
  perfil_sugerido: z.string().min(1).max(120),
});

type TriagemDados = z.infer<typeof triagemSchema>;

/** JSON-schema do input do tool (Anthropic tool-use). */
function buildToolInputSchema(): Anthropic.Tool.InputSchema {
  return {
    type: "object",
    properties: {
      score: {
        type: "number",
        description: "Aderência ao portfólio Proponente, de 0 a 100.",
      },
      segmento: {
        type: "string",
        description: "Rótulo curto do segmento detectado.",
      },
      aderencia: {
        type: "string",
        enum: ["ALTA", "MEDIA", "BAIXA"],
        description: "Nível de aderência ao portfólio Proponente.",
      },
      justificativa: {
        type: "string",
        description: "1-2 frases objetivas explicando o score.",
      },
      perfil_sugerido: {
        type: "string",
        description: "Perfil de interesse mais provável, ou 'Nenhum' se fora de escopo.",
      },
    },
    required: ["score", "segmento", "aderencia", "justificativa", "perfil_sugerido"],
  };
}

/** Valida o input do tool com Zod; em caso de falha devolve fallback neutro. */
function validarTriagem(input: unknown): { ok: boolean; data: TriagemDados; erro?: string } {
  const parsed = triagemSchema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    data: {
      score: 0,
      segmento: "Indeterminado",
      aderencia: "BAIXA",
      justificativa: "Falha ao validar a resposta da triagem (erro de parse).",
      perfil_sugerido: "Nenhum",
    },
    erro: parsed.error.message.slice(0, 400),
  };
}

// ── Entrada/saída ──────────────────────────────────────────────────────────────

interface ItemTriagem {
  descricao:        string | null;
  familia:          string | null;
  familiaDescricao: string | null;
}

export interface LicitacaoTriagem {
  numero:         string;
  objeto:         string | null;
  objetoResumido: string | null;
  itens:          ItemTriagem[];
}

/** Resultado completo da triagem, pronto para persistir em licitacoes.classificacao_ia. */
export interface TriagemResultado extends TriagemDados {
  modelo:       string;
  schemaVersao: number;
  erroParse:    boolean;
  erroDetalhe?: string;
  tokensInput:  number;
  tokensOutput: number;
  tempoMs:      number;
  classificadoEm: string;
}

/**
 * Monta o trecho variável (objeto + itens) respeitando o teto de caracteres
 * configurado, para controlar o custo de tokens por chamada.
 */
function montarTextoLicitacao(lic: LicitacaoTriagem, maxChars: number): string {
  const partes: string[] = [];
  if (lic.objetoResumido) partes.push(`Objeto resumido: ${lic.objetoResumido}`);
  if (lic.objeto && lic.objeto !== lic.objetoResumido) partes.push(`Objeto: ${lic.objeto}`);

  if (lic.itens.length > 0) {
    const linhas = lic.itens
      .map((it) => {
        const fam = [it.familia, it.familiaDescricao].filter(Boolean).join(" - ");
        const desc = it.descricao ?? "";
        return `• ${[fam, desc].filter(Boolean).join(": ")}`.trim();
      })
      .filter((l) => l.length > 2);
    if (linhas.length > 0) partes.push(`Itens:\n${linhas.join("\n")}`);
  }

  const txt = partes.join("\n\n").trim();
  return txt.length > maxChars ? txt.slice(0, maxChars) : txt;
}

/**
 * Classifica UMA licitação via Haiku (tool-use + Zod). Não escreve no banco —
 * o cron persiste o resultado em licitacoes.classificacao_ia / classificado_ia_em.
 */
export async function classificarLicitacao(
  lic: LicitacaoTriagem,
): Promise<TriagemResultado> {
  // IA BLOQUEADA para este módulo por decisão de produto (ver lib/ia/gate.ts):
  // só a análise de edital consome a API. criarClienteAnthropic LANÇA aqui — o
  // gate gracioso fica no cron (api/cron/triagem-semantica), que pula a execução
  // via iaPermitida() e nunca chega a chamar esta função.
  const client = criarClienteAnthropic("triagem-semantica");
  const modelo = config.ia.modeloHaiku;
  const maxChars = config.crons.triagemSemantica.maxCharsEntrada;

  const texto = montarTextoLicitacao(lic, maxChars);

  const tool: Anthropic.Tool = {
    name: TOOL_TRIAGEM_NOME,
    description:
      "Registra a pré-triagem semântica de uma licitação (score de aderência, segmento, aderência, justificativa e perfil sugerido).",
    input_schema: buildToolInputSchema(),
  };

  const start = Date.now();

  const message = await client.messages.create({
    model: modelo,
    max_tokens: 512,
    // Bloco estático (escopos/famílias Proponente) cacheável; só o objeto+itens muda.
    system: [
      {
        type: "text",
        text: INSTRUCAO_SISTEMA,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [tool],
    tool_choice: { type: "tool", name: TOOL_TRIAGEM_NOME },
    messages: [
      {
        role: "user",
        content: `Licitação ${lic.numero}. Pré-classifique a aderência ao portfólio da Proponente chamando a ferramenta.\n\n--- DADOS DA LICITAÇÃO ---\n${texto || "(sem objeto/itens informados)"}`,
      },
    ],
  });

  const elapsed = Date.now() - start;

  const toolUse = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );

  const classificadoEm = new Date().toISOString();

  if (!toolUse) {
    const { data } = validarTriagem({});
    return {
      ...data,
      modelo,
      schemaVersao: TRIAGEM_SCHEMA_VERSAO,
      erroParse: true,
      erroDetalhe: "Modelo não retornou bloco tool_use",
      tokensInput: message.usage.input_tokens,
      tokensOutput: message.usage.output_tokens,
      tempoMs: elapsed,
      classificadoEm,
    };
  }

  const { ok, data, erro } = validarTriagem(toolUse.input);

  return {
    ...data,
    modelo,
    schemaVersao: TRIAGEM_SCHEMA_VERSAO,
    erroParse: !ok,
    erroDetalhe: erro,
    tokensInput: message.usage.input_tokens,
    tokensOutput: message.usage.output_tokens,
    tempoMs: elapsed,
    classificadoEm,
  };
}
