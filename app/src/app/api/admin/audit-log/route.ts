export const runtime = "nodejs";

/**
 * GET /api/admin/audit-log
 *
 * Dois modos:
 *   - Por entidade:  ?entidade=X&entidadeId=Y  → histórico (qualquer visualizador)
 *   - Lista geral:   sem entidade/entidadeId   → paginado (apenas ADMIN)
 *
 * Lista geral aceita filtros opcionais: ?entidade, ?userId, ?acao, ?limit, ?offset
 */

import { NextRequest, NextResponse } from "next/server";
import { listarAuditoria, listarTodaAuditoria } from "@/lib/audit/queries";
import { requireVisualizar, requireAdmin, handleApiError } from "@/lib/api/guards";

export async function GET(request: NextRequest) {
  const url        = new URL(request.url);
  const entidade   = url.searchParams.get("entidade");
  const entidadeId = url.searchParams.get("entidadeId");

  // Modo histórico por entidade — qualquer visualizador
  if (entidade && entidadeId) {
    try {
      await requireVisualizar();
    } catch (e) {
      return handleApiError(e);
    }
    const data = await listarAuditoria({ entidade, entidadeId });
    return NextResponse.json({ data });
  }

  // Modo lista geral — apenas ADMIN
  try {
    await requireAdmin();
  } catch (e) {
    return handleApiError(e);
  }

  const userId = url.searchParams.get("userId") || undefined;
  const acao   = url.searchParams.get("acao")   || undefined;
  const limit  = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit")  ?? "50")));
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0"));

  const result = await listarTodaAuditoria({
    entidade: entidade ?? undefined,
    userId,
    acao,
    limit,
    offset,
  });

  return NextResponse.json(result);
}
