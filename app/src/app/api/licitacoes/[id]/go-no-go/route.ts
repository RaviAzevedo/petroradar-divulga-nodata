export const runtime = "nodejs";

/**
 * GET /api/licitacoes/[id]/go-no-go
 *
 * Semáforo VERDE/AMARELO/VERMELHO de habilitabilidade da licitação, cruzando
 * aderência de famílias CRC, cobertura dos requisitos do edital pelo cofre e
 * status das famílias CRC envolvidas. Read-only (não persiste).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireVisualizar, handleApiError } from "@/lib/api/guards";
import { calcularGoNoGo, GoNoGoNotFound } from "@/lib/licitacoes/go-no-go";
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

  const log = loggerFor(req, { rota: "go-no-go", licitacaoId: id });
  try {
    const data = await calcularGoNoGo(id);
    return NextResponse.json({ data });
  } catch (e) {
    if (e instanceof GoNoGoNotFound) {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "Licitação não encontrada" } },
        { status: 404 },
      );
    }
    log.error("Falha ao calcular go-no-go", e);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
