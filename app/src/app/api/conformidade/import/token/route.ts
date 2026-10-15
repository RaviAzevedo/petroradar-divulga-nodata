export const runtime = "nodejs";

/**
 * POST /api/conformidade/import/token
 *
 * Gera um token efêmero (default 24h) pra ser usado pelo CLI petro-radar-sync
 * que roda na máquina do SGI conectada à rede de arquivos.
 *
 * Auth: sessão NextAuth com role ADMIN/LIDER/SGI.
 * Body: { ttlHoras?: number (1..168) }
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { podeImportarConformidade } from "@/lib/permissions";
import { gerarImportToken } from "@/lib/conformidade/import-tokens";
import { z } from "zod";

const BodySchema = z.object({
  ttlHoras: z.number().int().min(1).max(7 * 24).default(24),
});

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  }
  if (!podeImportarConformidade(session.user.role)) {
    return NextResponse.json({ error: "Permissão negada" }, { status: 403 });
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch { /* permite body vazio */ }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Parâmetros inválidos" }, { status: 400 });
  }

  const { token, expiraEm } = await gerarImportToken(
    session.user.id,
    session.user.role,
    parsed.data.ttlHoras,
  );

  return NextResponse.json({
    token,
    expiraEm:    expiraEm.toISOString(),
    ttlHoras:    parsed.data.ttlHoras,
    instrucoes: "Use este token via header `Authorization: Bearer <token>` nos endpoints /api/conformidade/import/familias e /api/conformidade/import/scan. O CLI já faz isso automaticamente.",
  });
}
