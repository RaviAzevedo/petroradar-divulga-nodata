export const runtime = "nodejs";

/**
 * GET   /api/conformidade/profissionais/[id] — a pessoa e as obras que ela
 *       assina (D5). É o cabeçalho da página do currículo.
 * PATCH /api/conformidade/profissionais/[id] — edita o cadastro.
 *       `ativo: false` é o "excluir" desta entidade.
 *
 * Body do PATCH (tudo opcional — manda-se só o que muda; `{}` é PATCH válido
 * que não muda nada): `{ nome?, crea?, creaUf?, formacao?, ativo? }`.
 *
 * Guards: GET   = `requireConformidade` (403 COM `code`, §1j);
 *         PATCH = `requireAuth` + `podeGerenciarDocumentosHabilitacao`
 *         (403 SEM `code`).
 * 404 — com a MESMA string — para id que não é UUID e para id inexistente.
 *
 * ⚠️ Não existe DELETE: apagar o profissional levaria junto os vínculos
 * (`ON DELETE CASCADE`), isto é, o rastro de quem assinou o quê. Desligar é
 * `{ ativo: false }`, e o desligado continua aparecendo na lista de quem não
 * filtrar por `ativo` (§5.5).
 *
 * ⚠️ `atualizadoEm` é setado NA MÃO: `profissionais` não tem trigger (o
 * comentário está no schema), e sem isto o campo mentiria.
 *
 * Sem espelho BFF: rota web-only no NGINX (§5.9).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { profissionais, auditLog } from "@/db/schema";
import { eq } from "drizzle-orm";
import { podeGerenciarDocumentosHabilitacao } from "@/lib/permissions";
import { requireAuth, requireConformidade, handleApiError } from "@/lib/api/guards";
import { ehUuid } from "@/lib/conformidade/operacoes/validations";
import { formatZodErrors } from "@/lib/conformidade/cofre/validations";
import { EditarProfissionalSchema } from "@/lib/conformidade/profissionais/validations";
import {
  getProfissionalById,
  getProfissionalPorCrea,
  getProfissionalRow,
} from "@/lib/conformidade/profissionais/queries";

type Params = { params: Promise<{ id: string }> };

function notFound() {
  return NextResponse.json({ error: "Profissional não encontrado" }, { status: 404 });
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
  if (!ehUuid(id)) return notFound();

  // O papel desce até as DUAS queries (contagem e documentos): sem isso, um
  // documento restrito apareceria na contagem de quem não pode vê-lo.
  const detalhe = await getProfissionalById(id, user.role);
  if (!detalhe) return notFound();

  // `valor`/`hh` da operação NÃO entram neste shape (P10): a lista de obras de
  // um RT não é o lugar de expor o porte comercial — quem quer o valor abre a
  // ficha, que já faz a omissão por papel.
  return NextResponse.json(detalhe);
}

// ── PATCH ────────────────────────────────────────────────────────────────────

export async function PATCH(request: NextRequest, { params }: Params) {
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
  if (!ehUuid(id)) return notFound();

  // A linha crua: o audit precisa do "antes" campo a campo, e a lista com os
  // JOINs não serve para isso.
  const atual = await getProfissionalRow(id);
  if (!atual) return notFound();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const parsed = EditarProfissionalSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: formatZodErrors(parsed.error) },
      { status: 422 }
    );
  }

  const data = parsed.data;

  // CREA já usado por OUTRO profissional vira 422 no campo, antes do UPDATE
  // (o 23505 de `uniq_profissional_crea` chegaria como 500). Trocar o CREA por
  // ele mesmo não é conflito — por isso a comparação com o próprio id.
  if (data.crea) {
    const dono = await getProfissionalPorCrea(data.crea);
    if (dono && dono.id !== id) {
      return NextResponse.json(
        { error: "Dados inválidos", detalhes: { crea: "Já existe profissional com este CREA" } },
        { status: 422 }
      );
    }
  }

  // Campo ausente → coluna não muda; presente com null (nos nullable) → NULL.
  // `atualizadoEm` SEMPRE explícito: não há trigger.
  const updates: Partial<typeof profissionais.$inferInsert> = {
    atualizadoEm: new Date(),
  };

  if (data.nome !== undefined)     updates.nome     = data.nome;
  if (data.crea !== undefined)     updates.crea     = data.crea;
  if (data.creaUf !== undefined)   updates.creaUf   = data.creaUf;
  if (data.formacao !== undefined) updates.formacao = data.formacao;
  if (data.ativo !== undefined)    updates.ativo    = data.ativo;

  const [atualizado] = await db
    .update(profissionais)
    .set(updates)
    .where(eq(profissionais.id, id))
    .returning();

  if (!atualizado) return notFound();

  // Audit com APENAS os campos alterados (valor antigo ≠ novo), na
  // serialização da resposta. Proibido despejar o body inteiro: mandar de
  // volta o valor que já estava gravado não é edição e não pode virar linha
  // de histórico.
  const antes: Record<string, unknown> = {};
  const depois: Record<string, unknown> = {};
  for (const chave of Object.keys(updates) as Array<keyof typeof updates>) {
    if (chave === "atualizadoEm") continue;
    const valorAntes  = atual[chave as keyof typeof atual];
    const valorDepois = atualizado[chave as keyof typeof atualizado];
    if (JSON.stringify(valorAntes) !== JSON.stringify(valorDepois)) {
      antes[chave]  = valorAntes;
      depois[chave] = valorDepois;
    }
  }

  await db.insert(auditLog).values({
    userId:     session.user.id,
    acao:       "EDITAR_PROFISSIONAL",
    entidade:   "profissional",
    entidadeId: id,
    detalhes:   { antes, depois },
  });

  return NextResponse.json(atualizado);
}
