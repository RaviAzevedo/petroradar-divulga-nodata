/**
 * Geração de embeddings para o RAG do acervo.
 *
 * A Anthropic NÃO oferece embeddings nativos, então usamos um provider externo
 * gated por env (ver config.ia.embeddingProvider / config.acervo):
 *   - "local"  → HuggingFace TEI on-prem (endpoint OpenAI-compatível), EMBEDDING_BASE_URL
 *   - "voyage" → Voyage AI (recomendado para PT/jurídico), VOYAGE_API_KEY
 *   - "openai" → OpenAI text-embedding-*, OPENAI_API_KEY
 *
 * Tudo via fetch (REST) para não adicionar dependência npm — mesmo padrão do
 * rate-limit/Upstash. Quando NENHUMA credencial está presente, `embeddingsDisponivel()`
 * devolve false e os callers (cron acervo-index, /api/acervo/buscar) fazem GATE
 * gracioso em vez de quebrar o build/run.
 *
 * Dimensão DEVE casar com acervo_chunks.embedding = vector(1024) on-prem (BGE-m3
 * via TEI); a validação usa config.ia.embeddingDimensoes. Validamos o tamanho do
 * vetor retornado e lançamos erro claro se o modelo configurado não bater (ex.:
 * voyage-3-lite=512 ≠ dimensão esperada) para evitar inserts silenciosamente
 * incompatíveis com a coluna.
 */

import { config } from "@/lib/config";

/** Indica se há credencial de embeddings disponível (gate de habilitação). */
export function embeddingsDisponivel(): boolean {
  return config.acervo.embeddingDisponivel;
}

/** Identificador do modelo de embedding em uso (persistido em acervo_index_log). */
export function modeloEmbedding(): string {
  return config.ia.modeloEmbedding;
}

/** Tipo de entrada do embedding: documento (indexação) ou consulta (busca). */
export type TipoEmbedding = "document" | "query";

export interface EmbeddingResposta {
  vetores: number[][];
  modelo: string;
  tokens: number;
}

// ── Provider: Voyage AI ───────────────────────────────────────────────────────

async function embedVoyage(
  textos: string[],
  tipo: TipoEmbedding,
): Promise<EmbeddingResposta> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error("VOYAGE_API_KEY ausente");

  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.ia.modeloEmbedding,
      input: textos,
      // Voyage distingue documento × consulta (melhora retrieval assimétrico).
      input_type: tipo,
      // Pede a dimensão configurada quando o modelo suportar output_dimension.
      output_dimension: config.ia.embeddingDimensoes,
    }),
  });

  if (!res.ok) {
    const detalhe = await res.text().catch(() => "");
    throw new Error(`Voyage embeddings HTTP ${res.status}: ${detalhe.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    data: Array<{ embedding: number[]; index: number }>;
    usage?: { total_tokens?: number };
  };

  // Garante a ordem original (a API devolve `index`).
  const ordenados = [...json.data].sort((a, b) => a.index - b.index);
  return {
    vetores: ordenados.map((d) => d.embedding),
    modelo: config.ia.modeloEmbedding,
    tokens: json.usage?.total_tokens ?? 0,
  };
}

// ── Provider: OpenAI ──────────────────────────────────────────────────────────

async function embedOpenAi(textos: string[]): Promise<EmbeddingResposta> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY ausente");

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.ia.modeloEmbedding,
      input: textos,
      // text-embedding-3-* suportam redução de dimensão.
      dimensions: config.ia.embeddingDimensoes,
    }),
  });

  if (!res.ok) {
    const detalhe = await res.text().catch(() => "");
    throw new Error(`OpenAI embeddings HTTP ${res.status}: ${detalhe.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    data: Array<{ embedding: number[]; index: number }>;
    usage?: { total_tokens?: number };
  };

  const ordenados = [...json.data].sort((a, b) => a.index - b.index);
  return {
    vetores: ordenados.map((d) => d.embedding),
    modelo: config.ia.modeloEmbedding,
    tokens: json.usage?.total_tokens ?? 0,
  };
}

// ── Provider: Local (TEI / Text Embeddings Inference, OpenAI-compatible) ──────

/**
 * Teto de textos por request ao TEI. O serviço embeddings-local (docker-compose
 * `text-embeddings-inference`) sobe SEM `--max-client-batch-size`, logo vale o
 * default 32 do TEI — input com mais de 32 textos toma HTTP 413 (Payload Too
 * Large) e derruba o re-embed em loop. Fatiamos SÓ o provider local: Voyage e
 * OpenAI têm limites próprios bem maiores (128/2048 inputs por request) e os
 * callers atuais nunca os estouram; fatiar globalmente só multiplicaria requests
 * (e custo) nos providers pagos sem necessidade.
 */
const EMBEDDING_MAX_LOTE = 32;

// Provider on-prem (100% sem egress). Espelha bff/app/services/embeddings.py e o
// formato OpenAI dos providers acima: POST {EMBEDDING_BASE_URL}/v1/embeddings com
// { model, input }. Lido de process.env.EMBEDDING_BASE_URL (config.ia ainda não
// expõe esse campo nesta branch). TEI não distingue document/query (sem input_type)
// e o BGE-m3 é simétrico, então o parâmetro `tipo` é intencionalmente ignorado.
//
// Fatia `textos` em sub-lotes de EMBEDDING_MAX_LOTE requests SEQUENCIAIS (o TEI
// cpu-1.5 on-prem não ganha nada com concorrência e manter a ordem fica trivial)
// e concatena vetores/tokens na ordem original. Único ponto de entrada do
// provider local — cobre gerarEmbeddings, gerarEmbedding e o cron acervo-index.
async function embedLocal(textos: string[]): Promise<EmbeddingResposta> {
  const vetores: number[][] = [];
  let tokens = 0;
  for (let i = 0; i < textos.length; i += EMBEDDING_MAX_LOTE) {
    const resp = await embedLocalLote(textos.slice(i, i + EMBEDDING_MAX_LOTE));
    vetores.push(...resp.vetores);
    tokens += resp.tokens;
  }
  return { vetores, modelo: config.ia.modeloEmbedding, tokens };
}

/** UMA request ao TEI (≤ EMBEDDING_MAX_LOTE textos). Não chamar direto: use embedLocal. */
async function embedLocalLote(textos: string[]): Promise<EmbeddingResposta> {
  const baseUrl = process.env.EMBEDDING_BASE_URL ?? "http://embeddings-local:80";
  const res = await fetch(`${baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.ia.modeloEmbedding, // ex.: "BAAI/bge-m3"
      input: textos,
    }),
  });

  if (!res.ok) {
    const detalhe = await res.text().catch(() => "");
    throw new Error(`Local embeddings HTTP ${res.status}: ${detalhe.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    data: Array<{ embedding: number[]; index: number }>;
    usage?: { total_tokens?: number; prompt_tokens?: number };
  };

  // Garante a ordem original (a API devolve `index`), igual aos providers acima.
  const ordenados = [...json.data].sort((a, b) => a.index - b.index);
  return {
    vetores: ordenados.map((d) => d.embedding),
    modelo: config.ia.modeloEmbedding,
    tokens: json.usage?.total_tokens ?? json.usage?.prompt_tokens ?? 0,
  };
}

// ── API pública ────────────────────────────────────────────────────────────────

/**
 * Gera embeddings para uma lista de textos. Roteia para o provider configurado
 * e valida a dimensão de saída contra config.ia.embeddingDimensoes (on-prem = vector(1024)).
 *
 * Lança erro se nenhum provider estiver disponível ou se a dimensão não casar —
 * os callers devem ter feito GATE com embeddingsDisponivel() antes.
 */
export async function gerarEmbeddings(
  textos: string[],
  tipo: TipoEmbedding = "document",
): Promise<EmbeddingResposta> {
  if (textos.length === 0) {
    return { vetores: [], modelo: config.ia.modeloEmbedding, tokens: 0 };
  }
  if (!embeddingsDisponivel()) {
    throw new Error(
      "Nenhum provider de embeddings disponível (defina EMBEDDING_PROVIDER=local + EMBEDDING_BASE_URL, ou VOYAGE_API_KEY/OPENAI_API_KEY)",
    );
  }

  const provider = config.ia.embeddingProvider;
  // Provider "local" (TEI on-prem) é selecionado por EMBEDDING_PROVIDER=local OU pela
  // presença de EMBEDDING_BASE_URL — assim funciona mesmo sem o ajuste de defaults em
  // config.ts (que pertence a outra tarefa). Mantém o roteamento voyage/openai intacto.
  const usarLocal = provider === "local" || Boolean(process.env.EMBEDDING_BASE_URL);
  const resp = usarLocal
    ? await embedLocal(textos)
    : provider === "openai" && process.env.OPENAI_API_KEY
      ? await embedOpenAi(textos)
      : process.env.VOYAGE_API_KEY
        ? await embedVoyage(textos, tipo)
        : await embedOpenAi(textos);

  const esperado = config.ia.embeddingDimensoes;
  const recebido = resp.vetores[0]?.length ?? 0;
  if (recebido !== esperado) {
    throw new Error(
      `Dimensão de embedding incompatível: modelo "${resp.modelo}" devolveu ${recebido}, esperado ${esperado} (coluna vector(${esperado})). Ajuste EMBEDDING_MODEL/EMBEDDING_DIMENSOES.`,
    );
  }

  return resp;
}

/** Conveniência: embedding de UM único texto (ex.: a query de busca). */
export async function gerarEmbedding(
  texto: string,
  tipo: TipoEmbedding = "query",
): Promise<number[]> {
  const { vetores } = await gerarEmbeddings([texto], tipo);
  if (vetores.length === 0) throw new Error("Embedding vazio");
  return vetores[0];
}
