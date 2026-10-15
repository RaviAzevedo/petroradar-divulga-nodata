export const runtime = "nodejs";

/**
 * GET  /api/admin/users — Lista todos os usuários (incl. inativos e pendentes)
 *                         para o Admin Center
 * POST /api/admin/users — Pré-cadastra usuário SSO (sem senha) ou cria usuário
 *                         local com senha (break-glass)
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { desc } from "drizzle-orm";
import { ROLES, type UserRole } from "@/lib/permissions";
import { requireAdmin, handleApiError } from "@/lib/api/guards";
import { registrarAuditoria } from "@/lib/audit/queries";
import bcrypt from "bcryptjs";

// Deriva a lista de roles válidos do enum canônico ROLES (inclui SGI) para não
// divergir do sistema de permissões.
const ROLES_VALIDOS = Object.values(ROLES) as UserRole[];

export async function GET() {
  try {
    await requireAdmin();
  } catch (e) {
    return handleApiError(e);
  }

  const lista = await db
    .select({
      id:          users.id,
      nome:        users.nome,
      email:       users.email,
      role:        users.role,
      ativo:       users.ativo,
      pendente:    users.pendente,
      entraOid:    users.entraOid,
      ultimoLogin: users.ultimoLogin,
      criadoEm:    users.criadoEm,
    })
    .from(users)
    .orderBy(desc(users.criadoEm));

  // entraOid não interessa ao front além de "tem vínculo Microsoft?" — expor
  // só o boolean evita vazar o identificador do tenant no payload.
  const sanitizada = lista.map(({ entraOid, ...u }) => ({
    ...u,
    vinculoMicrosoft: entraOid != null,
  }));

  return NextResponse.json({ users: sanitizada });
}

export async function POST(req: NextRequest) {
  let session;
  try {
    ({ session } = await requireAdmin());
  } catch (e) {
    return handleApiError(e);
  }

  let body: { nome?: string; email?: string; senha?: string; role?: string; entraOid?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  const { nome, senha, role } = body;
  const email = body.email?.toLowerCase().trim();
  // oid vindo da busca no diretório Microsoft: grava direto → 1º login casa
  // pela identidade imutável, sem depender do backfill por e-mail.
  const entraOid = body.entraOid?.trim() || null;

  // Pré-cadastro SSO: senha é OPCIONAL — o usuário entra com a conta Microsoft
  // e o match é feito pelo e-mail no 1º login (backfill do entra_oid). Senha só
  // é usada para contas locais de break-glass.
  if (!email || !role) {
    return NextResponse.json({ error: "Campos obrigatórios: email, role" }, { status: 422 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Email inválido" }, { status: 422 });
  }
  if (senha && senha.length < 8) {
    return NextResponse.json({ error: "Senha deve ter ao menos 8 caracteres" }, { status: 422 });
  }

  if (!ROLES_VALIDOS.includes(role as UserRole)) {
    return NextResponse.json({ error: "Role inválido" }, { status: 422 });
  }

  const passwordHash = senha ? await bcrypt.hash(senha, 12) : null;

  try {
    const [novo] = await db
      .insert(users)
      .values({ email, nome: nome || null, passwordHash, role: role as UserRole, ativo: true, pendente: false, entraOid })
      .returning({ id: users.id, email: users.email, nome: users.nome, role: users.role });

    await registrarAuditoria({
      userId:     session.user.id,
      acao:       "USER_CRIADO",
      entidade:   "users",
      entidadeId: novo.id,
      detalhes:   { email, role, comSenha: !!senha, viaDiretorio: !!entraOid },
    });

    return NextResponse.json(novo, { status: 201 });
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("unique")) {
      return NextResponse.json({ error: "Email já cadastrado" }, { status: 409 });
    }
    return handleApiError(e, req);
  }
}
