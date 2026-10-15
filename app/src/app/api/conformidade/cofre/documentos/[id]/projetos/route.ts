export const runtime = "nodejs";

/**
 * GET    /api/conformidade/cofre/documentos/[id]/projetos             — lista projetos
 * POST   /api/conformidade/cofre/documentos/[id]/projetos             — adiciona projeto
 * DELETE /api/conformidade/cofre/documentos/[id]/projetos?projetoId=  — remove
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { documentosProjetos, auditLog } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { podeGerenciarDocumentosHabilitacao } from "@/lib/permissions";
import { requireAuth, requireVisualizar, handleApiError } from "@/lib/api/guards";
import { VincularDocumentoProjetoSchema, formatZodErrors } from "@/lib/conformidade/cofre/validations";
import { getProjetosByDocumento, paiRestritoInvisivel } from "@/lib/conformidade/cofre/queries";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  let user: Awaited<ReturnType<typeof requireVisualizar>>["user"];
  try {
    ({ user } = await requireVisualizar());
  } catch (e) {
    return handleApiError(e);
  }
  const { id } = await params;
  // Barreira do pai restrito (0034/S13): 404 com a MESMA string do 404 de
  // documento inexistente (espelho de conf_cofre_doc_id_projetos.py).
  if (await paiRestritoInvisivel(id, user.role)) {
    return NextResponse.json({ error: "Documento não encontrado" }, { status: 404 });
  }
  const lista = await getProjetosByDocumento(id);
  return NextResponse.json({ data: lista });
}

export async function POST(request: NextRequest, { params }: Params) {
  let session;
  try {
    ({ session } = await requireAuth());
  } catch (e) {
    return handleApiError(e);
  }
  if (!podeGerenciarDocumentosHabilitacao(session.user.role)) {
    return NextResponse.json({ error: "Permissão negada" }, { status: 403 });
  }

  const { id } = await params;
  // Barreira do pai restrito (0034/S13) — antes de qualquer efeito.
  if (await paiRestritoInvisivel(id, session.user.role)) {
    return NextResponse.json({ error: "Documento não encontrado" }, { status: 404 });
  }
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  const parsed = VincularDocumentoProjetoSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Dados inválidos", detalhes: formatZodErrors(parsed.error) }, { status: 422 });
  }

  const d = parsed.data;
  const [novo] = await db.insert(documentosProjetos).values({
    documentoId:           id,
    clienteCnpj:           d.clienteCnpj ?? null,
    clienteNome:           d.clienteNome,
    projetoNome:           d.projetoNome,
    valorContrato:         d.valorContrato != null ? String(d.valorContrato) : null,
    periodoInicio:         d.periodoInicio ? new Date(d.periodoInicio) : null,
    periodoFim:            d.periodoFim    ? new Date(d.periodoFim)    : null,
    descricaoServico:      d.descricaoServico ?? null,
    engenheiroResponsavel: d.engenheiroResponsavel ?? null,
    registroCrea:          d.registroCrea ?? null,
    numeroArt:             d.numeroArt ?? null,
  }).returning();

  await db.insert(auditLog).values({
    userId: session.user.id,
    acao: "ADICIONAR_PROJETO_DOC",
    entidade: "documento_habilitacao",
    entidadeId: id,
    detalhes: { projetoId: novo.id, projetoNome: novo.projetoNome },
  });
  return NextResponse.json(novo, { status: 201 });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  let session;
  try {
    ({ session } = await requireAuth());
  } catch (e) {
    return handleApiError(e);
  }
  if (!podeGerenciarDocumentosHabilitacao(session.user.role)) {
    return NextResponse.json({ error: "Permissão negada" }, { status: 403 });
  }

  const { id } = await params;
  // Barreira do pai restrito (0034/S13) — antes de qualquer efeito.
  if (await paiRestritoInvisivel(id, session.user.role)) {
    return NextResponse.json({ error: "Documento não encontrado" }, { status: 404 });
  }
  const projetoId = new URL(request.url).searchParams.get("projetoId");
  if (!projetoId) {
    return NextResponse.json({ error: "Query param projetoId é obrigatório" }, { status: 400 });
  }

  await db.delete(documentosProjetos).where(and(
    eq(documentosProjetos.documentoId, id),
    eq(documentosProjetos.id, projetoId),
  ));
  await db.insert(auditLog).values({
    userId: session.user.id,
    acao: "REMOVER_PROJETO_DOC",
    entidade: "documento_habilitacao",
    entidadeId: id,
    detalhes: { projetoId },
  });
  return NextResponse.json({ ok: true });
}
