export const runtime = "nodejs";

/**
 * GET  /api/conformidade/familias/match/[licitacaoId] — Calcula aderência (sem persistir cache)
 * POST /api/conformidade/familias/match/[licitacaoId] — Recalcula e atualiza cache
 */

import { NextRequest, NextResponse } from "next/server";
import { podeGerenciarFamilias } from "@/lib/permissions";
import { requireAuth, requireVisualizar, handleApiError } from "@/lib/api/guards";
import {
  calcularAderencia,
  calcularEPersistirAderencia,
} from "@/lib/conformidade/familias/match";

type Params = { params: Promise<{ licitacaoId: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    await requireVisualizar();
  } catch (e) {
    return handleApiError(e);
  }

  const { licitacaoId } = await params;
  const resultado = await calcularAderencia(licitacaoId);
  return NextResponse.json(resultado);
}

export async function POST(_req: NextRequest, { params }: Params) {
  let session;
  try {
    ({ session } = await requireAuth());
  } catch (e) {
    return handleApiError(e);
  }
  if (!podeGerenciarFamilias(session.user.role)) {
    return NextResponse.json({ error: "Permissão negada" }, { status: 403 });
  }

  const { licitacaoId } = await params;
  const resultado = await calcularEPersistirAderencia(licitacaoId);
  return NextResponse.json(resultado);
}
