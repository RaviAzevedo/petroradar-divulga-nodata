export const runtime = "nodejs";

/**
 * PATCH  /api/admin/emails/filtros/[id] — Atualiza nome/descrição/critérios/ativo
 * DELETE /api/admin/emails/filtros/[id] — Exclui (assinaturas caem em CASCADE)
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { filtrosEmail } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireAdmin, handleApiError } from "@/lib/api/guards";
import { registrarAuditoria } from "@/lib/audit/queries";
import { normalizarCriterios } from "@/lib/digest/licitacoes";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  let session;
  try {
    ({ session } = await requireAdmin());
  } catch (e) {
    return handleApiError(e, req);
  }

  const { id } = await params;

  let body: { nome?: string; descricao?: string; criterios?: unknown; ativo?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  const updates: Record<string, unknown> = { atualizadoEm: new Date() };
  if (body.nome !== undefined) {
    const nome = body.nome.trim();
    if (!nome) return NextResponse.json({ error: "Nome não pode ser vazio" }, { status: 422 });
    updates.nome = nome;
  }
  if (body.descricao !== undefined) updates.descricao = body.descricao?.trim() || null;
  if (body.criterios !== undefined) updates.criterios = normalizarCriterios(body.criterios);
  if (body.ativo !== undefined)     updates.ativo = body.ativo;

  try {
    const [updated] = await db
      .update(filtrosEmail)
      .set(updates)
      .where(eq(filtrosEmail.id, id))
      .returning({ id: filtrosEmail.id, nome: filtrosEmail.nome, ativo: filtrosEmail.ativo });

    if (!updated) return NextResponse.json({ error: "Filtro não encontrado" }, { status: 404 });

    await registrarAuditoria({
      userId:     session.user.id,
      acao:       "FILTRO_EMAIL_ATUALIZADO",
      entidade:   "filtros_email",
      entidadeId: id,
      detalhes:   { campos: Object.keys(updates).filter((k) => k !== "atualizadoEm") },
    });

    return NextResponse.json(updated);
  } catch (e: unknown) {
    // drizzle 0.45 embrulha em DrizzleQueryError — o código pg vive no cause.
    const code = (e as { code?: string; cause?: { code?: string } })?.code
      ?? (e as { cause?: { code?: string } })?.cause?.code;
    if (code === "23505") {
      return NextResponse.json({ error: "Já existe um filtro com esse nome" }, { status: 409 });
    }
    return handleApiError(e, req);
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  let session;
  try {
    ({ session } = await requireAdmin());
  } catch (e) {
    return handleApiError(e, req);
  }

  const { id } = await params;

  const [alvo] = await db
    .select({ id: filtrosEmail.id, nome: filtrosEmail.nome })
    .from(filtrosEmail)
    .where(eq(filtrosEmail.id, id))
    .limit(1);

  if (!alvo) return NextResponse.json({ error: "Filtro não encontrado" }, { status: 404 });

  // Assinaturas e ledger caem em CASCADE (0026) — a UI avisa antes.
  await db.delete(filtrosEmail).where(eq(filtrosEmail.id, id));

  await registrarAuditoria({
    userId:     session.user.id,
    acao:       "FILTRO_EMAIL_EXCLUIDO",
    entidade:   "filtros_email",
    entidadeId: id,
    detalhes:   { nome: alvo.nome },
  });

  return NextResponse.json({ id, excluido: true });
}
