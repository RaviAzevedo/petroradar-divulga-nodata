/**
 * GET/PATCH /api/preferencias-email — preferências de e-mail do PRÓPRIO usuário.
 *
 * Irmã de `/api/admin/emails/preferencias`, que faz o mesmo para qualquer pessoa
 * e exige ADMIN. Aqui o `userId` é SEMPRE o da sessão — nunca vem do corpo — para
 * que ninguém desligue o alerta de outra pessoa por esta porta.
 *
 * Semântica SUBTRATIVA (a mesma do resto do módulo):
 *   - o PAPEL é o teto: tipo fora do papel nunca chega, nem ligando aqui;
 *   - ausência de linha em `preferencias_email` = HABILITADO;
 *   - só as exceções (desligados) são persistidas.
 *
 * ROTA WEB-ONLY? Não: `/api/preferencias-email` não está nas exceções do nginx,
 * então vai para o BFF. Como o BFF ainda não tem espelho desta rota, ela está
 * declarada em `nginx` como web-only junto das demais de e-mail.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { preferenciasEmail } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireAuth, handleApiError } from "@/lib/api/guards";
import { CATALOGO_EMAIL, ehTipoEmail, type TipoEmail } from "@/lib/email/tipos";
import { registrarAuditoria } from "@/lib/audit/queries";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  let session;
  try {
    session = await requireAuth();
  } catch (e) {
    return handleApiError(e, req);
  }

  const userId = session.user.id;
  const role = session.user.role;

  const prefs = await db
    .select({ tipo: preferenciasEmail.tipo, habilitado: preferenciasEmail.habilitado })
    .from(preferenciasEmail)
    .where(eq(preferenciasEmail.userId, userId));

  const desligados = new Set(prefs.filter((p) => !p.habilitado).map((p) => p.tipo));

  // Só os tipos que o PAPEL permite — mostrar o que nunca chegaria seria mentira.
  const tipos = CATALOGO_EMAIL.filter(
    (t) => t.papeis.length === 0 || t.papeis.includes(role),
  ).map((t) => ({
    chave:      t.chave,
    label:      t.label,
    grupo:      t.grupo,
    origem:     t.origem,
    /** `origem: "VINCULO"` chega por ser responsável pelo registro, não por papel. */
    habilitado: !desligados.has(t.chave),
  }));

  return NextResponse.json({ tipos });
}

export async function PATCH(req: NextRequest) {
  let session;
  try {
    session = await requireAuth();
  } catch (e) {
    return handleApiError(e, req);
  }

  let body: { tipo?: string; habilitado?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const { tipo, habilitado } = body;
  if (!ehTipoEmail(tipo)) {
    return NextResponse.json({ error: "Tipo de e-mail desconhecido" }, { status: 422 });
  }
  if (typeof habilitado !== "boolean") {
    return NextResponse.json({ error: "habilitado deve ser booleano" }, { status: 422 });
  }

  // O papel é o teto: ligar um tipo que o papel não permite seria promessa falsa.
  const def = CATALOGO_EMAIL.find((t) => t.chave === tipo);
  if (def && def.papeis.length > 0 && !def.papeis.includes(session.user.role)) {
    return NextResponse.json(
      { error: "Seu papel não recebe este tipo de e-mail" },
      { status: 403 },
    );
  }

  const userId = session.user.id;

  await db
    .insert(preferenciasEmail)
    .values({ userId, tipo: tipo as TipoEmail, habilitado })
    .onConflictDoUpdate({
      target: [preferenciasEmail.userId, preferenciasEmail.tipo],
      set:    { habilitado },
    });

  await registrarAuditoria({
    userId,
    acao:       "PREFERENCIA_EMAIL_ALTERADA",
    entidade:   "preferencias_email",
    entidadeId: userId,
    detalhes:   { tipo, habilitado, proprio: true },
  });

  return NextResponse.json({ ok: true, tipo, habilitado });
}
