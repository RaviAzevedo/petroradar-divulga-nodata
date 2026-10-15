export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * GET /api/cron/acervo-index
 *
 * Indexação incremental do acervo técnico para o RAG (pgvector).
 *
 * Indexa o texto JÁ extraído (sem re-OCR):
 *   - anexos.textoCache              → origem ANEXO_EDITAL (ligado à licitação)
 *   - documentos_habilitacao.ocrTexto → origem DOC_HABILITACAO (cofre, sem licitação)
 *
 * Para cada fonte: chunk.ts quebra o texto, embeddings.ts gera os vetores e
 * inserimos em acervo_chunks. A idempotência é garantida por acervo_index_log
 * (uniq por origem_tipo + origem_id + modelo_embedding): se o texto_hash não
 * mudou para o mesmo modelo, pulamos a fonte; se mudou (reindexação), apagamos
 * os chunks antigos da fonte e regravamos.
 *
 * Budget: respeita config.acervo.budgetFontesPorExecucao e budgetChunksPorExecucao
 * para conter o custo recorrente de embeddings.
 *
 * Gate gracioso (200 + {skipped}):
 *   - cron desabilitado          → config.crons.acervoIndex.habilitado
 *   - feature RAG / sem provider → config.acervo.habilitado (embeddingDisponivel)
 *
 * Escritas múltiplas via db.batch (neon-http NÃO suporta db.transaction).
 *
 * Auth: Bearer ${CRON_SECRET} ou x-vercel-cron: 1.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
  acervoChunks,
  acervoIndexLog,
  anexos,
  documentosHabilitacao,
  type OrigemAcervo,
  type NewAcervoChunk,
} from "@/db/schema";
import { and, eq, inArray, isNotNull, ne, notInArray } from "drizzle-orm";
import { config } from "@/lib/config";
import { loggerFor } from "@/lib/observability/logger";
import { chunkTexto, hashTexto } from "@/lib/acervo/chunk";
import { gerarEmbeddings, modeloEmbedding, embeddingsDisponivel } from "@/lib/acervo/embeddings";

// Handle de transação do drizzle + operação adiada (executa dentro do tx).
type Tx = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];
type TxOp = (tx: Tx) => Promise<unknown>;

function autorizarCron(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization") ?? "";
    return authHeader === `Bearer ${cronSecret}`;
  }
  return req.headers.get("x-vercel-cron") === "1";
}

/** Fonte candidata à indexação, normalizada entre anexos e docs de habilitação. */
interface Fonte {
  origemTipo: OrigemAcervo;
  origemId: string;
  licitacaoId: string | null;
  texto: string;
  metadata: Record<string, unknown>;
}

export async function GET(req: NextRequest) {
  if (!autorizarCron(req)) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const log = loggerFor(req, { route: "cron/acervo-index" });

  // ── Gates graciosos ─────────────────────────────────────────────────────────
  if (!config.crons.acervoIndex.habilitado) {
    return NextResponse.json({ ok: true, skipped: "desabilitado" });
  }
  if (!config.acervo.habilitado || !embeddingsDisponivel()) {
    log.warn("RAG do acervo indisponível — provider de embeddings ausente");
    return NextResponse.json({ ok: true, skipped: "sem provider de embeddings" });
  }

  // PING no serviço de embeddings antes de prometer trabalho (M7).
  //
  // `embeddingsDisponivel()` só olha a CONFIGURAÇÃO. Com o provider local
  // configurado e o container `embeddings-local` fora do ar (ex.: replicas 0
  // por falta de RAM), o cron entrava, tentava indexar tudo e
  // falhava em 100% dos itens — mas terminava reportando `ok:true` com stats
  // zeradas. Log e painel diziam "OK" enquanto nada era indexado. Agora sai cedo
  // e HONESTO: `skipped` diz que o serviço está fora, não que não havia trabalho.
  const pingEmbeddings = await embeddingsRespondendo();
  if (!pingEmbeddings) {
    log.warn("serviço de embeddings não respondeu ao ping — indexação adiada");
    return NextResponse.json({
      ok: true,
      skipped: "serviço de embeddings fora do ar",
      detalhe: "o gate de configuração passou, mas o /health não respondeu",
    });
  }

  const modelo = modeloEmbedding();
  const budgetFontes = config.acervo.budgetFontesPorExecucao;
  const budgetChunks = config.acervo.budgetChunksPorExecucao;

  const stats = {
    fontesAvaliadas: 0,
    fontesIndexadas: 0,
    fontesPuladas: 0,
    fontesReindexadas: 0,
    chunksGerados: 0,
    tokensEmbedding: 0,
    falhas: 0,
  };

  // ── 1. Carrega o log de indexação existente para o modelo atual ─────────────
  // Map "origemTipo:origemId" → textoHash já indexado (mesmo modelo).
  const logRows = await db
    .select({
      origemTipo: acervoIndexLog.origemTipo,
      origemId: acervoIndexLog.origemId,
      textoHash: acervoIndexLog.textoHash,
    })
    .from(acervoIndexLog)
    .where(eq(acervoIndexLog.modeloEmbedding, modelo));

  const jaIndexado = new Map<string, string>();
  for (const r of logRows) {
    jaIndexado.set(`${r.origemTipo}:${r.origemId}`, r.textoHash);
  }

  // ── 2. Coleta fontes candidatas (texto já extraído, não-vazio) ──────────────
  // Limita o SELECT a um múltiplo do budget de fontes para não trazer o acervo
  // inteiro; a filtragem fina por hash acontece em memória logo abaixo.
  //
  // ⚠️ BUG JÁ CORRIGIDO. Antes, este `.limit()` era aplicado SEM
  // excluir o que já está indexado e SEM `ORDER BY`. O Postgres devolvia sempre
  // as mesmas `limiteScan` linhas, e assim que elas entravam no log toda
  // execução seguinte encontrava tudo já indexado e respondia
  // `fontesIndexadas: 0` — que se lê como "nada a fazer". Resultado: o cron
  // NUNCA conseguia indexar mais que `budgetFontes * 4` fontes, para sempre, em
  // silêncio: parava com uma fração dos documentos elegíveis e declarava-se
  // seco em poucas rodadas.
  //
  // A correção é buscar PRIMEIRO o que ainda não tem registro no log, e só
  // depois preencher o resto da janela com fontes já indexadas — que continuam
  // sendo varridas para detectar mudança de texto (reindexação).
  const limiteScan = budgetFontes * 4;

  const indexadosPorTipo = (tipo: OrigemAcervo): string[] =>
    logRows.filter((r) => r.origemTipo === tipo).map((r) => r.origemId);

  const anexosIndexados = indexadosPorTipo("ANEXO_EDITAL");
  const docsIndexados = indexadosPorTipo("DOC_HABILITACAO");

  const anexoBase = and(isNotNull(anexos.textoCache), ne(anexos.textoCache, ""));
  const selAnexo = {
    id: anexos.id,
    licitacaoId: anexos.licitacaoId,
    descricao: anexos.descricao,
    texto: anexos.textoCache,
  };
  // Pendentes primeiro — é isto que destrava o backfill.
  const anexoNovos = anexosIndexados.length
    ? await db.select(selAnexo).from(anexos)
        .where(and(anexoBase, notInArray(anexos.id, anexosIndexados))).limit(limiteScan)
    : await db.select(selAnexo).from(anexos).where(anexoBase).limit(limiteScan);
  // Sobrou janela: varre os já indexados para detectar texto que mudou.
  const anexoRows = anexoNovos.length >= limiteScan || !anexosIndexados.length
    ? anexoNovos
    : anexoNovos.concat(
        await db.select(selAnexo).from(anexos)
          .where(and(anexoBase, inArray(anexos.id, anexosIndexados)))
          .limit(limiteScan - anexoNovos.length),
      );

  const docBase = and(
    isNotNull(documentosHabilitacao.ocrTexto),
    ne(documentosHabilitacao.ocrTexto, ""),
    // 0034/S15 (02-APIS §16-B.4): documento restrito NUNCA vira chunk — cron sem
    // sessão usa o literal `restrito = false`. A remoção do já-indexado ao MARCAR
    // restrito é efeito do PATCH de documento (R8 §8.3), não deste cron. Espelha
    // cron_acervo_index.py do BFF — o NGINX manda /api/cron/ para o Next, então o
    // predicado precisa existir DOS DOIS lados.
    eq(documentosHabilitacao.restrito, false),
  );
  const selDoc = {
    id: documentosHabilitacao.id,
    categoria: documentosHabilitacao.categoria,
    subcategoria: documentosHabilitacao.subcategoria,
    titulo: documentosHabilitacao.titulo,
    texto: documentosHabilitacao.ocrTexto,
  };
  const docNovos = docsIndexados.length
    ? await db.select(selDoc).from(documentosHabilitacao)
        .where(and(docBase, notInArray(documentosHabilitacao.id, docsIndexados))).limit(limiteScan)
    : await db.select(selDoc).from(documentosHabilitacao).where(docBase).limit(limiteScan);
  const docRows = docNovos.length >= limiteScan || !docsIndexados.length
    ? docNovos
    : docNovos.concat(
        await db.select(selDoc).from(documentosHabilitacao)
          .where(and(docBase, inArray(documentosHabilitacao.id, docsIndexados)))
          .limit(limiteScan - docNovos.length),
      );

  // Origens que este ciclo pode indexar. Existe para permitir PRIORIZAR um
  // backfill: as fontes entram na fila com os anexos de edital na frente, e eles
  // costumam ter várias vezes o volume do cofre. Sem este seletor, indexar o
  // acervo técnico do zero significa esperar muitas horas de anexos primeiro. Vazio ou ausente = as duas origens, como sempre foi.
  const origensPermitidas = new Set(
    (process.env.ACERVO_INDEX_ORIGENS || "ANEXO_EDITAL,DOC_HABILITACAO")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );

  const fontes: Fonte[] = [];
  for (const a of anexoRows) {
    if (!a.texto || !origensPermitidas.has("ANEXO_EDITAL")) continue;
    fontes.push({
      origemTipo: "ANEXO_EDITAL",
      origemId: a.id,
      licitacaoId: a.licitacaoId,
      texto: a.texto,
      metadata: { descricao: a.descricao ?? null },
    });
  }
  for (const d of docRows) {
    if (!d.texto || !origensPermitidas.has("DOC_HABILITACAO")) continue;
    fontes.push({
      origemTipo: "DOC_HABILITACAO",
      origemId: d.id,
      licitacaoId: null,
      texto: d.texto,
      metadata: {
        categoria: d.categoria,
        subcategoria: d.subcategoria,
        titulo: d.titulo,
      },
    });
  }

  // ── 3. Indexa as fontes que mudaram, respeitando o budget ───────────────────
  const ops: TxOp[] = [];

  for (const fonte of fontes) {
    if (stats.fontesIndexadas >= budgetFontes) break;
    if (stats.chunksGerados >= budgetChunks) break;

    stats.fontesAvaliadas++;

    const chave = `${fonte.origemTipo}:${fonte.origemId}`;
    const hash = hashTexto(fonte.texto);

    const hashAnterior = jaIndexado.get(chave);
    if (hashAnterior === hash) {
      stats.fontesPuladas++;
      continue; // texto inalterado para este modelo — idempotente
    }

    const reindex = hashAnterior !== undefined;

    // Chunking
    const chunks = chunkTexto(fonte.texto);
    if (chunks.length === 0) {
      stats.fontesPuladas++;
      continue;
    }
    // Respeita o teto de chunks restante nesta execução.
    const restante = budgetChunks - stats.chunksGerados;
    const aProcessar = chunks.slice(0, Math.max(0, restante));
    if (aProcessar.length === 0) break;

    // Embeddings (uma chamada por fonte; o provider faz batch interno).
    let vetores: number[][];
    try {
      const resp = await gerarEmbeddings(aProcessar.map((c) => c.texto), "document");
      vetores = resp.vetores;
      stats.tokensEmbedding += resp.tokens;
    } catch (err) {
      stats.falhas++;
      log.error("falha ao gerar embeddings da fonte", err, {
        origemTipo: fonte.origemTipo,
        origemId: fonte.origemId,
      });
      continue;
    }

    if (vetores.length !== aProcessar.length) {
      stats.falhas++;
      log.error("contagem de embeddings divergente", null, {
        origemId: fonte.origemId,
        esperado: aProcessar.length,
        recebido: vetores.length,
      });
      continue;
    }

    // Reindexação: apaga chunks antigos da fonte antes de regravar.
    if (reindex) {
      const { origemTipo, origemId } = fonte;
      ops.push((tx) =>
        tx
          .delete(acervoChunks)
          .where(
            and(
              eq(acervoChunks.origemTipo, origemTipo),
              eq(acervoChunks.origemId, origemId),
            ),
          ),
      );
      stats.fontesReindexadas++;
    }

    // Insere os chunks com embedding + metadata.
    const novos: NewAcervoChunk[] = aProcessar.map((c, i) => ({
      origemTipo: fonte.origemTipo,
      origemId: fonte.origemId,
      licitacaoId: fonte.licitacaoId,
      chunkIndex: c.index,
      texto: c.texto,
      embedding: vetores[i],
      metadata: { ...fonte.metadata, modelo },
    }));
    ops.push((tx) => tx.insert(acervoChunks).values(novos));

    // Upsert no log de idempotência (uniq origem_tipo+origem_id+modelo).
    const { origemTipo, origemId } = fonte;
    const chunksGerados = novos.length;
    ops.push((tx) =>
      tx
        .insert(acervoIndexLog)
        .values({
          origemTipo,
          origemId,
          textoHash: hash,
          modeloEmbedding: modelo,
          chunksGerados,
        })
        .onConflictDoUpdate({
          target: [
            acervoIndexLog.origemTipo,
            acervoIndexLog.origemId,
            acervoIndexLog.modeloEmbedding,
          ],
          set: {
            textoHash: hash,
            chunksGerados,
            indexadoEm: new Date(),
          },
        }),
    );

    stats.fontesIndexadas++;
    stats.chunksGerados += novos.length;
  }

  // ── 4. Persiste tudo numa transação real (driver pg; tudo-ou-nada) ──────────
  if (ops.length > 0) {
    await db.transaction(async (tx) => {
      for (const op of ops) await op(tx);
    });
  }

  log.info("execução concluída", { stats, modelo });
  return NextResponse.json({ ok: true, stats, modelo });
}

/**
 * Ping no serviço de embeddings, para não trabalhar à toa quando ele está fora.
 *
 * ⚠️ ARMADILHA: o `/health` do TEI enfileira ATRÁS da inferência. Com o serviço
 * ocupado ele responde 200 — mas em vários segundos (às vezes dezenas, com a
 * CPU saturada). O ping antigo abortava em 2 s fixos, então
 * durante qualquer indexação sustentada a 2ª execução em diante era recusada com
 * "serviço de embeddings fora do ar", e o backfill do acervo travava: a primeira
 * execução ocupa o TEI, e ele mesmo derruba o gate das seguintes.
 *
 * Lentidão sob carga é "ocupado", não "morto". O teto agora é generoso e
 * configurável sem rebuild (`EMBEDDING_HEALTH_TIMEOUT_MS`).
 */
async function embeddingsRespondendo(): Promise<boolean> {
  const base = process.env.EMBEDDING_BASE_URL;
  if (!base) return true; // provider remoto (voyage/openai): sem /health p/ pingar
  const limite = Number(process.env.EMBEDDING_HEALTH_TIMEOUT_MS) || 30_000;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), limite);
    const r = await fetch(`${base.replace(/\/$/, "")}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}
