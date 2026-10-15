export const runtime = "nodejs";

/**
 * GET    /api/conformidade/cofre/documentos/[id]/atividades            — as atividades da ART
 * POST   /api/conformidade/cofre/documentos/[id]/atividades            — cadastra uma atividade
 * DELETE /api/conformidade/cofre/documentos/[id]/atividades?atividadeId=  — remove
 *
 * Body do POST: `{ atividade, quantidadeTexto?, ordem? }`.
 *
 * ⚠️ `quantidadeTexto` é TEXTO, nunca número (§1c / Q10.6): é a quantidade
 * como está ESCRITA na ART ("3.600,00 HH", "12.000 m"), exibida e JAMAIS
 * somada, por ninguém.
 *
 * `ordem` ausente vira `max(ordem) + 1` calculado NO BANCO — duas abas abertas
 * na mesma ART calculariam a mesma ordem.
 *
 * Guards: GET = `requireConformidade` (403 COM `code`, §1j);
 *         POST/DELETE = `requireAuth` + `podeGerenciarDocumentosHabilitacao`
 *         (403 SEM `code`). Nos TRÊS, `paiRestritoInvisivel(id, role)` vem
 *         ANTES de qualquer efeito e devolve o MESMO 404 do documento
 *         inexistente (ADR-05).
 *
 * ⚠️ Não há PATCH nesta onda (§5.7): corrigir é apagar e recriar — a linha tem
 * três campos e nenhuma história própria. Registrado em §10 caso a tela peça.
 *
 * Sem espelho BFF: rota web-only no NGINX (§5.9).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { podeGerenciarDocumentosHabilitacao } from "@/lib/permissions";
import { requireAuth, requireConformidade, handleApiError } from "@/lib/api/guards";
import { formatZodErrors } from "@/lib/conformidade/cofre/validations";
import { paiRestritoInvisivel } from "@/lib/conformidade/cofre/queries";
import { CriarAtividadeSchema } from "@/lib/conformidade/profissionais/validations";
import {
  criarAtividade,
  listAtividadesDoDocumento,
  removerAtividade,
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

  const data = await listAtividadesDoDocumento(id);
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

  const parsed = CriarAtividadeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: formatZodErrors(parsed.error) },
      { status: 422 }
    );
  }

  const data = parsed.data;

  const atividadeId = await criarAtividade({
    documentoId:     id,
    atividade:       data.atividade,
    quantidadeTexto: data.quantidadeTexto ?? null,
    ordem:           data.ordem ?? null,
  });

  // `entidadeId` é o DOCUMENTO, não a atividade: quem abre o histórico de um
  // documento tem de ver o que foi acrescentado a ele.
  await db.insert(auditLog).values({
    userId:     session.user.id,
    acao:       "ADICIONAR_ATIVIDADE_DOC",
    entidade:   "documento_habilitacao",
    entidadeId: id,
    detalhes:   {
      atividadeId,
      atividade: data.atividade,
    },
  });

  // A atividade criada sai no MESMO shape do GET, e por isso é RELIDA: `criarAtividade` devolve só o id, e a
  // `ordem` pode ter sido calculada no banco — montar o objeto aqui seria
  // adivinhar o que o banco gravou. A lista de um documento é curta.
  const criada = (await listAtividadesDoDocumento(id)).find((a) => a.id === atividadeId);
  if (!criada) {
    // Só acontece se o documento (e, por CASCADE, a atividade) sumir entre o
    // INSERT e esta leitura. A resposta honesta é o 404 do documento.
    return documentoNaoEncontrado();
  }

  return NextResponse.json(criada, { status: 201 });
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

  const atividadeId = new URL(request.url).searchParams.get("atividadeId");
  if (!atividadeId) {
    return NextResponse.json({ error: "Query param atividadeId é obrigatório" }, { status: 400 });
  }

  // O WHERE casa os DOIS ids juntos (molde do DELETE de projeto): atividade
  // inexistente e atividade de outro documento recebem o mesmo 404.
  const removida = await removerAtividade(id, atividadeId);
  if (!removida) {
    return NextResponse.json({ error: "Atividade não encontrada" }, { status: 404 });
  }

  await db.insert(auditLog).values({
    userId:     session.user.id,
    acao:       "REMOVER_ATIVIDADE_DOC",
    entidade:   "documento_habilitacao",
    entidadeId: id,
    detalhes:   { atividadeId },
  });

  return NextResponse.json({ ok: true });
}
