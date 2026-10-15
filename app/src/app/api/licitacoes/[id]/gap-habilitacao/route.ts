export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET  /api/licitacoes/[id]/gap-habilitacao — lê o gap materializado (sem recalcular)
 * POST /api/licitacoes/[id]/gap-habilitacao — recalcula (Claude só nos requisitos ambíguos)
 *
 * Cruza requisitos_edital + analises_ia.criteriosHabilitacao contra o cofre
 * (documentos_habilitacao VIGENTE) e famílias CRC, persistindo em gap_habilitacao
 * via db.batch (neon-http NÃO suporta db.transaction).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireVisualizar, requirePropor, handleApiError } from "@/lib/api/guards";
import { calcularGapHabilitacao, getGapHabilitacao, GapNotFound } from "@/lib/licitacoes/gap-habilitacao";
import { loggerFor } from "@/lib/observability/logger";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireVisualizar();
  } catch (e) {
    return handleApiError(e);
  }

  const { id } = await params;
  if (!UUID_REGEX.test(id)) {
    return NextResponse.json({ error: "ID inválido" }, { status: 400 });
  }

  try {
    const data = await getGapHabilitacao(id);
    // data === null => nunca calculado ainda (UI mostra CTA "Calcular gap")
    return NextResponse.json({ data });
  } catch (e) {
    if (e instanceof GapNotFound) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Licitação não encontrada" } }, { status: 404 });
    }
    return handleApiError(e);
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requirePropor();
  } catch (e) {
    return handleApiError(e);
  }

  const { id } = await params;
  if (!UUID_REGEX.test(id)) {
    return NextResponse.json({ error: "ID inválido" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const usarIA = body.usarIA !== false; // default true

  const log = loggerFor(req, { rota: "gap-habilitacao", licitacaoId: id });
  try {
    const data = await calcularGapHabilitacao(id, { usarIA });
    return NextResponse.json({ data });
  } catch (e) {
    if (e instanceof GapNotFound) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Licitação não encontrada" } }, { status: 404 });
    }
    log.error("Falha ao calcular gap de habilitação", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
