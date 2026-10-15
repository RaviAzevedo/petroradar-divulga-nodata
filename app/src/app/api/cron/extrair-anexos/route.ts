export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * GET /api/cron/extrair-anexos — deixa o edital MASTIGADO antes de alguém pedir.
 *
 * POR QUE ESTE CRON EXISTE
 * ────────────────────────
 * `processarAnexosDaLicitacao` já sabia baixar o pacote do Petronect e extrair o
 * texto de tudo (pdf/docx/xlsx/zip aninhado). O que faltava era alguém CHAMAR:
 * a única porta era o botão "Baixar anexos", um clique por licitação. Na
 * prática, quase nenhum anexo coletado chegava a ter texto extraído.
 *
 * A consequência não era "a análise falha" — era pior. Sem texto de anexo, a
 * rota de análise caía em `licitacoes.objeto` (70 caracteres em média) e gerava
 * um briefing completo de 12 seções sobre nada. Ver migration 0032.
 *
 * ESCOPO: só licitações ABERTAS e RELEVANTES (ALTA/MÉDIA em Recebendo
 * Propostas). Não é economia de disco — é que extrair a base inteira
 * multiplicaria o tamanho do banco (e do pg_dump diário, na mesma proporção)
 * para guardar o edital de licitação que já encerrou. O backlog que interessa
 * é pequeno: dezenas de licitações, algumas centenas de anexos.
 *
 * FILA: entra por `tasks.cron_trigger`, que roteia para a fila `default`. NÃO
 * pode ir para a `scraping` (concurrency=1, compartilhada com os scrapes
 * Playwright do Petronect) — é exatamente esse head-of-line blocking que
 * congela as outras tasks da fila por semanas. E não precisa:
 * o download de anexo é HTTP puro com cookie SAP cacheado, sem Chromium.
 *
 * ORÇAMENTO DE TEMPO: `cron_trigger` usa httpx com timeout=300s. A rota para
 * sozinha antes disso e devolve o que fez — a próxima rodada continua de onde
 * parou (a extração é idempotente: pula quem já tem texto_cache).
 *
 * Auth: Bearer ${CRON_SECRET} ou x-vercel-cron: 1.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { licitacoes, anexos } from "@/db/schema";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { config } from "@/lib/config";
import { processarAnexosDaLicitacao } from "@/lib/licitacoes/extrair-anexos";
import { loggerFor } from "@/lib/observability/logger";
import { verifyCronAuth } from "@/lib/security/secrets";
import { handleApiError } from "@/lib/api/guards";

export async function GET(req: NextRequest) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const log = loggerFor(req, { route: "cron/extrair-anexos" });
  const cfg = config.crons.extrairAnexos;

  if (!cfg.habilitado) {
    return NextResponse.json({ ok: true, skipped: true, motivo: "cron desabilitado" });
  }

  const inicio = Date.now();
  const stats = {
    licitacoes: 0, anexosProcessados: 0, comTexto: 0, falhas: 0,
    esgotouTempo: false,
    /**
     * Backlog REAL, não "o que sobrou desta rodada".
     *
     * A primeira versão inicializava isto com `alvos.length` — que já vem
     * limitado por `maxLicitacoesPorRodada` — e decrementava a cada sucesso.
     * Resultado: uma rodada que limpou as licitações do seu lote reportava
     * `pendentesRestantes: 0` com dezenas ainda na fila. Um número que diz
     * "acabou" quando não acabou é pior que nenhum número: some do radar
     * justamente enquanto o backlog não anda.
     */
    backlogRestante: 0,
  };

  try {
    // Alvo: aberta + relevante + tem anexo com phio_objid ainda sem texto.
    // Ordena por prazo ASC — quem encerra antes é lido antes, porque é essa a
    // licitação em que alguém vai clicar "Analisar" hoje.
    //
    // `erro_download IS NULL` NÃO é detalhe: sem ele, uma licitação cujos únicos
    // pendentes são anexos que falham SEMPRE (ex.: ZIPs de "Anexos de
    // Projeto" acima do teto de 40 MB) seria reselecionada a cada 20 min, para
    // baixar centenas de MB e falhar de novo. Para
    // sempre. Quem quiser insistir num anexo específico tem o botão "Baixar
    // anexos" com `force`, que é decisão humana; o cron não fica em laço.
    const alvos = await db
      .select({ id: licitacoes.id, numero: licitacoes.numero })
      .from(licitacoes)
      .where(
        and(
          eq(licitacoes.fase, "Recebendo Propostas"),
          inArray(licitacoes.relevancia, ["ALTA", "MÉDIA"]),
          isNotNull(licitacoes.dataFim),
          sql`EXISTS (
            SELECT 1 FROM ${anexos} a
            WHERE a.licitacao_id = ${licitacoes.id}
              AND a.phio_objid IS NOT NULL
              AND a.erro_download IS NULL
              AND (a.texto_cache IS NULL OR length(a.texto_cache) <= 100)
          )`,
        ),
      )
      .orderBy(sql`${licitacoes.dataFim} ASC`)
      .limit(cfg.maxLicitacoesPorRodada);

    for (const lic of alvos) {
      // Para ANTES de estourar o timeout do cliente (httpx=300s). Uma licitação
      // com pacote grande pode levar dezenas de segundos; melhor devolver o que
      // foi feito do que ser cortado no meio e perder o relatório.
      if (Date.now() - inicio > cfg.orcamentoSegundos * 1000) {
        stats.esgotouTempo = true;
        log.info("orçamento de tempo esgotado", { feitas: stats.licitacoes, restantes: alvos.length - stats.licitacoes });
        break;
      }

      try {
        const r = await processarAnexosDaLicitacao(lic.id);
        stats.licitacoes++;
        stats.anexosProcessados += r.processados;
        stats.comTexto += r.comTexto;
        if (r.falhas.length > 0) {
          stats.falhas += r.falhas.length;
          log.warn("anexos falharam na extração", { numero: lic.numero, falhas: r.falhas.length });
        }
      } catch (e) {
        // Uma licitação problemática NÃO pode derrubar a rodada inteira — o
        // pacote seguinte pode estar perfeito. Loga e segue.
        stats.falhas++;
        log.warn("licitação falhou na extração", {
          numero: lic.numero, erro: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Backlog recontado DEPOIS do trabalho: é a resposta a "quanto falta ainda",
    // que é a pergunta que importa para saber se a cadência do beat dá conta.
    const [pend] = await db
      .select({ n: sql<number>`count(DISTINCT ${licitacoes.id})::int` })
      .from(licitacoes)
      .where(
        and(
          eq(licitacoes.fase, "Recebendo Propostas"),
          inArray(licitacoes.relevancia, ["ALTA", "MÉDIA"]),
          isNotNull(licitacoes.dataFim),
          sql`EXISTS (
            SELECT 1 FROM ${anexos} a
            WHERE a.licitacao_id = ${licitacoes.id}
              AND a.phio_objid IS NOT NULL
              AND a.erro_download IS NULL
              AND (a.texto_cache IS NULL OR length(a.texto_cache) <= 100)
          )`,
        ),
      );
    stats.backlogRestante = Number(pend?.n ?? 0);

    log.info("extração de anexos concluída", { ...stats, segundos: Math.round((Date.now() - inicio) / 1000) });
    return NextResponse.json({ ok: true, stats });
  } catch (error) {
    return handleApiError(error, req);
  }
}
