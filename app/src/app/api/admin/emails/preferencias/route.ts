export const runtime = "nodejs";

/**
 * GET   /api/admin/emails/preferencias — matriz usuários × tipos de e-mail
 * PATCH /api/admin/emails/preferencias — liga/desliga UM (usuário, tipo)
 *
 * A preferência é SUBTRATIVA (0028): o papel continua sendo o gate e ausência
 * de linha = habilitado. Ver lib/email/tipos.ts (catálogo) e
 * lib/email/destinatarios.ts (quem consome no envio).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users, preferenciasEmail } from "@/db/schema";
import { asc, sql } from "drizzle-orm";
import { requireAdmin, handleApiError } from "@/lib/api/guards";
import { registrarAuditoria } from "@/lib/audit/queries";
import { CATALOGO_EMAIL, ehTipoEmail, papelElegivel } from "@/lib/email/tipos";

export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
  } catch (e) {
    return handleApiError(e, req);
  }

  const [usuarios, prefs] = await Promise.all([
    db
      .select({ id: users.id, email: users.email, nome: users.nome, role: users.role, ativo: users.ativo })
      .from(users)
      .orderBy(asc(users.nome), asc(users.email)),
    db
      .select({ userId: preferenciasEmail.userId, tipo: preferenciasEmail.tipo, habilitado: preferenciasEmail.habilitado })
      .from(preferenciasEmail),
  ]);

  // Só as EXCEÇÕES trafegam (ausência de linha = habilitado). O client
  // reconstrói o estado com `desligados` + a regra de papel do catálogo.
  const desligados = prefs
    .filter((p) => !p.habilitado)
    .map((p) => ({ userId: p.userId, tipo: p.tipo }));

  return NextResponse.json({ tipos: CATALOGO_EMAIL, usuarios, desligados });
}

export async function PATCH(req: NextRequest) {
  let session;
  try {
    ({ session } = await requireAdmin());
  } catch (e) {
    return handleApiError(e, req);
  }

  let body: { userId?: string; tipo?: string; habilitado?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  const { userId, tipo, habilitado } = body;

  if (!userId)                     return NextResponse.json({ error: "userId é obrigatório" }, { status: 400 });
  if (!ehTipoEmail(tipo))          return NextResponse.json({ error: "Tipo de e-mail desconhecido" }, { status: 422 });
  if (typeof habilitado !== "boolean") return NextResponse.json({ error: "habilitado deve ser boolean" }, { status: 400 });

  const [alvo] = await db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(sql`${users.id} = ${userId}`);

  if (!alvo) return NextResponse.json({ error: "Usuário não encontrado" }, { status: 404 });

  // Guarda da semântica subtrativa: ligar um tipo para quem o papel não alcança
  // seria uma promessa que o cron não cumpre — o broadcast filtra por papel
  // antes de olhar a preferência. Recusar aqui evita um toggle "verde" mentiroso.
  if (habilitado && !papelElegivel(tipo, alvo.role)) {
    return NextResponse.json(
      { error: `O papel ${alvo.role} não recebe "${tipo}" — a preferência não amplia o alcance do papel.` },
      { status: 422 },
    );
  }

  await db
    .insert(preferenciasEmail)
    .values({ userId, tipo, habilitado })
    .onConflictDoUpdate({
      target: [preferenciasEmail.userId, preferenciasEmail.tipo],
      set:    { habilitado, atualizadoEm: new Date() },
    });

  await registrarAuditoria({
    userId:     session.user.id,
    acao:       habilitado ? "PREFERENCIA_EMAIL_LIGADA" : "PREFERENCIA_EMAIL_DESLIGADA",
    entidade:   "preferencias_email",
    entidadeId: userId,
    detalhes:   { tipo, habilitado, alvo: alvo.email },
  });

  return NextResponse.json({ userId, tipo, habilitado });
}
