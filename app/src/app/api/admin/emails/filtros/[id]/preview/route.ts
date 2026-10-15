export const runtime = "nodejs";

/**
 * GET /api/admin/emails/filtros/[id]/preview — Preview honesto do filtro:
 * quantas licitações dos últimos 7 dias casariam + 5 exemplos. Roda a MESMA
 * seleção do digest (lib/digest/licitacoes), sem ledger — calibra keywords no
 * painel sem esperar a próxima rodada do cron.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { filtrosEmail } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireAdmin, handleApiError } from "@/lib/api/guards";
import { buscarLicitacoesParaFiltro, normalizarCriterios } from "@/lib/digest/licitacoes";

type Params = { params: Promise<{ id: string }> };

const JANELA_DIAS = 7;

export async function GET(req: NextRequest, { params }: Params) {
  try {
    await requireAdmin();
  } catch (e) {
    return handleApiError(e, req);
  }

  const { id } = await params;

  const [filtro] = await db
    .select({ id: filtrosEmail.id, nome: filtrosEmail.nome, criterios: filtrosEmail.criterios })
    .from(filtrosEmail)
    .where(eq(filtrosEmail.id, id))
    .limit(1);

  if (!filtro) return NextResponse.json({ error: "Filtro não encontrado" }, { status: 404 });

  const desde = new Date(Date.now() - JANELA_DIAS * 24 * 3_600_000);
  const rows = await buscarLicitacoesParaFiltro(normalizarCriterios(filtro.criterios), {
    desde,
    limite: 500,
  });

  return NextResponse.json({
    filtro:     filtro.nome,
    janelaDias: JANELA_DIAS,
    total:      rows.length,
    exemplos:   rows.slice(0, 5).map((r) => ({
      numero:         r.numero,
      objetoResumido: r.objetoResumido ?? (r.objeto ?? "").slice(0, 120),
      relevancia:     r.relevancia,
      scoreInteresse: r.scoreInteresse,
    })),
  });
}
