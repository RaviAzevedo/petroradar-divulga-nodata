export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/acervo/buscar
 *
 * Busca semântica em linguagem natural sobre o acervo técnico/editais (RAG).
 *
 * Fluxo:
 *   1. requireAcervo() — gate de papel (interno; EXTERNO barrado) + anti-IDOR.
 *   2. Gera o embedding da pergunta (embeddings.ts, provider gated por env).
 *   3. buscarChunksSimilares() faz o k-NN por cosseno (<=>) com filtros de
 *      metadata (origemTipo, licitacaoId) e corte de similaridade mínima.
 *   4. Pede ao Claude responder usando SOMENTE o contexto recuperado e CITANDO
 *      a origem por número ([1], [2]...). Sem contexto suficiente → resposta
 *      honesta de "não encontrei no acervo".
 *
 * Body JSON:
 *   { "pergunta": string, "origemTipo"?: ("ANEXO_EDITAL"|"DOC_HABILITACAO"|"PROJETO")[],
 *     "licitacaoId"?: uuid, "topK"?: number }
 *
 * Gate gracioso (200 + {disponivel:false}):
 *   - RAG desabilitado / sem provider de embeddings → config.acervo.habilitado
 *   - IA bloqueada/sem chave → devolve os trechos sem resposta sintetizada
 *     (a síntese está FORA da allowlist de IA — ver lib/ia/gate.ts —, então hoje
 *      este é o caminho permanente: busca semântica sim, redação por IA não)
 *
 * Rate limit por usuário para conter custo de IA. Nenhuma escrita (read-only).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { criarClienteAnthropic, iaPermitida } from "@/lib/ia/gate";
import { redigirPii } from "@/lib/seguranca/pii";
import {
  requireAcervo,
  assertAcessoObjeto,
  handleApiError,
  ApiError,
} from "@/lib/api/guards";
import { rateLimit } from "@/lib/rate-limit";
import { config } from "@/lib/config";
import { loggerFor } from "@/lib/observability/logger";
import {
  gerarEmbedding,
  embeddingsDisponivel,
} from "@/lib/acervo/embeddings";
import {
  buscarChunksSimilares,
  montarContexto,
  type FiltroRetrieval,
} from "@/lib/acervo/retrieval";
import { podeVisualizar } from "@/lib/permissions";

const ORIGENS = ["ANEXO_EDITAL", "DOC_HABILITACAO", "PROJETO"] as const;

const bodySchema = z.object({
  pergunta: z.string().min(3).max(2000),
  origemTipo: z.array(z.enum(ORIGENS)).optional(),
  licitacaoId: z.string().uuid().optional(),
  topK: z.number().int().min(1).max(20).optional(),
  detentora: z.array(z.enum(["PROPONENTE", "COLIGADA", "PARCEIRO"])).optional(),
  tipoDocumento: z.array(z.string().regex(/^[A-Za-z0-9_]{1,40}$/)).optional(),
  desde: z.number().int().min(1990).max(2100).optional(),
});

// Instrução estática (cacheável) — não muda entre buscas.
const INSTRUCAO_SISTEMA = `Você é um assistente de pesquisa do acervo técnico da empresa proponente (óleo & gás / Petrobras).

Responda à pergunta do usuário usando EXCLUSIVAMENTE os trechos de contexto fornecidos. Cada trecho vem rotulado com um número entre colchetes (ex.: [1], [2]).

Regras:
- Cite SEMPRE a origem das afirmações usando os números dos trechos, ex.: "... conforme o atestado [2]".
- NÃO invente dados que não estejam no contexto. Se o contexto for insuficiente, diga claramente que não encontrou a informação no acervo.
- Seja objetivo e técnico; responda em português do Brasil.
- Quando houver datas/validades/valores, transcreva-os fielmente do trecho citado.`;

export async function POST(req: NextRequest) {
  const log = loggerFor(req, { route: "acervo/buscar" });

  try {
    const { user } = await requireAcervo();

    // Gate gracioso: RAG indisponível (sem extension/provider) — não quebra.
    if (!config.acervo.habilitado || !embeddingsDisponivel()) {
      return NextResponse.json({
        disponivel: false,
        motivo: "Busca semântica indisponível (provider de embeddings não configurado).",
        resposta: null,
        fontes: [],
        trechos: [],
      });
    }

    // Rate limit por usuário (custo de embedding + Claude).
    const rl = await rateLimit({
      key: `acervo-buscar:${user.id}`,
      max: 30,
      windowMs: 60 * 1000,
    });
    if (!rl.allowed) {
      throw new ApiError(429, "RATE_LIMITED", "Muitas buscas em sequência. Tente novamente em instantes.");
    }

    const json = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION", parsed.error.issues[0]?.message ?? "Corpo inválido");
    }
    const { pergunta, origemTipo, licitacaoId, topK, detentora, tipoDocumento, desde } =
      parsed.data;

    // ── 1. Embedding da pergunta ──────────────────────────────────────────────
    const queryEmbedding = await gerarEmbedding(pergunta, "query");

    // ── 2. Retrieval k-NN por cosseno + filtros de metadata ───────────────────
    // 0034/S16: o papel entra no retrieval — chunk de documento restrito não
    // sai para papel fora de Conformidade (defesa em profundidade sobre S15).
    // `pergunta` alimenta o lado TEXTUAL do híbrido. Omiti-la degrada a busca
    // para k-NN puro, e o hit@10 cai muito.
    const filtro: FiltroRetrieval = {
      origemTipo, licitacaoId, topK, pergunta, detentora, tipoDocumento, desde,
    };
    const chunksBrutos = await buscarChunksSimilares(queryEmbedding, filtro, user.role);

    // REDAÇÃO NA LEITURA, na ORIGEM e não só na resposta.
    //
    // Texto de OCR pode ter entrado no índice por fora da redação de PII (carga
    // em lote, reprocessamento). A busca devolve o trecho LITERAL, então um
    // resultado podia exibir o CPF de um responsável técnico.
    //
    // Redigir AQUI, e não no `map` da resposta, porque `montarContexto()` abaixo
    // monta o texto que vai para o modelo na síntese. Redigir só na saída
    // deixaria a PII entrar no prompt — e sair pela resposta sintetizada.
    //
    // Não afeta ranking: o vetor e o índice textual são construídos na
    // INDEXAÇÃO; isto é redação de apresentação, depois da busca.
    const chunks = chunksBrutos.map((c) => ({ ...c, texto: redigirPii(c.texto) }));

    // Anti-IDOR a nível de objeto: hoje qualquer interno (podeVisualizar) pode
    // ver tudo do tenant; quando houver ACL fina, filtrar por origem permitida.
    // Reforça a invariante para que a rota nunca exponha fora do escopo do papel.
    assertAcessoObjeto(podeVisualizar(user.role), "Sem acesso ao acervo");

    if (chunks.length === 0) {
      return NextResponse.json({
        disponivel: true,
        resposta: "Não encontrei nada no acervo que responda a essa pergunta.",
        fontes: [],
        trechos: [],
      });
    }

    const { contexto, fontes } = montarContexto(chunks);
    const trechos = chunks.map((c, i) => ({
      numero: i + 1,
      origemTipo: c.origemTipo,
      origemId: c.origemId,
      licitacaoId: c.licitacaoId,
      chunkIndex: c.chunkIndex,
      similaridade: Math.round(c.similaridade * 1000) / 1000,
      texto: c.texto,
      metadata: c.metadata,
      // a UI renderiza `trechos`, não `fontes` — sem isto o card volta a mostrar
      // só tipo e relevância, sem nome de arquivo nem link
      arquivo: c.arquivo,
      // proveniência da fusão — permite à tela marcar "achado pelo texto"
      posTexto: c.posTexto,
    }));

    // Gate parcial: a síntese RAG está BLOQUEADA por decisão de produto (ver
    // lib/ia/gate.ts) — só a análise de edital consome a API da Anthropic.
    // iaPermitida("acervo-busca") é sempre false, então a busca continua
    // funcionando e devolve os trechos relevantes, apenas sem a síntese
    // redigida pela IA. (Cobre também o caso de ANTHROPIC_API_KEY ausente.)
    if (!iaPermitida("acervo-busca")) {
      return NextResponse.json({
        disponivel: true,
        resposta: null,
        motivo: "Síntese por IA indisponível. Trechos relevantes retornados.",
        fontes,
        trechos,
      });
    }

    // ── 3. Síntese com citação via Claude ─────────────────────────────────────
    // Inalcançável enquanto o módulo estiver fora da allowlist (lança se chamado).
    const client = criarClienteAnthropic("acervo-busca");
    let resposta = "";
    let tokensInput = 0;
    let tokensOutput = 0;
    try {
      const message = await client.messages.create({
        model: config.ia.modeloHaiku,
        max_tokens: 1024,
        // Bloco estático (instruções) cacheável; só pergunta+contexto variam.
        system: [
          {
            type: "text",
            text: INSTRUCAO_SISTEMA,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: `Pergunta: ${pergunta}\n\n--- CONTEXTO DO ACERVO ---\n${contexto}\n\n--- FIM DO CONTEXTO ---\n\nResponda citando os trechos pelos números.`,
          },
        ],
      });
      const block = message.content.find((b): b is Anthropic.TextBlock => b.type === "text");
      resposta = block?.text ?? "";
      tokensInput = message.usage.input_tokens;
      tokensOutput = message.usage.output_tokens;
    } catch (err) {
      // Falha na síntese não invalida o retrieval — devolvemos os trechos.
      log.error("falha ao sintetizar resposta RAG", err, { userId: user.id });
      return NextResponse.json({
        disponivel: true,
        resposta: null,
        motivo: "Falha ao sintetizar a resposta. Trechos relevantes retornados.",
        fontes,
        trechos,
      });
    }

    log.info("busca RAG concluída", {
      userId: user.id,
      chunks: chunks.length,
      tokensInput,
      tokensOutput,
    });

    return NextResponse.json({
      disponivel: true,
      resposta,
      fontes,
      trechos,
      _meta: { modelo: config.ia.modeloHaiku, tokensInput, tokensOutput },
    });
  } catch (e) {
    if (!(e instanceof ApiError)) {
      log.error("erro inesperado na busca do acervo", e);
    }
    return handleApiError(e);
  }
}
