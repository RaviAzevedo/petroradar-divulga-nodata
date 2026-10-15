export const runtime = "nodejs";

/**
 * GET  /api/admin/emails/assinaturas — Lista assinaturas do digest (0026)
 * POST /api/admin/emails/assinaturas — Cria assinatura (gestor × filtro)
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { assinaturasEmail, filtrosEmail, users, perfisInteresse } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { requireAdmin, handleApiError } from "@/lib/api/guards";
import { registrarAuditoria } from "@/lib/audit/queries";

const FORMATOS    = ["resumido", "completo"];
const FREQUENCIAS = ["tempo-real", "diario", "semanal"];

export async function GET() {
  try {
    await requireAdmin();
  } catch (e) {
    return handleApiError(e);
  }

  const lista = await db
    .select({
      id:            assinaturasEmail.id,
      formato:       assinaturasEmail.formato,
      relevanciaMinima: assinaturasEmail.relevanciaMinima,
      frequencia:    assinaturasEmail.frequencia,
      ativo:         assinaturasEmail.ativo,
      ultimoEnvioEm: assinaturasEmail.ultimoEnvioEm,
      criadoEm:      assinaturasEmail.criadoEm,
      userId:        users.id,
      userNome:      users.nome,
      userEmail:     users.email,
      userAtivo:     users.ativo,
      filtroId:      filtrosEmail.id,
      filtroNome:    filtrosEmail.nome,
      filtroAtivo:   filtrosEmail.ativo,
      perfilId:      perfisInteresse.id,
      perfilNome:    perfisInteresse.nome,
      perfilAtivo:   perfisInteresse.ativo,
    })
    .from(assinaturasEmail)
    .innerJoin(users, eq(assinaturasEmail.userId, users.id))
    // LEFT nos dois: a assinatura tem UMA origem (perfil, 0029; ou filtro legado).
    .leftJoin(filtrosEmail, eq(assinaturasEmail.filtroId, filtrosEmail.id))
    .leftJoin(perfisInteresse, eq(assinaturasEmail.perfilId, perfisInteresse.id))
    .orderBy(desc(assinaturasEmail.criadoEm));

  return NextResponse.json({ assinaturas: lista });
}

export async function POST(req: NextRequest) {
  let session;
  try {
    ({ session } = await requireAdmin());
  } catch (e) {
    return handleApiError(e);
  }

  let body: { userId?: string; filtroId?: string; perfilId?: string; formato?: string; frequencia?: string; relevanciaMinima?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }

  const { userId, filtroId, perfilId } = body;
  const formato    = body.formato ?? "resumido";
  const relevanciaMinima = ["ALTA", "MEDIA", "TODAS"].includes((body.relevanciaMinima ?? "").toUpperCase())
    ? body.relevanciaMinima!.toUpperCase()
    : "MEDIA";   // padrao: ALTA + MEDIA
  const frequencia = body.frequencia ?? "diario";

  // Exatamente UMA origem — o banco tambem garante (chk_assinatura_origem), mas
  // aqui a mensagem e util em vez de um 500 de constraint.
  if (!userId || (!filtroId && !perfilId) || (filtroId && perfilId)) {
    return NextResponse.json(
      { error: "Informe userId e EXATAMENTE UMA origem: perfilId (padrão) ou filtroId (legado)" },
      { status: 422 },
    );
  }
  if (!FORMATOS.includes(formato)) {
    return NextResponse.json({ error: "Formato inválido (resumido|completo)" }, { status: 422 });
  }
  if (!FREQUENCIAS.includes(frequencia)) {
    return NextResponse.json({ error: "Frequência inválida (tempo-real|diario|semanal)" }, { status: 422 });
  }

  try {
    const [nova] = await db
      .insert(assinaturasEmail)
      .values({ userId, filtroId: filtroId ?? null, perfilId: perfilId ?? null, formato, frequencia, relevanciaMinima, ativo: true })
      .returning({ id: assinaturasEmail.id });

    await registrarAuditoria({
      userId:     session.user.id,
      acao:       "ASSINATURA_EMAIL_CRIADA",
      entidade:   "assinaturas_email",
      entidadeId: nova.id,
      detalhes:   { userId, filtroId, perfilId, formato, frequencia },
    });

    return NextResponse.json(nova, { status: 201 });
  } catch (e: unknown) {
    // drizzle 0.45 embrulha em DrizzleQueryError — o código pg vive no cause.
    const code = (e as { code?: string; cause?: { code?: string } })?.code
      ?? (e as { cause?: { code?: string } })?.cause?.code;
    if (code === "23505") {
      return NextResponse.json({ error: "Este usuário já assina este filtro" }, { status: 409 });
    }
    if (code === "23503") {
      return NextResponse.json({ error: "Usuário ou filtro inexistente" }, { status: 422 });
    }
    return handleApiError(e, req);
  }
}
