import { NextRequest, NextResponse } from "next/server";
import { requirePropor, handleApiError } from "@/lib/api/guards";
import { db } from "@/db";
import { licitacoes } from "@/db/schema";
import { eq } from "drizzle-orm";
import { rateLimit } from "@/lib/rate-limit";
import { processarAnexosDaLicitacao } from "@/lib/licitacoes/extrair-anexos";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/licitacoes/[id]/baixar-anexos
 *
 * PRODUTOR de texto dos anexos: baixa os anexos da licitação do Petronect e
 * extrai o texto (unpdf local + Claude vision fallback), gravando em
 * `anexos.texto_cache`. Depois disto, "Analisar com IA" passa a usar o texto
 * REAL de todos os anexos (hoje a coluna vive vazia e a análise cai no objeto).
 *
 * RBAC `requirePropor` (dispara egress Petronect + custo Anthropic no fallback).
 * Body opcional: `{ "force": true }` reprocessa anexos que já têm texto.
 * Rota WEB-ONLY (libs TS + egress; o BFF parita o ramo de erro).
 *
 * RATE LIMIT POR LICITAÇÃO, no mesmo padrão da rota /dossie: o recurso caro é a
 * LICITAÇÃO (1 chamada Haiku por PDF escaneado, em loop, sem teto de anexos), não
 * o usuário. Chavear por usuário deixaria dois analistas pagarem o mesmo OCR em
 * paralelo — e qualquer papel PROPOR podia marretar a rota e queimar token.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requirePropor();
  } catch (e) {
    return handleApiError(e, request);
  }

  const { id } = await params;

  const rl = await rateLimit({ key: `baixar-anexos:lic:${id}`, max: 1, windowMs: 3 * 60 * 1000 });
  if (!rl.allowed) {
    return NextResponse.json(
      {
        error: {
          code: "RATE_LIMITED",
          message: "Os anexos desta licitação já estão sendo baixados. Aguarde alguns minutos.",
        },
      },
      { status: 429 },
    );
  }

  const [lic] = await db.select().from(licitacoes).where(eq(licitacoes.id, id)).limit(1);
  if (!lic) {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: "Licitação não encontrada" } }, { status: 404 });
  }

  let force = false;
  try {
    const body = await request.json().catch(() => ({}));
    force = body?.force === true;
  } catch {
    // sem corpo — force=false
  }

  const resumo = await processarAnexosDaLicitacao(id, { force, request });

  return NextResponse.json({
    ok: resumo.falhas.length === 0,
    licitacaoId: id,
    ...resumo,
  });
}
