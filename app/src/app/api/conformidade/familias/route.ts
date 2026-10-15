export const runtime = "nodejs";

/**
 * GET  /api/conformidade/familias — Lista famílias com filtros e paginação
 * POST /api/conformidade/familias — Cria nova família CRC
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { familias, auditLog } from "@/db/schema";
import { eq, isNull, and } from "drizzle-orm";
import { podeGerenciarFamilias } from "@/lib/permissions";
import { requireAuth, requireVisualizar, handleApiError } from "@/lib/api/guards";
import {
  CriarFamiliaSchema,
  FiltrosFamiliaSchema,
  formatZodErrors,
  normalizarCodigoCrc,
} from "@/lib/conformidade/familias/validations";
import { listFamilias } from "@/lib/conformidade/familias/queries";

// ── GET /api/conformidade/familias ────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  try {
    await requireVisualizar();
  } catch (e) {
    return handleApiError(e);
  }

  const { searchParams } = new URL(request.url);

  const parsed = FiltrosFamiliaSchema.safeParse({
    status:            searchParams.get("status")            ?? undefined,
    statusFluxoCrc:    searchParams.get("statusFluxoCrc")    ?? undefined,
    segmentoPetrobras: searchParams.get("segmentoPetrobras") ?? undefined,
    nivel:             searchParams.get("nivel")             ?? undefined,
    parentId:          searchParams.get("parentId")          ?? undefined,
    busca:             searchParams.get("busca")             ?? undefined,
    vencendoEm:        searchParams.get("vencendoEm")        ?? undefined,
    page:              searchParams.get("page")              ?? "1",
    limit:              searchParams.get("limit")            ?? "50",
    order:             searchParams.get("order")             ?? "codigo",
    dir:               searchParams.get("dir")               ?? "asc",
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Parâmetros inválidos", detalhes: formatZodErrors(parsed.error) },
      { status: 400 }
    );
  }

  const result = await listFamilias(parsed.data);
  return NextResponse.json(result);
}

// ── POST /api/conformidade/familias ───────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  let session;
  try {
    ({ session } = await requireAuth());
  } catch (e) {
    return handleApiError(e);
  }
  if (!podeGerenciarFamilias(session.user.role)) {
    return NextResponse.json({ error: "Permissão negada" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const parsed = CriarFamiliaSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: formatZodErrors(parsed.error) },
      { status: 422 }
    );
  }

  const data = parsed.data;
  const codigoNormalizado = normalizarCodigoCrc(data.codigoCrc);

  // Verifica unicidade do código
  const [existente] = await db
    .select({ id: familias.id })
    .from(familias)
    .where(
      and(
        eq(familias.codigoNormalizado, codigoNormalizado),
        isNull(familias.deletadoEm)
      )
    )
    .limit(1);

  if (existente) {
    return NextResponse.json(
      { error: `Já existe uma família com código ${data.codigoCrc}` },
      { status: 409 }
    );
  }

  // Resolve path se houver parent
  let path: string | null = null;
  if (data.parentId) {
    const [parent] = await db
      .select({ id: familias.id, codigoCrc: familias.codigoCrc, path: familias.path })
      .from(familias)
      .where(eq(familias.parentId, data.parentId))
      .limit(1);

    if (parent?.path) {
      path = `${parent.path}/${data.codigoCrc}`;
    } else {
      path = data.codigoCrc;
    }
  } else {
    path = data.codigoCrc;
  }

  const validadeFim = data.validadeFim ? new Date(data.validadeFim) : null;
  // Renovação Petrobras: 60 dias antes do vencimento
  const proximaRenovacaoEm = validadeFim
    ? new Date(validadeFim.getTime() - 60 * 24 * 60 * 60 * 1000)
    : null;

  const [nova] = await db
    .insert(familias)
    .values({
      codigoCrc:           data.codigoCrc,
      codigoNormalizado,
      nome:                data.nome,
      descricao:           data.descricao || null,
      nivel:               data.nivel,
      parentId:            data.parentId || null,
      path,
      cadastroCorporativo: data.cadastroCorporativo,
      segmentoPetrobras:   data.segmentoPetrobras ?? null,
      status:              data.status,
      statusFluxoCrc:      data.statusFluxoCrc ?? null,
      validadeFim,
      proximaRenovacaoEm,
      criterios:           data.criterios   ?? null,
      tags:                data.tags        ?? null,
      escoposCobertos:     data.escoposCobertos ?? null,
      observacoes:         data.observacoes ?? null,
      criadoPor:           session.user.id,
      atualizadoPor:       session.user.id,
    })
    .returning();

  await db.insert(auditLog).values({
    userId:     session.user.id,
    acao:       "CRIAR_FAMILIA",
    entidade:   "familia",
    entidadeId: nova.id,
    detalhes:   { codigoCrc: nova.codigoCrc, nome: nova.nome, status: nova.status },
  });

  return NextResponse.json(nova, { status: 201 });
}
