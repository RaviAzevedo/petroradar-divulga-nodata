import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { licitacoes, itens, anexos, historicoAlteracoes, analisesIa, circulares } from "@/db/schema";
import { eq, desc, sql } from "drizzle-orm";
import { requireVisualizar, handleApiError } from "@/lib/api/guards";

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

  const [lic] = await db
    .select()
    .from(licitacoes)
    .where(eq(licitacoes.id, id))
    .limit(1);

  if (!lic) {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: "Licitação não encontrada" } }, { status: 404 });
  }

  const licItens = await db
    .select()
    .from(itens)
    .where(eq(itens.licitacaoId, id))
    .orderBy(itens.itemNumero);

  // Colunas explícitas: NÃO trazer textoCache (pode ter MBs) na resposta.
  const licAnexos = await db
    .select({
      id:           anexos.id,
      descricao:    anexos.descricao,
      phioObjid:    anexos.phioObjid,
      s3Key:        anexos.s3Key,
      tamanhoBytes: anexos.tamanhoBytes,
      contentType:  anexos.contentType,
      baixadoEm:    anexos.baixadoEm,
    })
    .from(anexos)
    .where(eq(anexos.licitacaoId, id))
    .orderBy(anexos.descricao);

  const licHistorico = await db
    .select()
    .from(historicoAlteracoes)
    .where(eq(historicoAlteracoes.licitacaoId, id))
    .orderBy(desc(historicoAlteracoes.detectadoEm));

  const [analise] = await db
    .select()
    .from(analisesIa)
    .where(eq(analisesIa.licitacaoId, id))
    .limit(1);

  const [circCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(circulares)
    .where(eq(circulares.licitacaoId, id));

  return NextResponse.json({
    data: {
      ...lic,
      itens: licItens,
      anexos: licAnexos,
      historico: licHistorico,
      analise: analise ?? null,
      totalCirculares: circCount?.count ?? 0,
    },
  });
}
