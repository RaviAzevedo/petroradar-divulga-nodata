/**
 * Configurações centralizadas — lidas de variáveis de ambiente com fallbacks.
 * Centraliza valores que antes estavam hardcoded no código.
 */

import { AI_MODELS, AI_MODEL_PRICING } from "@/lib/ai-contract";

const flag = (value: string | undefined, defaultEnabled: boolean): boolean => {
  if (value === undefined || value === "") return defaultEnabled;
  return value === "true" || value === "1";
};

/** Lê inteiro de env com fallback; ignora valores não-numéricos. */
const num = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** Lê string de env com fallback (trata "" como ausente). */
const str = (value: string | undefined, fallback: string): string => {
  if (value === undefined || value === "") return fallback;
  return value;
};

/**
 * Gate de embeddings — compartilhado por config.ia e config.acervo.
 * O provider "local" (TEI on-prem, BGE-m3) não usa API key: está disponível
 * quando EMBEDDING_PROVIDER=local ou quando EMBEDDING_BASE_URL aponta o
 * endpoint. Voyage/OpenAI continuam gated pelas respectivas chaves.
 */
const embeddingCredencialDisponivel = (): boolean => {
  const provider = str(process.env.EMBEDDING_PROVIDER, "local");
  if (provider === "local" || Boolean(process.env.EMBEDDING_BASE_URL)) return true;
  return Boolean(process.env.VOYAGE_API_KEY || process.env.OPENAI_API_KEY);
};

export const config = {
  proponente: {
    // CNPJ da empresa proponente (placeholder fictício — sobrescreva via env).
    // Usado pelo cron /api/cron/cnpj-watch via BrasilAPI.
    cnpj:         process.env.NEXT_PUBLIC_PROPONENTE_CNPJ          ?? "11222333000181",
    nome:         process.env.NEXT_PUBLIC_PROPONENTE_NOME          ?? "Proponente",
    razaoSocial:  process.env.NEXT_PUBLIC_PROPONENTE_RAZAO_SOCIAL  ?? "PROPONENTE ENGENHARIA LTDA",
    telefone:     process.env.NEXT_PUBLIC_PROPONENTE_TELEFONE      ?? "(00) 0000-0000",
    cidadeUF:     process.env.NEXT_PUBLIC_PROPONENTE_CIDADE_UF     ?? "Cidade, UF",
    // Endereço opcional — quando preenchido, aparece no cabeçalho/rodapé das cartas.
    endereco:     process.env.NEXT_PUBLIC_PROPONENTE_ENDERECO      ?? "",
  },
  petronect: {
    portalUrl: process.env.NEXT_PUBLIC_PETRONECT_URL ?? "https://www.petronect.com.br",
  },
  features: {
    resultados: flag(process.env.NEXT_PUBLIC_FEATURE_RESULTADOS, false),
  },

  /**
   * Modelos Anthropic e provider de embeddings — centralizados aqui para que
   * todos os crons/libs de IA (triagem-semântica, circular-impacto, gap por IA,
   * minuta de petitório, RAG do acervo) usem os mesmos identificadores e seja
   * trivial trocar de modelo sem caçar string hardcoded pelo código.
   *
   * Os nomes batem com o que já está em uso: ocr.ts usa "claude-haiku-4-5" e
   * claude.ts usa "claude-sonnet-5".
   */
  ia: {
    /** Modelo barato para tarefas de classificação/triagem em lote (prompt caching). */
    modeloHaiku:  str(process.env.ANTHROPIC_MODEL_HAIKU,  "claude-haiku-4-5"),
    /**
     * Modelo robusto para análise estruturada de edital / minutas jurídicas.
     * Claude Sonnet 5. Substituiu "claude-sonnet-4-20250514" (Sonnet 4), cuja
     * retirada foi em 15/06/2026 — as chamadas ao id antigo passaram a dar 404.
     */
    modeloSonnet: str(process.env.ANTHROPIC_MODEL_SONNET, "claude-sonnet-5"),

    // ── Embeddings (RAG do acervo) ────────────────────────────────────────────
    // ON-PREM: provider default é "local" (TEI/BGE-m3 no container embeddings-local,
    // 1024 dims — casa com vector(1024) da migration 0015). Voyage/OpenAI continuam
    // suportados como fallback, gated pelas respectivas chaves. O cron acervo-index
    // deve NO-OP graciosamente quando indisponível (ver acervo.habilitado).
    /** Provider de embeddings: "local" | "voyage" | "openai". */
    embeddingProvider: str(process.env.EMBEDDING_PROVIDER, "local"),
    /** Modelo de embedding (default BGE-m3 local; 1024 dims). */
    modeloEmbedding:   str(process.env.EMBEDDING_MODEL, "BAAI/bge-m3"),
    /** Dimensão do vetor — DEVE casar com vector(1024) da coluna acervo_chunks.embedding. */
    embeddingDimensoes: num(process.env.EMBEDDING_DIMENSOES, 1024),
    /** Indica se há provider de embeddings disponível (gate de habilitação). */
    get embeddingDisponivel(): boolean {
      return embeddingCredencialDisponivel();
    },
  },

  /**
   * Crons de IA/alertas — flags de habilitação e limiares compartilhados por
   * triagem-semântica, acervo-index, convocacao-watch, digest-executivo e
   * relatorio-mensal.
   *
   * Cada cron deve checar sua flag `habilitado` antes de gastar tokens/IO, e
   * fazer GATE gracioso (200 + {skipped:true}) quando desabilitado.
   */
  crons: {
    /** Radar de convocação do remanescente (2º colocado pós-resultado). */
    convocacaoWatch: {
      habilitado:      flag(process.env.CRON_CONVOCACAO_WATCH_ENABLED, true),
      /** Posição mínima da Proponente (>=2 = remanescente elegível). */
      posicaoMinima:   num(process.env.CRON_CONVOCACAO_POSICAO_MIN, 2),
    },

    /** Pré-classificação automática de relevância (triagem semântica do feed). */
    triagemSemantica: {
      habilitado:      flag(process.env.CRON_TRIAGEM_ENABLED, true),
      /** Licitações classificadas por execução (controla custo de tokens). */
      lotePorExecucao: num(process.env.CRON_TRIAGEM_LOTE, 40),
      /** Tamanho máx. de objeto+itens enviado ao Haiku (chars). */
      maxCharsEntrada: num(process.env.CRON_TRIAGEM_MAX_CHARS, 12_000),
      /** Score mínimo (0..100) para o feed marcar a licitação como "alto interesse". */
      scoreAltoInteresse: num(process.env.CRON_TRIAGEM_SCORE_ALTO, 70),
    },

    /** Indexação RAG do acervo (embeddings). */
    acervoIndex: {
      habilitado:      flag(process.env.CRON_ACERVO_INDEX_ENABLED, true),
    },

    /** Digest executivo semanal por e-mail. */
    digestExecutivo: {
      habilitado:      flag(process.env.CRON_DIGEST_EXECUTIVO_ENABLED, true),
    },

    /** Digest de licitações por filtro de e-mail (0026 — assinaturas por gestor). */
    digestLicitacoes: {
      habilitado:       flag(process.env.CRON_DIGEST_LICITACOES_ENABLED, true),
      /** Teto de licitações por e-mail (o excedente vira "e mais N na plataforma"). */
      maxItensPorEmail: num(process.env.CRON_DIGEST_LICITACOES_MAX_ITENS, 30),
    },

    /** Relatório executivo mensal (XLSX por e-mail). */
    relatorioMensal: {
      habilitado:      flag(process.env.CRON_RELATORIO_MENSAL_ENABLED, true),
    },

    /**
     * Extração automática do texto dos anexos (deixa o edital mastigado antes
     * de alguém pedir a análise). Ver /api/cron/extrair-anexos.
     *
     * `orcamentoSegundos` fica bem abaixo do timeout de 300s do `cron_trigger`:
     * a rota precisa devolver o relatório por conta própria, não ser cortada.
     */
    extrairAnexos: {
      habilitado:              flag(process.env.CRON_EXTRAIR_ANEXOS_ENABLED, true),
      maxLicitacoesPorRodada:  num(process.env.CRON_EXTRAIR_ANEXOS_MAX_LIC, 8),
      orcamentoSegundos:       num(process.env.CRON_EXTRAIR_ANEXOS_ORCAMENTO_S, 210),
    },

    /**
     * Alerta consolidado de prazo (bloco 3 do cron /api/cron/prazos).
     *
     * `janelaDias` é o horizonte do e-mail. As BANDAS são o que decide o envio:
     * uma licitação só entra quando CRUZA uma banda (7 → 3 → 1 → 0 dias), não
     * todo dia em que estiver dentro da janela. Sem isso, uma licitação com 7
     * dias de prazo geraria 8 e-mails idênticos.
     */
    prazosCriticos: {
      habilitado: flag(process.env.CRON_PRAZOS_CRITICOS_ENABLED, true),
      janelaDias: num(process.env.CRON_PRAZOS_CRITICOS_JANELA_DIAS, 7),
    },
  },

  /**
   * RAG do acervo técnico — chunking, budget de indexação e modelo de embedding.
   * Consumido por src/lib/acervo/* e o cron acervo-index.
   */
  acervo: {
    /** Habilita o RAG inteiro; exige extension pgvector + credencial de embeddings. */
    get habilitado(): boolean {
      return flag(process.env.FEATURE_ACERVO_RAG, true) && this.embeddingDisponivel;
    },
    get embeddingDisponivel(): boolean {
      return embeddingCredencialDisponivel();
    },
    /** Tamanho-alvo de cada chunk em caracteres (~aprox. 250 tokens). */
    chunkTamanho:     num(process.env.ACERVO_CHUNK_TAMANHO, 1_200),
    /** Sobreposição entre chunks consecutivos (preserva contexto nas bordas). */
    chunkOverlap:     num(process.env.ACERVO_CHUNK_OVERLAP, 200),
    /** Teto de fontes (anexos/docs) indexadas por execução do cron (budget). */
    budgetFontesPorExecucao: num(process.env.ACERVO_BUDGET_FONTES, 50),
    /** Teto de chunks/embeddings gerados por execução do cron (budget de custo). */
    budgetChunksPorExecucao: num(process.env.ACERVO_BUDGET_CHUNKS, 800),
    /** Top-K chunks retornados pelo retrieval por similaridade. */
    topK:             num(process.env.ACERVO_TOP_K, 8),
    /** Similaridade mínima de cosseno (0..1) para considerar um chunk relevante. */
    similaridadeMinima: num(process.env.ACERVO_SIMILARIDADE_MIN, 0.35),
    /**
     * Candidatos por braço da busca híbrida (vetor, texto estrito, texto amplo)
     * antes da fusão RRF.
     */
    candidatos:       num(process.env.ACERVO_CANDIDATOS, 120),
    /**
     * Teto de exploração do grafo HNSW por consulta (`hnsw.ef_search`).
     *
     * PRECISA ser >= `candidatos`. O default do pgvector é 40, e abaixo do
     * LIMIT ele trunca o braço vetorial EM SILÊNCIO — medido em 2026-08-29:
     * pedindo LIMIT 200 o índice devolvia as mesmas ~44 linhas de um LIMIT 60.
     * Ponta a ponta isso vale hit@5 75%→85% e MRR 0,636→0,745 por ~7 ms.
     */
    efSearch:         num(process.env.ACERVO_EF_SEARCH, 400),
    /**
     * Orçamento de custo do braço AMPLO da busca híbrida, em chunks varridos
     * (migração 0039). Os termos entram do mais raro para o mais comum
     * enquanto a soma dos `ndoc` couber aqui — é o IDF que o Postgres não tem.
     * Calibrado para um acervo de dezenas de milhares de chunks: 12k e 14k mantêm hit@10 em 36/40; 16k cai
     * (afoga o identificador) e 10k também. Recalibrar se o acervo crescer.
     */
    orcamentoAmpla:   num(process.env.ACERVO_ORCAMENTO_AMPLA, 12_000),
  },
} as const;

// ── Modelos Claude (Anthropic) ────────────────────────────────────────────────
//
// IDs centralizados pra não ficarem hardcoded espalhados em claude.ts/ocr.ts/rotas.
// Fonte canônica dos defaults: shared/ai-contract.json (espelhado em
// src/lib/ai-contract.json) — MODELS.analise = "claude-sonnet-5".
//
// Sonnet 5 substituiu "claude-sonnet-4-20250514" (Sonnet 4), depreciado e
// retirado em 15/06/2026: o id antigo passou a responder 404. Ao trocar de
// modelo, atualize os DOIS ai-contract.json (eles precisam ficar iguais) e a
// chave correspondente em model_pricing_usd_per_1k_tokens — senão o cálculo de
// custo cai no fallback e subfatura.
/** IDs de modelo — defaults de shared/ai-contract.json; env pode sobrescrever. */
export const MODELS = {
  analise: process.env.ANTHROPIC_MODEL_SONNET ?? AI_MODELS.analise,
  ocr:     process.env.ANTHROPIC_MODEL_HAIKU ?? AI_MODELS.ocr,
} as const;

type ModelId = (typeof MODELS)[keyof typeof MODELS];

/**
 * Tabela de preço por modelo (USD/1K tokens) — fonte: shared/ai-contract.json (H2).
 */
export const MODEL_PRICING: Record<string, { input: number; output: number; cache_read?: number; cache_write?: number }> =
  AI_MODEL_PRICING;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Formata 14 dígitos como "XX.XXX.XXX/XXXX-XX". */
function formatCnpj(cnpj: string): string {
  const d = cnpj.replace(/\D/g, "");
  if (d.length !== 14) return cnpj;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

/** Formata data como "Cidade, 06 de maio de 2026". */
function formatDataExtenso(d: Date, cidadeUF = config.proponente.cidadeUF): string {
  const meses = ["janeiro", "fevereiro", "março", "abril", "maio", "junho",
                 "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  const dia = String(d.getDate()).padStart(2, "0");
  const mes = meses[d.getMonth()];
  const ano = d.getFullYear();
  return `${cidadeUF}, ${dia} de ${mes} de ${ano}`;
}

/** Formata 11 dígitos como "XXX.XXX.XXX-XX". */
function formatCpf(cpf: string): string {
  const d = cpf.replace(/\D/g, "");
  if (d.length !== 11) return cpf;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}
