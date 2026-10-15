export const runtime = "nodejs";

/**
 * GET   /api/conformidade/operacoes/[id] — Dossiê da operação: a operação
 *       inteira mais as provas que ela tem no cofre, ordenadas por papel
 *       (atestado primeiro) e depois pela mais antiga. Na 0043 o corpo ganha
 *       `disciplinas` (as da obra, na ordem do catálogo) e cada documento ganha
 *       `disciplinaId` + `disciplina: { id, codigo, nome } | null`.
 * PATCH /api/conformidade/operacoes/[id] — Edita o cadastro (R4/B2 — 0034).
 *
 * Guards: GET = requireVisualizar (a ficha é a navegação do acervo — ADR-06),
 *         mas `valor`/`hh` são OMITIDOS fora de Conformidade e documento
 *         restrito é filtrado da lista. PATCH = requireConformidade (editar
 *         cadastro — inclusive `valor` — é ato de quem vê `valor`; P10).
 * 404 tanto para id inexistente quanto para id que não é UUID (ver `ehUuid`).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { operacoes, auditLog } from "@/db/schema";
import { eq } from "drizzle-orm";
import { isConformidade } from "@/lib/permissions";
import { requireVisualizar, requireConformidade, handleApiError } from "@/lib/api/guards";
import {
  ehUuid,
  EditarOperacaoSchema,
  formatZodErrors,
} from "@/lib/conformidade/operacoes/validations";
import {
  getOperacaoById,
  getDocumentosByOperacao,
} from "@/lib/conformidade/operacoes/queries";
import { getDisciplinasByOperacao } from "@/lib/conformidade/disciplinas/queries";

type Params = { params: Promise<{ id: string }> };

function notFound() {
  return NextResponse.json({ error: "Operação não encontrada" }, { status: 404 });
}

/**
 * `valor`/`hh` chegam como número no JSON, mas a coluna é `numeric` e o Drizzle
 * trabalha com STRING nela (mesmo helper do POST em ../route.ts).
 */
function numeroParaNumeric(valor: number | null | undefined): string | null {
  return valor === null || valor === undefined ? null : String(valor);
}

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest, { params }: Params) {
  let user: Awaited<ReturnType<typeof requireVisualizar>>["user"];
  try {
    ({ user } = await requireVisualizar());
  } catch (e) {
    return handleApiError(e);
  }

  const { id } = await params;
  if (!ehUuid(id)) return notFound();

  const operacao = await getOperacaoById(id);
  if (!operacao) return notFound();

  // 0043: duas viagens ao banco viram UMA rodada. `disciplinas` é atributo da
  // obra (bloco à parte na ficha, nunca uma 10ª seção — §1b) e NÃO é recortada
  // por papel: disciplina não é dado comercial, diferente de `valor`/`hh`.
  const [documentos, disciplinas] = await Promise.all([
    getDocumentosByOperacao(id, user.role),
    getDisciplinasByOperacao(id),
  ]);

  const corpo: Record<string, unknown> = { ...operacao, documentos, disciplinas };

  // Omissão de campo (fecha o vazamento na ficha — R3): fora de Conformidade
  // as chaves SOMEM da resposta. Omitir, não `null` — `null` significa "não
  // preenchido" e mentiria. Espelho idêntico no BFF (corpo.pop).
  if (!isConformidade(user.role)) {
    delete corpo.valor;
    delete corpo.hh;
  }

  return NextResponse.json(corpo);
}

// ── PATCH (R4 — nasce na 0034) ───────────────────────────────────────────────

export async function PATCH(request: NextRequest, { params }: Params) {
  let session;
  try {
    ({ session } = await requireConformidade());
  } catch (e) {
    return handleApiError(e);
  }

  const { id } = await params;
  if (!ehUuid(id)) return notFound();

  const atual = await getOperacaoById(id);
  if (!atual) return notFound();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  // `codigo` NÃO é editável (chave de negócio; é por ele que o seed casa) —
  // recusado ANTES do parse, qualquer valor, inclusive o atual. `origem`
  // presente é ignorado em silêncio (strip do z.object).
  if (typeof body === "object" && body !== null && "codigo" in body) {
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: { codigo: "não pode ser alterado" } },
      { status: 422 }
    );
  }

  const parsed = EditarOperacaoSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: formatZodErrors(parsed.error) },
      { status: 422 }
    );
  }

  const data = parsed.data;

  // Campo ausente → coluna não muda; presente com null (nos nullable) → NULL.
  // `atualizadoEm` SEMPRE explícito: não há trigger (comentário da 0033).
  const updates: Partial<typeof operacoes.$inferInsert> = {
    atualizadoEm: new Date(),
  };

  if (data.clienteNome !== undefined)       updates.clienteNome = data.clienteNome;
  if (data.clienteGrupo !== undefined)      updates.clienteGrupo = data.clienteGrupo;
  if (data.clienteCnpj !== undefined)       updates.clienteCnpj = data.clienteCnpj;
  if (data.contratoNumero !== undefined)    updates.contratoNumero = data.contratoNumero;
  if (data.unidade !== undefined)           updates.unidade = data.unidade;
  // 0044 (B5): ao lado de `unidade`, e com a mesma regra — `null` limpa, valor
  // troca, ausente não mexe. `atualizadoEm` já é a primeira chave do objeto e
  // o audit `{ antes, depois }` já é genérico por chave: nada mais a fazer.
  if (data.area !== undefined)              updates.area = data.area;
  if (data.detentora !== undefined)         updates.detentora = data.detentora;
  if (data.ramo !== undefined)              updates.ramo = data.ramo;
  if (data.onshoreOffshore !== undefined)   updates.onshoreOffshore = data.onshoreOffshore;
  if (data.periodoInicio !== undefined)     updates.periodoInicio = data.periodoInicio;
  if (data.periodoFim !== undefined)        updates.periodoFim = data.periodoFim;
  if (data.valor !== undefined)             updates.valor = numeroParaNumeric(data.valor);
  if (data.hh !== undefined)                updates.hh = numeroParaNumeric(data.hh);
  if (data.escopo !== undefined)            updates.escopo = data.escopo;
  if (data.familiasSugeridas !== undefined) updates.familiasSugeridas = data.familiasSugeridas;
  if (data.ativo !== undefined)             updates.ativo = data.ativo;

  const [atualizada] = await db
    .update(operacoes)
    .set(updates)
    .where(eq(operacoes.id, id))
    .returning();

  if (!atualizada) return notFound();

  // Audit com APENAS os campos alterados (valor antigo ≠ novo), na serialização
  // da resposta (datas/numeric já saem como string do Drizzle). Proibido
  // despejar o body inteiro.
  const antes: Record<string, unknown> = {};
  const depois: Record<string, unknown> = {};
  for (const chave of Object.keys(updates) as Array<keyof typeof updates>) {
    if (chave === "atualizadoEm") continue;
    const valorAntes = atual[chave as keyof typeof atual];
    const valorDepois = atualizada[chave as keyof typeof atualizada];
    if (JSON.stringify(valorAntes) !== JSON.stringify(valorDepois)) {
      antes[chave]  = valorAntes;
      depois[chave] = valorDepois;
    }
  }

  await db.insert(auditLog).values({
    userId:     session.user.id,
    acao:       "EDITAR_OPERACAO",
    entidade:   "operacao",
    entidadeId: id,
    detalhes:   { antes, depois },
  });

  return NextResponse.json(atualizada);
}
