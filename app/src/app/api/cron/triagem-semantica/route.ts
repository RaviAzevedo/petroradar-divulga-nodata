export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * GET /api/cron/triagem-semantica
 *
 * Cron leve de pré-classificação de relevância do feed Petronect.
 *
 * Para cada licitação ainda não classificada por IA (classificado_ia_em IS NULL),
 * monta objeto + objetoResumido + itens (família/descrição) e envia ao Claude
 * Haiku (prompt caching no bloco estático de escopos/famílias Proponente, padrão
 * de ocr.ts/claude.ts). A resposta {score, segmento, aderencia, justificativa,
 * perfil_sugerido} é validada por Zod e gravada em:
 *   - licitacoes.classificacao_ia (jsonb)
 *   - licitacoes.classificado_ia_em (timestamptz)
 *
 * O feed pode então ranquear por score. Notificação de score alto é
 * responsabilidade do cron oportunidades-novas (não duplicamos disparo aqui).
 *
 * Gate gracioso:
 *   - desabilitado por config → 200 {skipped:"desabilitado"}
 *   - IA bloqueada/sem chave  → 200 {skipped:"IA bloqueada (ver lib/ia/gate.ts)"}
 *     (a triagem semântica está FORA da allowlist de IA — ver lib/ia/gate.ts —,
 *      então este skip é o caminho permanente, não uma exceção)
 *
 * Escritas via db.batch (neon-http não suporta db.transaction).
 *
 * Auth: Bearer ${CRON_SECRET} ou x-vercel-cron: 1.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { licitacoes, itens } from "@/db/schema";
import { eq, isNull, inArray, desc } from "drizzle-orm";
import { config } from "@/lib/config";
import { iaPermitida } from "@/lib/ia/gate";
import { loggerFor } from "@/lib/observability/logger";
import {
  classificarLicitacao,
  type LicitacaoTriagem,
  type TriagemResultado,
} from "@/lib/licitacoes/triagem-semantica";

function autorizarCron(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization") ?? "";
    return authHeader === `Bearer ${cronSecret}`;
  }
  return req.headers.get("x-vercel-cron") === "1";
}

export async function GET(req: NextRequest) {
  if (!autorizarCron(req)) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const log = loggerFor(req, { route: "cron/triagem-semantica" });

  // Gate gracioso — não quebra o build/run quando desabilitado ou sem secret.
  if (!config.crons.triagemSemantica.habilitado) {
    return NextResponse.json({ ok: true, skipped: "desabilitado" });
  }
  // Gate de IA (lib/ia/gate.ts): a triagem semântica está BLOQUEADA por decisão
  // de produto — só a análise de edital consome a API da Anthropic. iaPermitida()
  // é sempre false aqui, então o cron continua rodando verde (skip explícito) em
  // vez de estourar dentro de classificarLicitacao(). Cobre também o caso
  // legítimo de ANTHROPIC_API_KEY ausente.
  if (!iaPermitida("triagem-semantica")) {
    log.warn("IA indisponível/bloqueada para triagem semântica — execução pulada");
    return NextResponse.json({ ok: true, skipped: "IA bloqueada (ver lib/ia/gate.ts)" });
  }

  const lote = config.crons.triagemSemantica.lotePorExecucao;
  const stats = {
    candidatas: 0,
    classificadas: 0,
    altoInteresse: 0,
    errosParse: 0,
    falhas: 0,
    tokensInput: 0,
    tokensOutput: 0,
  };

  // ── 1. Seleciona licitações ainda não classificadas por IA ─────────────────
  // Prioriza as mais recentes (criado_em desc) para o feed refletir novidades.
  const pendentes = await db
    .select({
      id:             licitacoes.id,
      numero:         licitacoes.numero,
      objeto:         licitacoes.objeto,
      objetoResumido: licitacoes.objetoResumido,
    })
    .from(licitacoes)
    .where(isNull(licitacoes.classificadoIaEm))
    .orderBy(desc(licitacoes.criadoEm))
    .limit(lote);

  stats.candidatas = pendentes.length;

  if (pendentes.length === 0) {
    log.info("nenhuma licitação pendente de triagem");
    return NextResponse.json({ ok: true, stats });
  }

  // ── 2. Carrega itens de todas as candidatas de uma vez (evita N+1) ──────────
  const ids = pendentes.map((p) => p.id);
  const itensRows = await db
    .select({
      licitacaoId:      itens.licitacaoId,
      descricao:        itens.descricao,
      familia:          itens.familia,
      familiaDescricao: itens.familiaDescricao,
    })
    .from(itens)
    .where(inArray(itens.licitacaoId, ids));

  const itensPorLic = new Map<string, LicitacaoTriagem["itens"]>();
  for (const it of itensRows) {
    const arr = itensPorLic.get(it.licitacaoId) ?? [];
    // Limita itens por licitação para conter o tamanho do prompt.
    if (arr.length < 40) {
      arr.push({
        descricao:        it.descricao,
        familia:          it.familia,
        familiaDescricao: it.familiaDescricao,
      });
    }
    itensPorLic.set(it.licitacaoId, arr);
  }

  // ── 3. Classifica cada licitação e acumula os updates (aplicados no fim) ────
  const updatesPendentes: Array<{ id: string; classificacaoIa: Record<string, unknown> }> = [];
  const scoreAlto = config.crons.triagemSemantica.scoreAltoInteresse;

  for (const lic of pendentes) {
    const entrada: LicitacaoTriagem = {
      numero:         lic.numero,
      objeto:         lic.objeto,
      objetoResumido: lic.objetoResumido,
      itens:          itensPorLic.get(lic.id) ?? [],
    };

    let resultado: TriagemResultado;
    try {
      resultado = await classificarLicitacao(entrada);
    } catch (err) {
      stats.falhas++;
      log.error("falha ao classificar licitação", err, { licitacaoId: lic.id, numero: lic.numero });
      continue;
    }

    stats.classificadas++;
    stats.tokensInput += resultado.tokensInput;
    stats.tokensOutput += resultado.tokensOutput;
    if (resultado.erroParse) stats.errosParse++;
    if (resultado.score >= scoreAlto) stats.altoInteresse++;

    const classificacaoIa = {
      score:           resultado.score,
      segmento:        resultado.segmento,
      aderencia:       resultado.aderencia,
      justificativa:   resultado.justificativa,
      perfil_sugerido: resultado.perfil_sugerido,
      modelo:          resultado.modelo,
      schema_versao:   resultado.schemaVersao,
      erro_parse:      resultado.erroParse,
      classificado_em: resultado.classificadoEm,
    };

    updatesPendentes.push({ id: lic.id, classificacaoIa });
  }

  // ── 4. Persiste tudo atomicamente numa transação real (driver pg) ───────────
  if (updatesPendentes.length > 0) {
    await db.transaction(async (tx) => {
      for (const u of updatesPendentes) {
        await tx
          .update(licitacoes)
          .set({
            classificacaoIa:  u.classificacaoIa,
            classificadoIaEm: new Date(),
            atualizadoEm:     new Date(),
          })
          .where(eq(licitacoes.id, u.id));
      }
    });
  }

  log.info("execução concluída", { stats });
  return NextResponse.json({ ok: true, stats });
}
