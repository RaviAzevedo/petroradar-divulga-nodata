import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { circulares } from "@/db/schema";
import { eq, desc, sql } from "drizzle-orm";
import { requireVisualizar, handleApiError } from "@/lib/api/guards";

// RBAC hardening (FRENTE D): circulares são comunicações internas da licitação.
// Leitura INTERNA → requireVisualizar (barra EXTERNO). Antes era requireAuth.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireVisualizar();
  } catch (e) {
    return handleApiError(e);
  }

  const { id } = await params;

  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_REGEX.test(id)) {
    return NextResponse.json({ error: "ID inválido" }, { status: 400 });
  }

  const result = await db
    .select({
      id: circulares.id,
      tipo: circulares.tipo,
      autor: circulares.autor,
      mensagem: circulares.mensagem,
      dataPublicacao: circulares.dataPublicacao,
      anexoPhioObjid: circulares.anexoPhioObjid,
      anexoDescricao: circulares.anexoDescricao,
      criadoEm: circulares.criadoEm,
    })
    .from(circulares)
    .where(eq(circulares.licitacaoId, id))
    .orderBy(desc(circulares.dataPublicacao));

  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(circulares)
    .where(eq(circulares.licitacaoId, id));

  return NextResponse.json({
    data: result,
    total: countResult?.count ?? 0,
  });
}
