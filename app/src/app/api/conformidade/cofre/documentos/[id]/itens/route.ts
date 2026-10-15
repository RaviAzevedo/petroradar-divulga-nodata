export const runtime = "nodejs";

/**
 * GET    /api/conformidade/cofre/documentos/[id]/itens          — os itens com
 *        TAG que o documento lista (Q9).
 * POST   /api/conformidade/cofre/documentos/[id]/itens          — cadastra um.
 * DELETE /api/conformidade/cofre/documentos/[id]/itens?itemId=  — remove.
 *
 * Body do POST: `{ tag, descricao?, especificacao?, ordem? }`.
 *
 * ⚠️ NÃO EXISTE `quantidade` NEM `unidade` (spec ONDA-5 §1f): a TAG diz QUAL
 * equipamento o documento lista. O `z.object()` faz strip de quem mandar o
 * campo.
 *
 * ⚠️ `tag` daqui NÃO é `documentosHabilitacao.tags`: aquilo é rótulo livre de
 * arquivamento do ARQUIVO ("urgente", "REF-A"); isto é a TAG de EQUIPAMENTO
 * citada dentro do documento ("P-101 A/B", "TQ-4210"). O `COMMENT ON` da 0044
 * diz o mesmo no banco.
 *
 * TAG repetida no MESMO documento (inclusive com outra caixa ou espaço à
 * volta) vira **422 no campo**, nunca o 23505 → 500 do índice
 * `uniq_docitem_tag`. `ordem` ausente vira `max(ordem) + 1` calculado NO
 * BANCO — duas abas abertas no mesmo documento calculariam a mesma ordem.
 *
 * Guards: GET = `requireConformidade` (403 COM `code`) — a divergência
 *         declarada em relação a `projetos/route.ts`, a mesma das duas
 *         satélites da onda 4;
 *         POST/DELETE = `requireAuth` + `podeGerenciarDocumentosHabilitacao`
 *         (403 SEM `code`). Nos TRÊS, `paiRestritoInvisivel(id, role)` vem
 *         ANTES de qualquer efeito e devolve o MESMO 404 do documento
 *         inexistente (ADR-05).
 *
 * ⚠️ Não há PATCH (§5.8): corrigir é apagar e recriar — o item tem TAG,
 * descrição e um jsonb, nenhuma história própria e nenhum id que alguém tenha
 * guardado. A mesma decisão de `documento_atividades` na onda 4.
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
import { CriarItemTagSchema } from "@/lib/conformidade/itens/validations";
import {
  criarItemTag,
  listItensDoDocumento,
  removerItemTag,
} from "@/lib/conformidade/itens/queries";

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

  const data = await listItensDoDocumento(id);
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

  const parsed = CriarItemTagSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: formatZodErrors(parsed.error) },
      { status: 422 }
    );
  }

  const data = parsed.data;

  const resultado = await criarItemTag({
    documentoId:    id,
    tag:            data.tag,
    descricao:      data.descricao      ?? null,
    especificacao:  data.especificacao  ?? null,
    ordem:          data.ordem ?? null,
  });

  // TAG já listada neste documento: 422 no campo, mesmo formato do zod.
  if (!resultado.ok) {
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: resultado.detalhes },
      { status: 422 }
    );
  }

  // `entidadeId` é o DOCUMENTO, não o item: quem abre o histórico de um
  // documento tem de ver o que foi acrescentado a ele.
  await db.insert(auditLog).values({
    userId:     session.user.id,
    acao:       "ADICIONAR_ITEM_DOC",
    entidade:   "documento_habilitacao",
    entidadeId: id,
    detalhes:   {
      itemId: resultado.id,
      tag:    data.tag,
    },
  });

  // O item criado sai no MESMO shape do GET, e por isso é RELIDO: `criarItemTag` devolve só o id, e a `ordem` pode ter
  // sido calculada no banco — montar o objeto aqui seria adivinhar o que o
  // banco gravou. A lista de um documento é curta.
  const criado = (await listItensDoDocumento(id)).find((i) => i.id === resultado.id);
  if (!criado) {
    // Só acontece se o documento (e, por CASCADE, o item) sumir entre o INSERT
    // e esta leitura. A resposta honesta é o 404 do documento.
    return documentoNaoEncontrado();
  }

  return NextResponse.json(criado, { status: 201 });
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

  const itemId = new URL(request.url).searchParams.get("itemId");
  if (!itemId) {
    return NextResponse.json({ error: "Query param itemId é obrigatório" }, { status: 400 });
  }

  // A TAG é lida ANTES de apagar porque o `detalhes` do audit a exige (§5): a
  // linha some no DELETE, e um histórico que só guarda o uuid do item não diz a
  // ninguém O QUE saiu do documento. A lista de um documento é curta, e esta
  // leitura já resolve o 404 — `itemId` de outro documento não está nela.
  const item = (await listItensDoDocumento(id)).find((i) => i.id === itemId);
  if (!item) {
    return NextResponse.json({ error: "Item não encontrado" }, { status: 404 });
  }

  // O WHERE casa os DOIS ids juntos (molde do DELETE de projeto): item
  // inexistente e item de outro documento recebem o mesmo 404, nunca 403 — e
  // aqui o `false` é a rede contra a corrida entre a leitura acima e o DELETE.
  const removido = await removerItemTag(id, itemId);
  if (!removido) {
    return NextResponse.json({ error: "Item não encontrado" }, { status: 404 });
  }

  await db.insert(auditLog).values({
    userId:     session.user.id,
    acao:       "REMOVER_ITEM_DOC",
    entidade:   "documento_habilitacao",
    entidadeId: id,
    detalhes:   { itemId, tag: item.tag },
  });

  return NextResponse.json({ ok: true });
}
