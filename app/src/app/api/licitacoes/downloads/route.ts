export const runtime = "nodejs";

/**
 * GET /api/licitacoes/downloads
 * Lista licitações com seus anexos para a página de downloads.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireVisualizar, handleApiError } from "@/lib/api/guards";
import { db } from "@/db";
import { licitacoes, anexos } from "@/db/schema";
import { sql, count, desc, ilike, and, or, eq } from "drizzle-orm";

// RBAC hardening (FRENTE D): lista licitações internas + anexos. Leitura
// INTERNA → requireVisualizar (barra EXTERNO). Antes era requireAuth.
export async function GET(request: NextRequest) {
  try {
    await requireVisualizar();
  } catch (e) {
    return handleApiError(e);
  }

  const { searchParams } = new URL(request.url);
  const search = searchParams.get("search") ?? "";
  const relevancia = searchParams.get("relevancia") ?? "";
  const soComAnexos = searchParams.get("com_anexos") === "1";
  const page = parseInt(searchParams.get("page") ?? "1");
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "30"), 100);
  const offset = (page - 1) * limit;

  const conditions = [];

  if (search) {
    conditions.push(
      or(
        ilike(licitacoes.objeto, `%${search}%`),
        ilike(licitacoes.numero, `%${search}%`),
      )
    );
  }

  if (relevancia) {
    conditions.push(eq(licitacoes.relevancia, relevancia));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // Subquery: total de anexos por licitação
  const totalAnexosSub = db
    .select({ licitacaoId: anexos.licitacaoId, total: count().as("total") })
    .from(anexos)
    .groupBy(anexos.licitacaoId)
    .as("totais");

  // Buscar licitações com total de anexos via JOIN
  const rows = await db
    .select({
      id: licitacoes.id,
      numero: licitacoes.numero,
      objeto: licitacoes.objeto,
      empresa: licitacoes.empresa,
      fase: licitacoes.fase,
      dataFim: licitacoes.dataFim,
      relevancia: licitacoes.relevancia,
      scoreInteresse: licitacoes.scoreInteresse,
      totalAnexos: sql<number>`COALESCE(${totalAnexosSub.total}, 0)`,
    })
    .from(licitacoes)
    .leftJoin(totalAnexosSub, eq(licitacoes.id, totalAnexosSub.licitacaoId))
    .where(where)
    .orderBy(desc(licitacoes.scoreInteresse))
    .limit(limit)
    .offset(offset);

  const filtered = soComAnexos ? rows.filter((r) => Number(r.totalAnexos) > 0) : rows;

  const [totalResult] = await db.select({ count: count() }).from(licitacoes).where(where);

  return NextResponse.json({
    data: filtered,
    meta: {
      total: totalResult.count,
      page,
      limit,
      pages: Math.ceil(totalResult.count / limit),
    },
  });
}
