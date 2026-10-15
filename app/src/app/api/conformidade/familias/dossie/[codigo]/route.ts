export const runtime = "nodejs";

/**
 * GET /api/conformidade/familias/dossie/[codigo] — o dossiê de UMA família.
 *
 * A rota irmã (`../[id]/route.ts`) é chaveada pelo uuid do NOSSO cadastro e por
 * isso só existe para as famílias cadastradas. Esta é chaveada pelo CÓDIGO
 * CRC e existe para todas as do catálogo — inclusive as não cadastradas,
 * que são justamente as que exigem decisão de cadastro.
 *
 * Somente leitura. A revisão de um indício é escrita e tem rota própria
 * (`../classificacoes/[id]`), com guard de gestão e audit_log.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireVisualizar, handleApiError } from "@/lib/api/guards";
import { dossieFamilia } from "@/lib/conformidade/familias/dossie";

type Params = { params: Promise<{ codigo: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  let user: Awaited<ReturnType<typeof requireVisualizar>>["user"];
  try {
    ({ user } = await requireVisualizar());
  } catch (e) {
    return handleApiError(e);
  }

  try {
    const { codigo } = await params;
    // Teto de tamanho antes de tocar o banco: o código vai para f_codigo_crc(),
    // que é IMMUTABLE e barata, mas não há razão para aceitar um path de 4 KB.
    if (!codigo || codigo.length > 40) {
      return NextResponse.json({ error: "Família não encontrada" }, { status: 404 });
    }

    const dossie = await dossieFamilia(codigo, user.role);
    if (!dossie) {
      return NextResponse.json({ error: "Família não encontrada" }, { status: 404 });
    }

    return NextResponse.json({
      ...dossie,
      ressalva: {
        // A tela PRECISA dizer isto: nada foi revisado por gente ainda.
        texto:
          "INDÍCIO é apontamento da máquina sobre o texto do acervo, ainda sem " +
          "revisão humana — não sustenta um NO-GO nem substitui o atestado. " +
          "Confirmar um indício é o que o transforma em prova.",
        demandaObservada:
          "Demanda medida nas licitações coletadas pelo Petro Radar, não no " +
          "histórico completo da Petrobras. Zero aqui não significa zero no mercado.",
      },
    });
  } catch (e) {
    return handleApiError(e);
  }
}
