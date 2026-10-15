export const runtime = "nodejs";

/**
 * GET    /api/conformidade/cofre/documentos/[id]/profissionais             — quem assina o documento
 * POST   /api/conformidade/cofre/documentos/[id]/profissionais             — vincula (ou re-vincula)
 * DELETE /api/conformidade/cofre/documentos/[id]/profissionais?profissionalId=  — desvincula
 *
 * Molde literal: `…/documentos/[id]/projetos/route.ts`, com UMA divergência
 * DECLARADA (spec ONDA-4 §1j): o GET usa `requireConformidade`, não
 * `requireVisualizar`. Copiar o molde colocaria nome, CREA e formação de
 * pessoas atrás do piso mais baixo do sistema, enquanto a MESMA informação, na
 * tela /acervo/profissionais, fica atrás de `isConformidade`.
 * `projetos/route.ts` NÃO é alterado (mudar o guard dele é mudar contrato de
 * uma rota que tem espelho, e não é desta onda).
 *
 * Guards: GET = `requireConformidade` (403 COM `code`);
 *         POST/DELETE = `requireAuth` + `podeGerenciarDocumentosHabilitacao`
 *         (403 SEM `code`).
 *
 * ⚠️ Nos TRÊS handlers, `paiRestritoInvisivel(id, role)` vem ANTES de qualquer
 * efeito e responde 404 com a MESMA string do documento inexistente — um 403
 * confirmaria a existência do pai (ADR-05).
 *
 * Vínculo repetido é IDEMPOTENTE (200, nunca 409): o gesto da tela é "este
 * profissional é RT deste documento", e repetir o gesto não é erro — o UNIQUE
 * `uniq_profdoc` é trava de integridade, não contrato de UX (§4.5).
 *
 * Sem espelho BFF: rota web-only no NGINX (§5.9) — e é justamente uma das que
 * um leitor desatento assume estarem cobertas porque "o cofre já está no BFF"
 * (o BFF tem `conf_cofre_doc_id_projetos.py`; não tem profissionais nem
 * atividades — §1i).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { podeGerenciarDocumentosHabilitacao } from "@/lib/permissions";
import { requireAuth, requireConformidade, handleApiError } from "@/lib/api/guards";
import { formatZodErrors } from "@/lib/conformidade/cofre/validations";
import { paiRestritoInvisivel } from "@/lib/conformidade/cofre/queries";
import { VincularProfissionalSchema } from "@/lib/conformidade/profissionais/validations";
import {
  desvincularProfissionalDocumento,
  listProfissionaisDoDocumento,
  vincularProfissionalDocumento,
} from "@/lib/conformidade/profissionais/queries";

type Params = { params: Promise<{ id: string }> };

function documentoNaoEncontrado() {
  return NextResponse.json({ error: "Documento não encontrado" }, { status: 404 });
}

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest, { params }: Params) {
  let user: Awaited<ReturnType<typeof requireConformidade>>["user"];
  try {
    ({ user } = await requireConformidade());
  } catch (e) {
    return handleApiError(e);
  }

  const { id } = await params;
  // Barreira do pai restrito (0034/S13 · ADR-05).
  if (await paiRestritoInvisivel(id, user.role)) return documentoNaoEncontrado();

  const data = await listProfissionaisDoDocumento(id);
  return NextResponse.json({ data });
}

// ── POST ─────────────────────────────────────────────────────────────────────

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
  // Barreira do pai restrito — ANTES de qualquer efeito.
  if (await paiRestritoInvisivel(id, session.user.role)) return documentoNaoEncontrado();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const parsed = VincularProfissionalSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: formatZodErrors(parsed.error) },
      { status: 422 }
    );
  }

  const data = parsed.data;

  const resultado = await vincularProfissionalDocumento({
    profissionalId: data.profissionalId,
    documentoId:    id,
    papel:          data.papel,
    numeroArt:      data.numeroArt ?? null,
  });

  // Profissional inexistente sai no MESMO formato do zod, campo a campo.
  if (!resultado.ok) {
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: resultado.detalhes },
      { status: 422 }
    );
  }

  // `entidadeId` é o DOCUMENTO, não o vínculo: quem abre o histórico de um
  // documento tem de ver quem passou a assiná-lo (mesmo critério de
  // ADICIONAR_PROJETO_DOC no molde).
  await db.insert(auditLog).values({
    userId:     session.user.id,
    acao:       "VINCULAR_PROFISSIONAL_DOC",
    entidade:   "documento_habilitacao",
    entidadeId: id,
    detalhes:   {
      profissionalId: data.profissionalId,
      papel:          data.papel,
      numeroArt:      data.numeroArt ?? null,
    },
  });

  return NextResponse.json(
    {
      vinculoId:      resultado.vinculoId,
      profissionalId: data.profissionalId,
      papel:          data.papel,
      numeroArt:      data.numeroArt ?? null,
    },
    // 201 quando o vínculo nasceu; 200 quando o gesto foi repetido e o que
    // mudou foi papel/numeroArt (§5.6) — repetir não é erro.
    { status: resultado.criado ? 201 : 200 }
  );
}

// ── DELETE ───────────────────────────────────────────────────────────────────

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
  // Barreira do pai restrito — ANTES de qualquer efeito.
  if (await paiRestritoInvisivel(id, session.user.role)) return documentoNaoEncontrado();

  const profissionalId = new URL(request.url).searchParams.get("profissionalId");
  if (!profissionalId) {
    return NextResponse.json({ error: "Query param profissionalId é obrigatório" }, { status: 400 });
  }

  // O DELETE casa os DOIS ids: vínculo inexistente e vínculo de outro
  // documento recebem o mesmo 404.
  const removido = await desvincularProfissionalDocumento(profissionalId, id);
  if (!removido) {
    return NextResponse.json({ error: "Vínculo não encontrado" }, { status: 404 });
  }

  await db.insert(auditLog).values({
    userId:     session.user.id,
    acao:       "DESVINCULAR_PROFISSIONAL_DOC",
    entidade:   "documento_habilitacao",
    entidadeId: id,
    detalhes:   { profissionalId },
  });

  return NextResponse.json({ ok: true });
}
