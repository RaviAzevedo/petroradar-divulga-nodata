export const runtime = "nodejs";

/**
 * GET /api/conformidade/import/jobs — Lista as rodadas de ingestão (R14, 0034).
 *
 * Query: limit (1..100, default 20), offset (>=0), status? (StatusImport).
 * `documentosRestantes` = quantos documentos ainda apontam para o job — é o
 * que o desfazer (R15) removeria. `payload` NÃO sai (pode ser grande);
 * `iniciadoPor` não sai nesta rodada (a listagem serve à operação de ingestão,
 * não à auditoria — quem precisa de autor usa o audit_log).
 *
 * Guard: requireConformidade — 403 {"error":"Apenas Conformidade"} COM `code`.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { importJobs, documentosHabilitacao } from "@/db/schema";
import { desc, eq, sql, count } from "drizzle-orm";
import { requireConformidade, handleApiError } from "@/lib/api/guards";
import {
  ListarImportJobsSchema,
  formatZodErrors,
} from "@/lib/conformidade/operacoes/validations";

export async function GET(request: NextRequest) {
  try {
    await requireConformidade();
  } catch (e) {
    return handleApiError(e);
  }

  const { searchParams } = new URL(request.url);
  const parsed = ListarImportJobsSchema.safeParse({
    limit:  searchParams.get("limit")  ?? "20",
    offset: searchParams.get("offset") ?? "0",
    status: searchParams.get("status") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Parâmetros inválidos", detalhes: formatZodErrors(parsed.error) },
      { status: 400 }
    );
  }

  const filtros = parsed.data;
  const where = filtros.status ? eq(importJobs.status, filtros.status) : undefined;

  const [jobs, [totalRow]] = await Promise.all([
    db
      .select({
        id:            importJobs.id,
        fonte:         importJobs.fonte,
        status:        importJobs.status,
        totalArquivos: importJobs.totalArquivos,
        processados:   importJobs.processados,
        novos:         importJobs.novos,
        atualizados:   importJobs.atualizados,
        ignorados:     importJobs.ignorados,
        erros:         importJobs.erros,
        observacao:    importJobs.observacao,
        iniciadoEm:    importJobs.iniciadoEm,
        finalizadoEm:  importJobs.finalizadoEm,
        // O que o desfazer (R15) removeria. `::int` porque count é bigint e o
        // driver pg devolveria string.
        documentosRestantes: sql<number>`(
          SELECT count(*) FROM ${documentosHabilitacao} d
          WHERE d.import_job_id = ${importJobs.id}
        )::int`.as("documentos_restantes"),
      })
      .from(importJobs)
      .where(where)
      // `iniciado_em DESC NULLS LAST, id DESC` — desempate estável, contrato de
      // paridade com o BFF.
      .orderBy(
        sql`${importJobs.iniciadoEm} DESC NULLS LAST`,
        desc(importJobs.id),
      )
      .limit(filtros.limit)
      .offset(filtros.offset),

    db.select({ total: count() }).from(importJobs).where(where),
  ]);

  return NextResponse.json({ jobs, total: totalRow?.total ?? 0 });
}
