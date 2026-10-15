export const runtime = "nodejs";

/**
 * GET /api/cron/saude-contratos — Vercel Cron diário 13:30 UTC
 *
 * Para cada contrato ATIVO, recalcula statusSaude:
 *   OK       — todos docs obrigatórios cobertos e válidos durante todo o contrato
 *   ATENCAO  — algum doc vence em 30-90 dias
 *   CRITICO  — algum doc vencido OU vence antes do fim do contrato
 *
 * Quando muda OK→ATENCAO/CRITICO, dispara alerta por e-mail pro responsavelSgi
 * (ou pra todos da Conformidade se não houver responsável).
 *
 * Auth: Bearer ${CRON_SECRET} ou x-vercel-cron: 1.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
  contratosExecucao,
  envelopeItens,
  documentosHabilitacao,
  requisitosEdital,
  licitacoes,
  type StatusSaudeContrato,
} from "@/db/schema";
import { and, eq, isNull, or } from "drizzle-orm";
import { sendEmail } from "@/lib/email/send";
import { destinatariosComFallback } from "@/lib/email/destinatarios";
import { templateContratoCritico } from "@/lib/email/templates";
import { loggerFor } from "@/lib/observability/logger";
import { verifyCronAuth } from "@/lib/security/secrets";
import { handleApiError } from "@/lib/api/guards";
import { calcularGapHabilitacao } from "@/lib/licitacoes/gap-habilitacao";

interface MotivoCritico {
  texto: string;
  vencido: boolean;
}

/**
 * Calcula statusSaude e motivos a partir dos itens do envelope vinculado
 * (se houver) e dos documentos referenciados.
 */
async function avaliarSaude(contrato: typeof contratosExecucao.$inferSelect): Promise<{
  statusNovo: StatusSaudeContrato;
  motivos: MotivoCritico[];
}> {
  const motivos: MotivoCritico[] = [];

  if (!contrato.envelopeId) {
    // Sem envelope, não temos itens — não conseguimos avaliar.
    return { statusNovo: "OK", motivos: [] };
  }

  // Itens do envelope com seus docs e validades
  const itens = await db
    .select({
      itemStatus:    envelopeItens.status,
      reqCodigo:     requisitosEdital.codigo,
      reqDescricao:  requisitosEdital.descricao,
      reqObrigatorio: requisitosEdital.obrigatorio,
      docId:         envelopeItens.documentoId,
      docTitulo:     documentosHabilitacao.titulo,
      docValidadeFim: documentosHabilitacao.validadeFim,
      docIndeterm:   documentosHabilitacao.validadeIndeterminada,
      docStatus:     documentosHabilitacao.status,
    })
    .from(envelopeItens)
    .innerJoin(requisitosEdital, eq(envelopeItens.requisitoId, requisitosEdital.id))
    .leftJoin(
      documentosHabilitacao,
      and(
        eq(envelopeItens.documentoId, documentosHabilitacao.id),
        // 0034/S18 (02-APIS §16-B.4): cron sem sessão → literal. Doc restrito
        // não entra no e-mail de contrato crítico (o título iria no motivo);
        // sem o match do join a linha degrada para "Sem documento atribuído".
        // Espelha cron_saude_contratos.py do BFF (`dh.restrito = false OR
        // dh.restrito IS NULL`) — o NGINX manda /api/cron/ para o Next.
        or(eq(documentosHabilitacao.restrito, false), isNull(documentosHabilitacao.restrito)),
      ),
    )
    .where(eq(envelopeItens.envelopeId, contrato.envelopeId));

  let critico = false;
  let atencao = false;
  const fimContrato = contrato.periodoFim;
  const agora = new Date();
  const em90 = new Date(agora.getTime() + 90 * 24 * 60 * 60 * 1000);

  for (const it of itens) {
    if (!it.reqObrigatorio) continue;

    if (!it.docId) {
      critico = true;
      motivos.push({ texto: `Sem documento atribuído para "${it.reqDescricao}"`, vencido: true });
      continue;
    }
    if (it.docStatus === "VENCIDO") {
      critico = true;
      motivos.push({ texto: `${it.docTitulo} (${it.reqCodigo}) está vencido`, vencido: true });
      continue;
    }
    if (it.docIndeterm) continue;
    if (!it.docValidadeFim) continue;

    const validade = new Date(it.docValidadeFim);
    if (validade < agora) {
      critico = true;
      motivos.push({ texto: `${it.docTitulo} (${it.reqCodigo}) vencido em ${validade.toLocaleDateString("pt-BR")}`, vencido: true });
    } else if (validade < fimContrato) {
      // Vence antes do fim do contrato — crítico
      critico = true;
      motivos.push({ texto: `${it.docTitulo} (${it.reqCodigo}) vence em ${validade.toLocaleDateString("pt-BR")}, antes do fim do contrato`, vencido: false });
    } else if (validade < em90) {
      atencao = true;
      motivos.push({ texto: `${it.docTitulo} (${it.reqCodigo}) vence em ${validade.toLocaleDateString("pt-BR")}`, vencido: false });
    }
  }

  return {
    statusNovo: critico ? "CRITICO" : atencao ? "ATENCAO" : "OK",
    motivos,
  };
}

export async function GET(req: NextRequest) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const log   = loggerFor(req, { route: "cron/saude-contratos" });
  const stats = {
    avaliados: 0, mudou: 0, criticos: 0, atencao: 0, emailsEnviados: 0, emailsFalhos: 0,
    // Piggyback: recálculo em lote do gap de habilitação.
    gapRecalculados: 0,
    gapFalhas: 0,
  };

  // Try/catch de topo: uma falha inesperada loga stats parciais e retorna 500
  // (handleApiError), sem mascarar o erro como sucesso.
  try {
    const ativos = await db
      .select()
      .from(contratosExecucao)
      .where(eq(contratosExecucao.status, "ATIVO"));

    for (const c of ativos) {
      // Cada contrato em try/catch próprio: 1 falha não derruba o job inteiro.
      try {
        stats.avaliados++;
        const { statusNovo, motivos } = await avaliarSaude(c);

        const mudou = c.statusSaude !== statusNovo;
        if (mudou) {
          await db
            .update(contratosExecucao)
            .set({ statusSaude: statusNovo, atualizadoEm: new Date() })
            .where(eq(contratosExecucao.id, c.id));
          stats.mudou++;
        }

        if (statusNovo === "CRITICO") stats.criticos++;
        else if (statusNovo === "ATENCAO") stats.atencao++;

        // Alerta apenas quando piorou para CRITICO
        if (mudou && statusNovo === "CRITICO") {
          // Responsável de SGI do contrato primeiro, depois o fallback
          // ADMIN/LIDER/SGI — deduplicado, e já sem quem desligou o tipo.
          const destinatarios = (
            await destinatariosComFallback("CONTRATO_CRITICO", c.responsavelSgi)
          ).map((d) => d.email);
          if (destinatarios.length > 0) {
            const tpl = templateContratoCritico({
              contratoId:      c.id,
              numero:          c.numero,
              objeto:          c.objeto,
              periodoFim:      c.periodoFim,
              motivosCriticos: motivos.map((m) => m.texto).slice(0, 10),
            });
            const r = await sendEmail({
              to:      destinatarios,
              subject: tpl.subject,
              html:    tpl.html,
              text:    tpl.text,
            });
            if (r.ok) stats.emailsEnviados++;
            else stats.emailsFalhos++;
          }
        }
      } catch (e) {
        log.error("falha ao avaliar contrato", e, { contratoId: c.id });
      }
    }

    // ── Piggyback: recálculo em lote do gap de habilitação ───────────────────
    // Reaproveita a janela do cron diário para recalcular o gap das licitações que
    // têm requisitos estruturados extraídos (caso contrário o cruzamento é vazio).
    // usarIA:false para conter custo — requisitos ambíguos ficam FALTANTE; o gap
    // sob demanda (rota POST) faz o refinamento com IA quando necessário.
    try {
      const candidatas = await db
        .selectDistinct({ licitacaoId: requisitosEdital.licitacaoId })
        .from(requisitosEdital)
        .innerJoin(licitacoes, eq(licitacoes.id, requisitosEdital.licitacaoId))
        .where(eq(licitacoes.fase, "Recebendo Propostas"))
        .limit(50);

      for (const cand of candidatas) {
        try {
          await calcularGapHabilitacao(cand.licitacaoId, { usarIA: false });
          stats.gapRecalculados++;
        } catch (errItem) {
          stats.gapFalhas++;
          log.error("falha no recálculo de gap (piggyback)", errItem, { licitacaoId: cand.licitacaoId });
        }
      }
    } catch (err) {
      log.error("falha ao selecionar candidatas de gap (piggyback)", err);
    }

    log.info("execução concluída", { stats });
    return NextResponse.json({ ok: true, stats });
  } catch (e) {
    log.error("falha geral no cron de saúde de contratos", e, { stats });
    return handleApiError(e);
  }
}
