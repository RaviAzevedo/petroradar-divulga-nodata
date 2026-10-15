export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * GET /api/cron/convocacao-watch
 *
 * Radar de Convocação do Remanescente (2º colocado) pós-resultado.
 *
 * Cruza propostas onde cnpj = Proponente e posicao >= posicaoMinima (config) com
 * eventos DESCLASSIFICADO/DESISTIU recém-inseridos (convocacao_notificada_em IS NULL):
 * quando um concorrente à frente sai, a Proponente sobe na fila e pode ser a próxima
 * elegível. Para cada gatilho:
 *   1. Envia e-mail "você é o próximo elegível" aos ADMIN/LIDER ativos.
 *      (Antes também gravava no sininho in-app, que saiu com Participações.)
 *   2. Marca licitacao_eventos_vencedor.convocacao_notificada_em (dedup).
 *
 * Segurança: Bearer ${CRON_SECRET} ou x-vercel-cron: 1.
 * Escritas via db.batch (neon-http NÃO suporta db.transaction).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { licitacaoEventosVencedor } from "@/db/schema";
import { eq } from "drizzle-orm";
import { config } from "@/lib/config";
import { sendEmail } from "@/lib/email/send";
import { destinatariosPorPapel } from "@/lib/email/destinatarios";
import { templateConvocacaoRemanescente } from "@/lib/email/templates";
import { listarGatilhosConvocacao } from "@/lib/eventos-vencedor/convocacao-watch";
import { loggerFor } from "@/lib/observability/logger";

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

  const log = loggerFor(req, { route: "cron/convocacao-watch" });

  if (!config.crons.convocacaoWatch.habilitado) {
    return NextResponse.json({ ok: true, skipped: true, motivo: "cron desabilitado" });
  }

  const agora = new Date();
  const stats = { gatilhos: 0, emailsEnviados: 0, emailsFalhos: 0 };

  const gatilhos = await listarGatilhosConvocacao();

  if (gatilhos.length === 0) {
    log.info("nenhum gatilho de convocação");
    return NextResponse.json({ ok: true, stats, executadoEm: agora.toISOString() });
  }

  // Destinatários: gestão ativa (ADMIN/LIDER) que não desligou "Convocação de
  // remanescente" — alerta de oportunidade estratégica.
  const destValidos = await destinatariosPorPapel("CONVOCACAO_REMANESCENTE");

  for (const g of gatilhos) {
    stats.gatilhos++;

    if (destValidos.length > 0) {
      const template = templateConvocacaoRemanescente({
        licitacaoId:           g.licitacaoId ?? "",
        numero:                g.numeroLicitacao,
        objeto:                g.objeto,
        posicaoProponente:       g.posicaoProponente,
        empresaAnterior:       g.fornecedorQueSaiu,
        tipoEvento:            g.tipoEvento,
        motivo:                g.motivo,
        dataEvento:            g.dataEvento ? new Date(g.dataEvento) : agora,
        valorPropostaProponente:
          g.valorPropostaProponente != null ? String(g.valorPropostaProponente) : null,
      });

      for (const u of destValidos) {
        const resultado = await sendEmail({
          to:      u.email,
          subject: template.subject,
          html:    template.html,
          text:    template.text,
        });

        if (resultado.ok) {
          stats.emailsEnviados++;
        } else {
          stats.emailsFalhos++;
        }
      }
    }

    // Dedup: marca o evento como notificado (não re-dispara).
    await db
      .update(licitacaoEventosVencedor)
      .set({ convocacaoNotificadaEm: agora })
      .where(eq(licitacaoEventosVencedor.id, g.eventoId));
  }

  log.info("execução concluída", { stats });

  return NextResponse.json({ ok: true, stats, executadoEm: agora.toISOString() });
}
