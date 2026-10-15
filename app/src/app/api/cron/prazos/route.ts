export const runtime = "nodejs";

/**
 * GET /api/cron/prazos
 *
 * Job diário disparado pelo beat do worker (cron-prazos).
 *
 * Responsabilidades:
 *   0. Marca como "Prazo Encerrado" as licitações cujo data_fim já passou.
 *   1. Alerta de prazo crítico: UM e-mail consolidado com as licitações de
 *      relevância ALTA/MÉDIA que cruzaram uma banda de urgência (7/3/1/0 dias).
 *
 * Os alertas de prazo de PARTICIPAÇÃO (portal/interno) e o reenvio de
 * notificações in-app saíram com o módulo Participações (removido).
 *
 * Segurança: Bearer ${CRON_SECRET} (verifyCronAuth, timing-safe).
 *
 * Retorna:
 *   { ok, stats: { fasesAtualizadas, prazoCriticoAlerts, emailsEnviados, emailsFalhos } }
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { licitacoes, historicoAlteracoes } from "@/db/schema";
import { eq, and, inArray, gte, lt, isNotNull, sql } from "drizzle-orm";
import { sendEmail } from "@/lib/email/send";
import { destinatariosPorPapel } from "@/lib/email/destinatarios";
import { templatePrazosCriticos, type PrazoCriticoItem } from "@/lib/email/templates";
import { loggerFor } from "@/lib/observability/logger";
import { verifyCronAuth } from "@/lib/security/secrets";
import { handleApiError } from "@/lib/api/guards";
import { config } from "@/lib/config";

/**
 * Bandas de urgência do alerta de prazo, da mais urgente para a menos.
 * ORDEM IMPORTA: o `find` pega a PRIMEIRA que comporta os dias restantes, então
 * 2 dias cai em 3 (e não em 7). São elas que definem quando um aviso sai — ver
 * o bloco 1 do handler.
 */
const BANDAS_PRAZO = [0, 1, 3, 7] as const;

/**
 * Data "hoje" no fuso de Brasília (America/Sao_Paulo, offset -03:00) no formato
 * YYYY-MM-DD. O `data_fim` das licitações é uma string de data civil brasileira,
 * então comparar contra a data UTC erra perto da virada do dia (a UTC vira o dia
 * 3h antes). Usamos en-CA para obter o formato ISO direto.
 */
function hojeBrasilia(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year:  "numeric",
    month: "2-digit",
    day:   "2-digit",
  }).format(new Date());
}

// ── Handler principal ────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const log    = loggerFor(req, { route: "cron/prazos" });
  const agora  = new Date();
  const stats  = { fasesAtualizadas: 0, prazoCriticoAlerts: 0, emailsEnviados: 0, emailsFalhos: 0 };

  // Try/catch de topo: falha inesperada loga stats parciais e retorna 500
  // (handleApiError) em vez de mascarar como sucesso.
  try {
  // ── 0. Atualizar fases de licitações vencidas ─────────────────────────────
  // Licitações com data_fim no passado que ainda estão como "Recebendo Propostas"
  // ou "Agendada (Futura)" devem mudar para "Prazo Encerrado".
  // Preserva a data_fim original — só muda o campo fase.
  // "hoje" calculado no fuso de Brasília (não UTC) para não encerrar prazos
  // um dia cedo durante a virada do dia.
  const hoje = hojeBrasilia();

  const updateResult = await db.execute(sql`
    UPDATE licitacoes
    SET fase = 'Prazo Encerrado', atualizado_em = NOW()
    WHERE fase IN ('Recebendo Propostas', 'Agendada (Futura)')
      AND data_fim IS NOT NULL
      AND data_fim != ''
      AND data_fim < ${hoje}
  `);

  stats.fasesAtualizadas = Number((updateResult as unknown as { rowCount?: number })?.rowCount ?? 0);

  if (stats.fasesAtualizadas > 0) {
    log.info("licitações marcadas como Prazo Encerrado", { atualizadas: stats.fasesAtualizadas });
  }

  // ── 1. Alertas de prazo crítico — UM e-mail consolidado ────────────────────
  //
  // ANTES: um e-mail POR licitação, janela de 3 dias, dedup por "já notifiquei
  // nas últimas 24h". Dois problemas reais:
  //
  //   (a) VOLUME. Com várias licitações ALTA/MÉDIA encerrando no
  //       MESMO dia, saíam vários e-mails com a mesma cara para as mesmas pessoas.
  //   (b) A JANELA DE 24h ERA UMA CORRIDA. O cron roda todo dia no mesmo
  //       horário; se a rodada de hoje começa 1,3s antes da de ontem, o registro
  //       de ontem ainda está DENTRO de `NOW() - INTERVAL '24 hours'` e a
  //       licitação é pulada. O alerta sumia por sorte de milissegundo.
  //
  // AGORA: dedup por BANDA CRUZADA. Cada licitação tem uma banda (0, 1, 3 ou 7
  // dias). Ela só entra no e-mail quando cruza para uma banda MAIS urgente do
  // que qualquer uma já alertada. Isso dá no máximo 4 avisos por licitação ao
  // longo de toda a vida dela, é imune a jitter de horário (compara banda, não
  // timestamp) e o aviso passa a significar algo: "mudou de faixa".
  {
    const cfg = config.crons.prazosCriticos;
    if (!cfg.habilitado) {
      log.info("alerta de prazo crítico desabilitado por config");
    } else {
    const hojeStr = hojeBrasilia();
    const limite = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year:  "numeric",
      month: "2-digit",
      day:   "2-digit",
    }).format(new Date(agora.getTime() + cfg.janelaDias * 24 * 60 * 60 * 1000));

    const licsProximas = await db
      .select({
        id:         licitacoes.id,
        numero:     licitacoes.numero,
        objeto:     licitacoes.objeto,
        empresa:    licitacoes.empresa,
        relevancia: licitacoes.relevancia,
        dataFim:    licitacoes.dataFim,
        horaFim:    licitacoes.horaFim,
      })
      .from(licitacoes)
      .where(
        and(
          eq(licitacoes.fase, "Recebendo Propostas"),
          inArray(licitacoes.relevancia, ["ALTA", "MÉDIA"]),
          isNotNull(licitacoes.dataFim),
          gte(licitacoes.dataFim, hojeStr),
          lt(licitacoes.dataFim, limite),
        )
      );

    if (licsProximas.length > 0) {
      // Menor banda JÁ alertada por licitação. Registros antigos (do modelo por
      // e-mail unitário) têm valor_anterior NULL e são ignorados de propósito:
      // eles não dizem em que banda o aviso saiu, então na primeira rodada do
      // modelo novo cada licitação viva alerta uma vez. É transição, não bug.
      const jaAlertado = new Map<string, number>();
      const historico = await db
        .select({
          licitacaoId: historicoAlteracoes.licitacaoId,
          banda:       sql<number>`MIN(${historicoAlteracoes.valorAnterior}::int)`,
        })
        .from(historicoAlteracoes)
        .where(
          and(
            eq(historicoAlteracoes.campo, "alerta_prazo_critico"),
            inArray(historicoAlteracoes.licitacaoId, licsProximas.map((l) => l.id)),
            sql`${historicoAlteracoes.valorAnterior} ~ '^[0-9]+$'`,
          )
        )
        .groupBy(historicoAlteracoes.licitacaoId);
      for (const h of historico) {
        if (h.licitacaoId) jaAlertado.set(h.licitacaoId, Number(h.banda));
      }

      const novos: Array<{ item: PrazoCriticoItem; banda: number }> = [];
      for (const lic of licsProximas) {
        if (!lic.dataFim) continue;

        // Fim do dia no fuso de Brasília (-03:00), não no fuso do servidor.
        const fimDate = new Date(lic.dataFim + "T23:59:59-03:00");
        const diasRestantes = Math.max(
          0,
          Math.ceil((fimDate.getTime() - agora.getTime()) / (24 * 60 * 60 * 1000)),
        );
        const banda = BANDAS_PRAZO.find((b) => diasRestantes <= b) ?? BANDAS_PRAZO[BANDAS_PRAZO.length - 1];

        const anterior = jaAlertado.get(lic.id);
        if (anterior !== undefined && banda >= anterior) continue; // não subiu de urgência

        novos.push({
          banda,
          item: {
            licitacaoId: lic.id,
            numero:      lic.numero,
            objeto:      lic.objeto ?? "",
            empresa:     lic.empresa ?? "",
            relevancia:  lic.relevancia ?? "ALTA",
            dataFim:     lic.dataFim,
            horaFim:     lic.horaFim ?? null,
            diasRestantes,
          },
        });
      }

      if (novos.length === 0) {
        log.info("nenhuma licitação cruzou banda de prazo", { janela: licsProximas.length });
      } else {
        const destinatarios = await destinatariosPorPapel("PRAZO_CRITICO_LICITACAO");
        const emails = destinatarios.map((u) => u.email).filter(Boolean) as string[];

        if (emails.length === 0) {
          log.warn("licitações cruzaram banda mas não há destinatário para PRAZO_CRITICO_LICITACAO", {
            licitacoes: novos.length,
          });
        } else {
          const template = templatePrazosCriticos({
            itens:      novos.map((n) => n.item),
            janelaDias: cfg.janelaDias,
          });

          const resultado = await sendEmail({
            to:      emails,
            subject: template.subject,
            html:    template.html,
            text:    template.text,
          });

          // O ledger só é gravado se o e-mail SAIU. Gravar antes faria uma falha
          // de SMTP queimar a banda em silêncio — a licitação nunca mais
          // alertaria naquela faixa. Falhou, tenta de novo amanhã.
          if (resultado.ok) {
            await db.insert(historicoAlteracoes).values(
              novos.map((n) => ({
                licitacaoId:   n.item.licitacaoId,
                campo:         "alerta_prazo_critico",
                valorAnterior: String(n.banda),
                valorNovo:     `${n.item.diasRestantes}d — banda ${n.banda}, enviado para ${emails.length} destinatário(s)`,
                notificado:    true,
              }))
            );
            stats.emailsEnviados++;
            stats.prazoCriticoAlerts += novos.length;
            log.info("alerta consolidado de prazo enviado", {
              licitacoes:    novos.length,
              destinatarios: emails.length,
              janela:        licsProximas.length,
            });
          } else {
            stats.emailsFalhos++;
            log.error("falha ao enviar alerta consolidado de prazo", {
              licitacoes: novos.length,
              erro:       resultado.error,
            });
          }
        }
      }
    }
    }
  }


  log.info("execução concluída", { stats });

  return NextResponse.json({ ok: true, stats, executadoEm: agora.toISOString() });
  } catch (e) {
    log.error("falha geral no cron de prazos", e, { stats });
    return handleApiError(e);
  }
}
