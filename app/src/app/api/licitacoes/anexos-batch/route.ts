/**
 * POST /api/licitacoes/anexos-batch
 *
 * Recebe { ids: string[] } (ids de licitações) e devolve, em UMA query,
 * apenas os anexos de cada licitação — sem trazer dadosCompletos/textoCache
 * nem o restante do payload pesado de /api/licitacoes/[id].
 *
 * Resolve o N+1 da página de Downloads, que antes buscava /api/licitacoes/[id]
 * uma vez por item só pra listar anexos.
 *
 * Auth: requireVisualizar (todos exceto EXTERNO).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { anexos } from "@/db/schema";
import { inArray } from "drizzle-orm";
import { requireVisualizar, handleApiError } from "@/lib/api/guards";

const LIMITE = 200;

export async function POST(request: NextRequest) {
  try {
    await requireVisualizar();
  } catch (e) {
    return handleApiError(e);
  }

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  const ids = (body as { ids?: unknown }).ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((i) => typeof i !== "string")) {
    return NextResponse.json({ error: "Esperado { ids: string[] } com pelo menos 1 id" }, { status: 422 });
  }
  if (ids.length > LIMITE) {
    return NextResponse.json({ error: `Máximo de ${LIMITE} licitações por chamada` }, { status: 422 });
  }

  // UMA query pra todos os anexos das licitações pedidas.
  const linhas = await db
    .select({
      licitacaoId: anexos.licitacaoId,
      id:          anexos.id,
      phioObjid:   anexos.phioObjid,
      descricao:   anexos.descricao,
    })
    .from(anexos)
    .where(inArray(anexos.licitacaoId, ids as string[]))
    .orderBy(anexos.descricao);

  // Agrupa por licitação, preservando todos os ids pedidos (mesmo sem anexos).
  const porLic = new Map<string, Array<{ id: string; phioObjid: string | null; descricao: string | null }>>();
  for (const id of ids as string[]) porLic.set(id, []);
  for (const l of linhas) {
    porLic.get(l.licitacaoId)?.push({ id: l.id, phioObjid: l.phioObjid, descricao: l.descricao });
  }

  const data = Array.from(porLic.entries()).map(([licitacaoId, lista]) => ({ licitacaoId, anexos: lista }));

  return NextResponse.json({ data });
}
