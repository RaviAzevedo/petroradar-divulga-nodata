export const runtime = "nodejs";

/**
 * GET /api/cron/vencimentos — Vercel Cron diário
 *
 * Responsabilidades:
 *   1. Para cada documento_habilitacao com validadeFim, gera alertas idempotentes
 *      em D-60 / D-30 / D-15 / D-7 / D-1 / VENCIDO.
 *   2. Para cada família CRC com proximaRenovacaoEm próxima, alerta os admins.
 *   3. Para cada envelope EM_MONTAGEM com pendências e prazo próximo, alerta SGI.
 *   4. Marca status do documento como EM_RENOVACAO (D-30) ou VENCIDO automaticamente.
 *   5. Despacha e-mails via Microsoft Graph e marca alerta.enviadoEm.
 *
 * Idempotência:
 *   - DOCUMENTOS: persistida. Unique (documentoId, tipoAlerta) em alertas_vencimento
 *     + guarda por `enviadoEm` — rodar 2x no mesmo dia não reenvia.
 *   - FAMÍLIAS e ENVELOPES: NÃO persistida (alertas_vencimento.documento_id é NOT NULL,
 *     não cabe alerta sem documento). O que existe é uma trava fraca, em memória do dia:
 *       · famílias: só dispara quando `dias` bate EXATO num limiar (60/30/15/7/1);
 *       · envelopes: dispara todo dia dentro dos 14 dias do protocolo (nag diário, proposital).
 *     Consequência: duas execuções no MESMO dia reenviam esses dois tipos. Fechar isso
 *     exige migration (tabela/coluna de idempotência por família e por envelope).
 *
 * Auth: Bearer ${CRON_SECRET} ou x-vercel-cron: 1 (dev/local).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
  documentosHabilitacao,
  alertasVencimento,
  familias,
  envelopesHabilitacao,
  envelopeItens,
  type TipoAlertaVencimento,
} from "@/db/schema";
import { and, eq, isNull, isNotNull, lte, gte, sql } from "drizzle-orm";
import { sendEmail } from "@/lib/email/send";
import { emailsPorPapel } from "@/lib/email/destinatarios";
import {
  templateVencimentoDocumento,
  templateVencimentoFamilia,
  templateEnvelopeIncompleto,
} from "@/lib/email/templates";
import { loggerFor } from "@/lib/observability/logger";
import { verifyCronAuth } from "@/lib/security/secrets";
import { handleApiError } from "@/lib/api/guards";

// ── Janelas de alerta (dias até vencer) ─────────────────────────────────────

const JANELAS: { tipo: TipoAlertaVencimento; dias: number }[] = [
  { tipo: "D_60", dias: 60 },
  { tipo: "D_30", dias: 30 },
  { tipo: "D_15", dias: 15 },
  { tipo: "D_7",  dias: 7  },
  { tipo: "D_1",  dias: 1  },
];

function diasEntre(de: Date, ate: Date): number {
  const ms = ate.getTime() - de.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const log = loggerFor(req, { route: "cron/vencimentos" });
  const agora = new Date();
  const stats = {
    docsAtualizados:    0,
    alertasDocumentos:  0,
    alertasFamilias:    0,
    alertasEnvelopes:   0,
    emailsEnviados:     0,
    emailsFalhos:       0,
  };

  // Try/catch de topo: falha inesperada loga stats parciais e retorna 500
  // (handleApiError) em vez de mascarar como sucesso ou estourar sem log.
  try {
  // Este cron emite TRÊS tipos distintos e cada um tem sua própria preferência
  // em /admin/emails — um SGI pode querer o alerta de documento e dispensar o
  // de família. Por isso as listas são resolvidas separadamente, e não uma só.
  const [destDocumentos, destFamilias, destEnvelopes] = await Promise.all([
    emailsPorPapel("VENCIMENTO_DOCUMENTO"),
    emailsPorPapel("VENCIMENTO_FAMILIA"),
    emailsPorPapel("ENVELOPE_INCOMPLETO"),
  ]);
  if (destDocumentos.length === 0 && destFamilias.length === 0 && destEnvelopes.length === 0) {
    log.warn("Nenhum destinatário (ADMIN/LIDER/SGI) ativo para os tipos de vencimento");
  }

  // ── 1. Atualizar status de documentos automaticamente ─────────────────────
  // VIGENTE → EM_RENOVACAO (D-30) → VENCIDO (passou da validade)

  const updRenovacao = await db.execute(sql`
    UPDATE documentos_habilitacao
    SET status = 'EM_RENOVACAO', atualizado_em = NOW()
    WHERE status = 'VIGENTE'
      AND validade_indeterminada = false
      AND validade_fim IS NOT NULL
      AND validade_fim <= NOW() + INTERVAL '30 days'
      AND validade_fim > NOW()
  `);
  stats.docsAtualizados += Number((updRenovacao as unknown as { rowCount?: number })?.rowCount ?? 0);

  const updVencido = await db.execute(sql`
    UPDATE documentos_habilitacao
    SET status = 'VENCIDO', atualizado_em = NOW()
    WHERE status IN ('VIGENTE', 'EM_RENOVACAO')
      AND validade_indeterminada = false
      AND validade_fim IS NOT NULL
      AND validade_fim <= NOW()
  `);
  stats.docsAtualizados += Number((updVencido as unknown as { rowCount?: number })?.rowCount ?? 0);

  // ── 2. Documentos vencendo: alertas D-60..D-1 + VENCIDO ───────────────────

  const docsRelevantes = await db
    .select({
      id:           documentosHabilitacao.id,
      titulo:       documentosHabilitacao.titulo,
      categoria:    documentosHabilitacao.categoria,
      subcategoria: documentosHabilitacao.subcategoria,
      validadeFim:  documentosHabilitacao.validadeFim,
    })
    .from(documentosHabilitacao)
    .where(
      and(
        eq(documentosHabilitacao.validadeIndeterminada, false),
        isNotNull(documentosHabilitacao.validadeFim),
        // só alerta docs cuja validade está numa das janelas (passada até VENCIDO)
        lte(documentosHabilitacao.validadeFim, sql`NOW() + INTERVAL '60 days'`),
        // 0034/S17 (02-APIS §16-B.4): cron sem sessão → literal. Título de
        // contrato sob cláusula NÃO entra em e-mail broadcast (o transporte
        // Graph envia e-mail REAL). Espelha cron_vencimentos.py do BFF — o
        // NGINX manda /api/cron/ para o Next.
        eq(documentosHabilitacao.restrito, false),
      ),
    );

  for (const doc of docsRelevantes) {
    // Cada documento em try/catch próprio: 1 falha não derruba o job inteiro.
    try {
    if (!doc.validadeFim) continue;
    const validade = new Date(doc.validadeFim);
    const dias = diasEntre(agora, validade);

    // Determina o tipo de alerta correspondente à situação atual
    let tipo: TipoAlertaVencimento | null = null;
    if (dias < 0) tipo = "VENCIDO";
    else if (dias === 0 || dias === 1) tipo = "D_1";
    else if (dias <= 7) tipo = "D_7";
    else if (dias <= 15) tipo = "D_15";
    else if (dias <= 30) tipo = "D_30";
    else if (dias <= 60) tipo = "D_60";

    if (!tipo) continue;

    // Idempotência: skip se já existe alerta desse tipo pra esse doc
    const [existente] = await db
      .select({ id: alertasVencimento.id, enviadoEm: alertasVencimento.enviadoEm })
      .from(alertasVencimento)
      .where(
        and(
          eq(alertasVencimento.documentoId, doc.id),
          eq(alertasVencimento.tipoAlerta, tipo),
        ),
      )
      .limit(1);

    if (existente?.enviadoEm) continue; // já alertado

    const tpl = templateVencimentoDocumento({
      documentoId:   doc.id,
      titulo:        doc.titulo,
      categoria:     doc.categoria,
      subcategoria:  doc.subcategoria,
      validadeFim:   validade,
      diasRestantes: dias,
      // O template imprime isto numa linha visível ("Alerta"). O enum do banco é
      // D_60/D_7 (underscore); o contrato do template é "D-60". Formata aqui para
      // não vazar identificador interno no corpo do e-mail — `tipo` (o enum cru)
      // continua sendo o que vai para o banco logo abaixo.
      tipoAlerta:    tipo.replace("_", "-"),
    });

    let emailOk = false;
    if (destDocumentos.length > 0) {
      const r = await sendEmail({
        to:      destDocumentos,
        subject: tpl.subject,
        html:    tpl.html,
        text:    tpl.text,
      });
      emailOk = r.ok;
      if (r.ok) stats.emailsEnviados++;
      else stats.emailsFalhos++;
    }

    if (existente) {
      await db
        .update(alertasVencimento)
        .set({
          enviadoEm:     emailOk ? new Date() : null,
          destinatarios: destDocumentos,
        })
        .where(eq(alertasVencimento.id, existente.id));
    } else {
      await db.insert(alertasVencimento).values({
        documentoId:   doc.id,
        tipoAlerta:    tipo,
        agendadoPara:  agora,
        enviadoEm:     emailOk ? new Date() : null,
        destinatarios: destDocumentos,
      });
    }

    stats.alertasDocumentos++;
    } catch (e) {
      log.error("falha ao processar alerta de documento", e, { documentoId: doc.id });
    }
  }

  // ── 3. Famílias CRC entrando na janela de renovação ───────────────────────

  const famsRelevantes = await db
    .select({
      id:                 familias.id,
      codigoCrc:          familias.codigoCrc,
      nome:               familias.nome,
      validadeFim:        familias.validadeFim,
      segmentoPetrobras:  familias.segmentoPetrobras,
    })
    .from(familias)
    .where(
      and(
        isNull(familias.deletadoEm),
        isNotNull(familias.validadeFim),
        lte(familias.validadeFim, sql`NOW() + INTERVAL '60 days'`),
        gte(familias.validadeFim, sql`NOW()`),
      ),
    );

  // Limiares de janela (em dias) — do mais urgente ao mais distante.
  const LIMIARES_FAMILIA = [1, 7, 15, 30, 60];

  for (const fam of famsRelevantes) {
    // Cada família em try/catch próprio: 1 falha não derruba o job inteiro.
    try {
    if (!fam.validadeFim) continue;
    const validade = new Date(fam.validadeFim);
    const dias = diasEntre(agora, validade);

    // Famílias NÃO têm idempotência persistida (a tabela alertas_vencimento exige
    // documentoId NOT NULL). Por isso mantemos a comparação de igualdade exata
    // (dias === 60/30/15/7/1): no máximo 5 e-mails por família. Usar `<=` aqui
    // dispararia e-mail TODO dia dentro da janela (spam). A cobertura contígua
    // (não perder a janela se o cron pular um dia) fica deferida até existir
    // persistência de alerta por família (migration: coluna/tabela de idempotência).
    if (dias < 0 || dias > 60) continue;
    const limiar = LIMIARES_FAMILIA.find((l) => dias === l);
    if (limiar == null) continue;

    const tpl = templateVencimentoFamilia({
      familiaId:         fam.id,
      codigoCrc:         fam.codigoCrc,
      nome:              fam.nome,
      validadeFim:       validade,
      diasRestantes:     dias,
      segmentoPetrobras: fam.segmentoPetrobras,
    });

    if (destFamilias.length > 0) {
      const r = await sendEmail({
        to:      destFamilias,
        subject: tpl.subject,
        html:    tpl.html,
        text:    tpl.text,
      });
      if (r.ok) stats.emailsEnviados++;
      else stats.emailsFalhos++;
    }
    stats.alertasFamilias++;
    } catch (e) {
      log.error("falha ao processar alerta de família", e, { familiaId: fam.id });
    }
  }

  // ── 4. Envelopes EM_MONTAGEM com pendências ───────────────────────────────

  const envelopesAtivos = await db
    .select({
      id:             envelopesHabilitacao.id,
      numeroEdital:   envelopesHabilitacao.numeroEdital,
      prazoProtocolo: envelopesHabilitacao.prazoProtocolo,
    })
    .from(envelopesHabilitacao)
    .where(
      and(
        eq(envelopesHabilitacao.status, "EM_MONTAGEM"),
        isNotNull(envelopesHabilitacao.prazoProtocolo),
        lte(envelopesHabilitacao.prazoProtocolo, sql`NOW() + INTERVAL '14 days'`),
      ),
    );

  for (const env of envelopesAtivos) {
    // Cada envelope em try/catch próprio: 1 falha não derruba o job inteiro.
    try {
    const itens = await db
      .select({
        status: envelopeItens.status,
      })
      .from(envelopeItens)
      .where(eq(envelopeItens.envelopeId, env.id));

    const total = itens.length;
    const faltantes = itens.filter((i) => i.status === "PENDENTE").length;
    const vencidos  = itens.filter((i) => i.status === "VENCIDO" || i.status === "VENCE_ANTES_DO_PROTOCOLO").length;

    if (faltantes + vencidos === 0) continue;

    const tpl = templateEnvelopeIncompleto({
      envelopeId:     env.id,
      // Sem slice(0,40): o número do edital é a CHAVE do e-mail e aparece inteiro
      // no corpo e no text/. O clamp de assunto agora é do template (assunto()
      // corta a chave sozinho, com reticências); truncar aqui só corrompia o dado.
      numeroEdital:   env.numeroEdital,
      prazoProtocolo: env.prazoProtocolo,
      totalItens:     total,
      itensFaltantes: faltantes,
      itensVencidos:  vencidos,
    });

    if (destEnvelopes.length > 0) {
      const r = await sendEmail({
        to:      destEnvelopes,
        subject: tpl.subject,
        html:    tpl.html,
        text:    tpl.text,
      });
      if (r.ok) stats.emailsEnviados++;
      else stats.emailsFalhos++;
    }
    stats.alertasEnvelopes++;
    } catch (e) {
      log.error("falha ao processar alerta de envelope", e, { envelopeId: env.id });
    }
  }

  log.info("execução concluída", { stats });

  return NextResponse.json({ ok: true, stats });
  } catch (e) {
    log.error("falha geral no cron de vencimentos", e, { stats });
    return handleApiError(e);
  }
}
