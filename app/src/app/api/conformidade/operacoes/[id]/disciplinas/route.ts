export const runtime = "nodejs";

/**
 * GET /api/conformidade/operacoes/[id]/disciplinas — as disciplinas declaradas
 *     pela obra (B1). A ficha já recebe `disciplinas` do próprio R3; esta rota
 *     serve o MODAL do D3, que precisa do conjunto atual sem recarregar a ficha.
 * PUT /api/conformidade/operacoes/[id]/disciplinas — regrava o conjunto
 *     INTEIRO (não um delta), em transação (§5.2).
 *
 * Body do PUT: `{ disciplinaIds: string[] }` — lista VAZIA é válida e
 * significa "nenhuma disciplina"; omitir o campo é que é erro. Duplicata no
 * array não é erro: a query deduplica antes do INSERT.
 *
 * Guards: GET = `requireConformidade` (403 COM `code`, §1j);
 *         PUT = `requireAuth` + `podeGerenciarDocumentosHabilitacao`
 *         (403 SEM `code`, como todo 403 de papel checado à mão no módulo).
 * 404 — com a MESMA string — para id que não é UUID e para operação
 * inexistente (`ehUuid`).
 *
 * Ordem de checagens do PUT (§5.2, e a ordem é contrato):
 *   1. sessão  2. papel  3. `ehUuid` + operação existe  4. JSON  5. zod
 *   6. existência das disciplinas (`disciplinasExistentes`) → 422 no campo,
 *      ANTES da escrita: com a FK da 0043 no lugar, id inexistente viraria
 *      23503 → 500 (§1a).
 *
 * ⚠️ `operacoes.atualizadoEm` NÃO é tocado: disciplina não é coluna da
 * operação, e mexer no campo faria a ficha dizer que o cadastro mudou quando
 * não mudou (§5.2).
 *
 * Sem espelho BFF: rota web-only no NGINX (§5.9).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { podeGerenciarDocumentosHabilitacao } from "@/lib/permissions";
import { requireAuth, requireConformidade, handleApiError } from "@/lib/api/guards";
import { ehUuid, formatZodErrors } from "@/lib/conformidade/operacoes/validations";
import { DisciplinasOperacaoSchema } from "@/lib/conformidade/disciplinas/validations";
import {
  disciplinasExistentes,
  getDisciplinasByOperacao,
  setDisciplinasDaOperacao,
} from "@/lib/conformidade/disciplinas/queries";
import { getOperacaoById } from "@/lib/conformidade/operacoes/queries";

type Params = { params: Promise<{ id: string }> };

function notFound() {
  return NextResponse.json({ error: "Operação não encontrada" }, { status: 404 });
}

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    await requireConformidade();
  } catch (e) {
    return handleApiError(e);
  }

  const { id } = await params;
  if (!ehUuid(id)) return notFound();

  // A operação tem de existir: sem isto, operação inexistente devolveria lista
  // vazia com 200 — indistinguível de "existe e não declarou disciplina".
  const operacao = await getOperacaoById(id);
  if (!operacao) return notFound();

  const disciplinas = await getDisciplinasByOperacao(id);
  return NextResponse.json({ operacaoId: id, disciplinas });
}

// ── PUT ──────────────────────────────────────────────────────────────────────

export async function PUT(request: NextRequest, { params }: Params) {
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

  const operacao = await getOperacaoById(id);
  if (!operacao) return notFound();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const parsed = DisciplinasOperacaoSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: formatZodErrors(parsed.error) },
      { status: 422 }
    );
  }

  const { disciplinaIds } = parsed.data;

  // Existência ANTES da escrita (§1a): com `fk_opdisc_disciplina` no lugar, um
  // id bem formado e inexistente viraria 23503 → 500, sem dizer qual campo.
  // UMA mensagem com TODOS os ids que faltaram: o campo é um array e o
  // `formatZodErrors` é last-wins por path — uma mensagem por id se
  // sobrescreveria e a tela mostraria só o último.
  const pedidos = [...new Set(disciplinaIds)];
  if (pedidos.length > 0) {
    const encontrados = new Set(await disciplinasExistentes(pedidos));
    const faltantes = pedidos.filter((disciplinaId) => !encontrados.has(disciplinaId));
    if (faltantes.length > 0) {
      return NextResponse.json(
        {
          error: "Dados inválidos",
          detalhes: { disciplinaIds: `Disciplina não encontrada: ${faltantes.join(", ")}` },
        },
        { status: 422 }
      );
    }
  }

  // Transação: apaga e regrava o conjunto. O `{ antes, depois }` volta em
  // CÓDIGOS (não uuid) e relido do banco — quem lê o audit entende sem
  // consultar catálogo, e o registro é do que ficou gravado.
  const { antes, depois } = await setDisciplinasDaOperacao(id, disciplinaIds);

  await db.insert(auditLog).values({
    userId:     session.user.id,
    acao:       "DEFINIR_DISCIPLINAS_OPERACAO",
    entidade:   "operacao",
    entidadeId: id,
    detalhes:   { antes, depois },
  });

  // O MESMO shape do GET, já com o novo conjunto: a tela repinta os chips com
  // a resposta, sem uma segunda viagem.
  const disciplinas = await getDisciplinasByOperacao(id);
  return NextResponse.json({ operacaoId: id, disciplinas });
}
