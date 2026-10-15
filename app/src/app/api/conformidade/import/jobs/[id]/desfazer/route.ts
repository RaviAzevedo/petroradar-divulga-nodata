export const runtime = "nodejs";

/**
 * POST /api/conformidade/import/jobs/[id]/desfazer — Desfaz uma rodada de
 * ingestão (R15, 0034): apaga os documentos que o job criou, reverte as
 * adoções que ele fez em documentos PRÉ-existentes e fecha o job.
 *
 * Body: { confirmar: true, forcar?: boolean } — `forcar` só desarma a etapa 0
 * (recusa por uso a jusante: envelope_itens/gap_habilitacao são SET NULL e
 * apagar esvaziaria slot de envelope em silêncio).
 *
 * Ordem "linhas primeiro, objetos depois": etapas 1–4 numa transação única;
 * o MinIO (etapa 5) fica FORA dela — se morrer no meio sobram blobs órfãos,
 * nunca linhas apontando para blob inexistente.
 *
 * O CLI de ingestão (comando desfazer) implementa as MESMAS etapas — a
 * spec SQL de 02-APIS §14 é a fonte única dos dois.
 *
 * Guard: requireAdmin (apagar em massa é o nível do DELETE de documento).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
  documentosHabilitacao,
  importJobs,
  envelopeItens,
  gapHabilitacao,
  documentosFamilias,
  auditLog,
  type PapelDocumento,
  type TipoDocumento,
  type SituacaoProva,
  type Detentora,
} from "@/db/schema";
import { and, eq, sql, count } from "drizzle-orm";
import { requireAdmin, handleApiError } from "@/lib/api/guards";
import { ehUuid } from "@/lib/conformidade/operacoes/validations";
import {
  DETENTORAS,
  PAPEIS_DOCUMENTO,
  SITUACOES_PROVA,
  TIPOS_DOCUMENTO,
} from "@/lib/conformidade/operacoes";
import { deleteDocumento } from "@/lib/storage/upload";

type Params = { params: Promise<{ id: string }> };

/** camposPreenchidos como o IMPORT_ADOCAO (R13) grava — tudo string. */
interface CamposAdocao {
  operacaoId?: string;
  papel?: string;
  tipoDocumento?: string;
  situacaoProva?: string;
  detentora?: string;
}

export async function POST(request: NextRequest, { params }: Params) {
  let session;
  try {
    ({ session } = await requireAdmin());
  } catch (e) {
    return handleApiError(e);
  }

  const { id } = await params;
  if (!ehUuid(id)) {
    return NextResponse.json({ error: "Job não encontrado" }, { status: 404 });
  }
  const [job] = await db
    .select({ id: importJobs.id })
    .from(importJobs)
    .where(eq(importJobs.id, id))
    .limit(1);
  if (!job) {
    return NextResponse.json({ error: "Job não encontrado" }, { status: 404 });
  }

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  const corpo = (body ?? {}) as { confirmar?: unknown; forcar?: unknown };
  if (corpo.confirmar !== true) {
    return NextResponse.json(
      { error: "Envie confirmar:true para desfazer o job" },
      { status: 422 }
    );
  }
  // Só `true` literal desarma a etapa 0.
  const forcar = corpo.forcar === true;

  // ── Etapa 0 — recusa por uso a jusante ────────────────────────────────────
  const [[envRow], [gapRow], [famRow]] = await Promise.all([
    db
      .select({ total: count() })
      .from(envelopeItens)
      .innerJoin(documentosHabilitacao, eq(documentosHabilitacao.id, envelopeItens.documentoId))
      .where(eq(documentosHabilitacao.importJobId, id)),
    db
      .select({ total: count() })
      .from(gapHabilitacao)
      .innerJoin(documentosHabilitacao, eq(documentosHabilitacao.id, gapHabilitacao.documentoId))
      .where(eq(documentosHabilitacao.importJobId, id)),
    db
      .select({ total: count() })
      .from(documentosFamilias)
      .innerJoin(documentosHabilitacao, eq(documentosHabilitacao.id, documentosFamilias.documentoId))
      .where(eq(documentosHabilitacao.importJobId, id)),
  ]);

  const usoAJusante = {
    envelopeItens: envRow?.total ?? 0,
    gaps:          gapRow?.total ?? 0,
    familias:      famRow?.total ?? 0,
  };

  if (!forcar && (usoAJusante.envelopeItens > 0 || usoAJusante.gaps > 0 || usoAJusante.familias > 0)) {
    return NextResponse.json(
      {
        error: `Job em uso a jusante: ${usoAJusante.envelopeItens} itens de envelope, ` +
          `${usoAJusante.gaps} gaps, ${usoAJusante.familias} vínculos de família — repita com forcar:true`,
        code: "JOB_EM_USO",
        detalhes: usoAJusante,
      },
      { status: 409 }
    );
  }

  // ── Etapas 1–4 — transação única ──────────────────────────────────────────
  const { apagados, blobKeys, adocoesDesfeitas } = await db.transaction(async (tx) => {
    // 1. DELETE com captura: a cascata leva anexos, documentos_familias e
    // alertas; envelope_itens/gap_habilitacao viram NULL (aceito com forcar).
    const removidos = await tx
      .delete(documentosHabilitacao)
      .where(eq(documentosHabilitacao.importJobId, id))
      .returning({ id: documentosHabilitacao.id, blobKey: documentosHabilitacao.blobKey });

    // 2. Reverte adoções: os docs adotados são PRÉ-existentes (dedupe adota
    // documento de job anterior), logo sobrevivem ao passo 1. Cada UPDATE é
    // CONDICIONAL — só limpa se o valor atual ainda é o que a adoção gravou.
    const adocoes = await tx
      .select({ entidadeId: auditLog.entidadeId, detalhes: auditLog.detalhes })
      .from(auditLog)
      .where(and(
        eq(auditLog.acao, "IMPORT_ADOCAO"),
        sql`${auditLog.detalhes}->>'jobId' = ${id}`,
      ));

    let desfeitas = 0;
    for (const adocao of adocoes) {
      const documentoId = adocao.entidadeId;
      if (!documentoId || !ehUuid(documentoId)) continue;
      const campos = ((adocao.detalhes ?? {}) as { camposPreenchidos?: CamposAdocao })
        .camposPreenchidos ?? {};

      let reverteu = false;

      if (campos.operacaoId && ehUuid(campos.operacaoId)) {
        const r = await tx
          .update(documentosHabilitacao)
          .set({ operacaoId: null })
          .where(and(
            eq(documentosHabilitacao.id, documentoId),
            eq(documentosHabilitacao.operacaoId, campos.operacaoId),
          ))
          .returning({ id: documentosHabilitacao.id });
        if (r.length > 0) reverteu = true;
      }
      if (campos.papel && (PAPEIS_DOCUMENTO as readonly string[]).includes(campos.papel)) {
        const r = await tx
          .update(documentosHabilitacao)
          .set({ papel: null })
          .where(and(
            eq(documentosHabilitacao.id, documentoId),
            eq(documentosHabilitacao.papel, campos.papel as PapelDocumento),
          ))
          .returning({ id: documentosHabilitacao.id });
        if (r.length > 0) reverteu = true;
      }
      if (campos.tipoDocumento && (TIPOS_DOCUMENTO as readonly string[]).includes(campos.tipoDocumento)) {
        const r = await tx
          .update(documentosHabilitacao)
          .set({ tipoDocumento: null })
          .where(and(
            eq(documentosHabilitacao.id, documentoId),
            eq(documentosHabilitacao.tipoDocumento, campos.tipoDocumento as TipoDocumento),
          ))
          .returning({ id: documentosHabilitacao.id });
        if (r.length > 0) reverteu = true;
      }
      if (campos.situacaoProva && (SITUACOES_PROVA as readonly string[]).includes(campos.situacaoProva)) {
        const r = await tx
          .update(documentosHabilitacao)
          .set({ situacaoProva: null })
          .where(and(
            eq(documentosHabilitacao.id, documentoId),
            eq(documentosHabilitacao.situacaoProva, campos.situacaoProva as SituacaoProva),
          ))
          .returning({ id: documentosHabilitacao.id });
        if (r.length > 0) reverteu = true;
      }
      if (campos.detentora && (DETENTORAS as readonly string[]).includes(campos.detentora)) {
        const r = await tx
          .update(documentosHabilitacao)
          .set({ detentora: null })
          .where(and(
            eq(documentosHabilitacao.id, documentoId),
            eq(documentosHabilitacao.detentora, campos.detentora as Detentora),
          ))
          .returning({ id: documentosHabilitacao.id });
        if (r.length > 0) reverteu = true;
      }

      if (reverteu) desfeitas++;
    }

    // 3. Fecha o job. `:quando` = ISO UTC com ms (formato toISOString) — a
    // idempotência declarada aceita concatenar outra marca num job já desfeito.
    const quando = new Date().toISOString();
    await tx
      .update(importJobs)
      .set({
        status:       "CANCELADO",
        finalizadoEm: new Date(),
        observacao:   sql`COALESCE(${importJobs.observacao}, '') || ' | desfeito em ' || ${quando}`,
      })
      .where(eq(importJobs.id, id));

    // 4. Audit na MESMA transação. `blobsApagados` NÃO entra (só se conhece
    // após o commit) — sai apenas na resposta.
    await tx.insert(auditLog).values({
      userId:     session.user.id,
      acao:       "DESFAZER_IMPORT_JOB",
      entidade:   "import_job",
      entidadeId: id,
      detalhes:   { apagados: removidos.length, adocoesDesfeitas: desfeitas, forcar, usoAJusante },
    });

    return {
      apagados: removidos.length,
      blobKeys: removidos.map((r) => r.blobKey),
      adocoesDesfeitas: desfeitas,
    };
  });

  // ── Etapa 5 — MinIO fora da transação, best-effort em paralelo ────────────
  const resultados = await Promise.allSettled(blobKeys.map((k) => deleteDocumento(k)));
  const blobsApagados = resultados.filter((r) => r.status === "fulfilled").length;

  return NextResponse.json({
    ok: true,
    apagados,
    adocoesDesfeitas,
    blobsApagados,
    status: "CANCELADO",
  });
}
