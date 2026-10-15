export const runtime = "nodejs";

/**
 * PATCH /api/admin/users/[id] — Atualiza nome, role e/ou ativo; `aprovar: true`
 *                               libera uma solicitação pendente (fila SSO)
 * DELETE /api/admin/users/[id] — Pendente: remove a linha (recusa a solicitação;
 *                                a pessoa pode pedir de novo). Demais: desativa
 *                                (soft-delete) — não remove do banco.
 *                                Com ?forcar=1: EXCLUI de verdade (hard delete)
 *                                — p/ contas erradas/que nunca entraram; se o
 *                                usuário tem histórico (FK em participações
 *                                etc.), responde 409 sugerindo bloquear.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { ROLES, type UserRole } from "@/lib/permissions";
import { requireAdmin, handleApiError } from "@/lib/api/guards";
import { revokeAllForUser } from "@/lib/security/revocation";
import { registrarAuditoria } from "@/lib/audit/queries";
import bcrypt from "bcryptjs";

type Params = { params: Promise<{ id: string }> };

// Deriva a lista de roles válidos do enum canônico ROLES (inclui SGI) para não
// divergir do sistema de permissões.
const ROLES_VALIDOS = Object.values(ROLES) as UserRole[];

export async function PATCH(req: NextRequest, { params }: Params) {
  let session;
  try {
    ({ session } = await requireAdmin());
  } catch (e) {
    return handleApiError(e, req);
  }

  const { id } = await params;

  let body: { nome?: string; role?: string; ativo?: boolean; senha?: string; aprovar?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  // Impede que o próprio admin se desative ou rebaixe
  if (id === session.user.id) {
    if (body.ativo === false) return NextResponse.json({ error: "Não é possível desativar sua própria conta" }, { status: 400 });
    if (body.role && body.role !== "ADMIN") return NextResponse.json({ error: "Não é possível alterar seu próprio role" }, { status: 400 });
  }

  if (body.role && !ROLES_VALIDOS.includes(body.role as UserRole)) {
    return NextResponse.json({ error: "Role inválido" }, { status: 422 });
  }

  const updates: Record<string, unknown> = {};
  if (body.nome  !== undefined) updates.nome  = body.nome;
  if (body.role  !== undefined) updates.role  = body.role;
  // Aprovação da fila SSO: libera o acesso (o role vem junto no body.role).
  if (body.aprovar === true) {
    updates.ativo    = true;
    updates.pendente = false;
    updates.desativadoEm = null;
  } else if (body.ativo !== undefined) {
    updates.ativo = body.ativo;
    // Rastro do soft-delete (0017): desativar carimba desativado_em; reativar limpa.
    updates.desativadoEm = body.ativo === false ? new Date() : null;
  }
  if (body.senha) {
    if (body.senha.length < 8) return NextResponse.json({ error: "Senha deve ter ao menos 8 caracteres" }, { status: 422 });
    updates.passwordHash = await bcrypt.hash(body.senha, 12);
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nenhum campo para atualizar" }, { status: 400 });
  }

  const [updated] = await db
    .update(users)
    .set(updates)
    .where(eq(users.id, id))
    .returning({ id: users.id, email: users.email, nome: users.nome, role: users.role, ativo: users.ativo, pendente: users.pendente });

  if (!updated) return NextResponse.json({ error: "Usuário não encontrado" }, { status: 404 });

  // Decisão 4: desativar, trocar role ou trocar senha derruba as sessões
  // existentes na hora (corte por usuário no Redis db2; o BFF rejeita iat antigo).
  if (updates.ativo === false || (updates.role !== undefined && body.aprovar !== true) || updates.passwordHash !== undefined) {
    await revokeAllForUser(id);
  }

  if (body.aprovar === true) {
    await registrarAuditoria({
      userId:     session.user.id,
      acao:       "USER_APROVADO",
      entidade:   "users",
      entidadeId: id,
      detalhes:   { email: updated.email, role: updated.role },
    });
  }

  return NextResponse.json(updated);
}

export async function DELETE(req: NextRequest, { params }: Params) {
  let session;
  try {
    ({ session } = await requireAdmin());
  } catch (e) {
    return handleApiError(e, req);
  }

  const { id } = await params;

  // Anti-self-lockout: o admin não pode desativar a própria conta.
  if (id === session.user.id) {
    return NextResponse.json({ error: "Não é possível desativar sua própria conta" }, { status: 400 });
  }

  const [alvo] = await db
    .select({ id: users.id, email: users.email, pendente: users.pendente })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);

  if (!alvo) return NextResponse.json({ error: "Usuário não encontrado" }, { status: 404 });

  // Solicitação pendente (fila SSO) recusada: hard-delete — a linha só existia
  // como pedido de acesso; remover permite a pessoa solicitar de novo depois.
  if (alvo.pendente) {
    await db.delete(users).where(eq(users.id, id));
    await registrarAuditoria({
      userId:     session.user.id,
      acao:       "USER_RECUSADO",
      entidade:   "users",
      entidadeId: id,
      detalhes:   { email: alvo.email },
    });
    return NextResponse.json({ id, recusado: true });
  }

  // Exclusão definitiva (?forcar=1): remove a linha. Se o usuário aparece em
  // FKs NOT NULL (propôs participações etc.) o Postgres barra (23503) — nesse
  // caso 409 orientando a BLOQUEAR (o histórico do sistema não pode ficar
  // órfão). audit_log tem ON DELETE SET NULL, então a trilha sobrevive.
  if (new URL(req.url).searchParams.get("forcar") === "1") {
    try {
      await revokeAllForUser(id);
      await db.delete(users).where(eq(users.id, id));
    } catch (e: unknown) {
      const pgCode = (e as { code?: string; cause?: { code?: string } });
      if (pgCode?.code === "23503" || pgCode?.cause?.code === "23503") {
        return NextResponse.json(
          { error: "Este usuário tem histórico no sistema (participações, aprovações…) e não pode ser excluído. Bloqueie o acesso em vez de excluir." },
          { status: 409 },
        );
      }
      return handleApiError(e, req);
    }
    await registrarAuditoria({
      userId:     session.user.id,
      acao:       "USER_EXCLUIDO",
      entidade:   "users",
      entidadeId: id,
      detalhes:   { email: alvo.email },
    });
    return NextResponse.json({ id, excluido: true });
  }

  // Soft-delete: marca ativo=false em vez de remover do banco e carimba
  // desativado_em (rastro de quando a conta foi desativada — 0017).
  const [updated] = await db
    .update(users)
    .set({ ativo: false, desativadoEm: new Date() })
    .where(eq(users.id, id))
    .returning({ id: users.id, email: users.email, nome: users.nome, role: users.role, ativo: users.ativo });

  if (!updated) return NextResponse.json({ error: "Usuário não encontrado" }, { status: 404 });

  // Decisão 4: soft-delete derruba as sessões existentes na hora.
  await revokeAllForUser(id);

  return NextResponse.json(updated);
}
