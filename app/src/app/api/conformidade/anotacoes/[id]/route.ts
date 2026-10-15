export const runtime = "nodejs";

/**
 * PATCH  /api/conformidade/anotacoes/[id] — edita o texto e/ou resolve.
 * DELETE /api/conformidade/anotacoes/[id] — apaga de verdade.
 *
 * Body do PATCH: `{ texto?, resolvida? }` — ao menos um dos dois. `{}` é 422:
 * um PATCH que não muda nada é erro de cliente, e responder 200 esconderia o
 * bug (o mesmo critério do PATCH de operação).
 * `resolvida: true` grava `resolvida_em`; `false` volta para NULL — resolver é
 * REVERSÍVEL, e é por isso que resolver é UPDATE e não DELETE. Não há
 * "arquivar": apagar é para o que não devia ter sido escrito.
 *
 * Guards, os mesmos nos dois handlers e nesta ordem (spec ONDA-5 §5.2):
 *  1. `requireAuth` → 401;
 *  2. `podeGerenciarDocumentosHabilitacao` → 403 `{ error: "Permissão negada" }`
 *     SEM `code` (checagem inline, convenção do módulo);
 *  3. `ehUuid(id)` falso → 404 `{ error: "Anotação não encontrada" }`;
 *  4. anotação inexistente → o MESMO 404;
 *  5. **autor ou ADMIN** → 403 `{ error: "Permissão negada" }`. Anotação de
 *     outra pessoa não é campo de formulário; e anotação de autor apagado
 *     (`autorId === null`) só o ADMIN edita — ninguém herda a autoria de quem
 *     saiu;
 *  6. alvo DOCUMENTO → `paiRestritoInvisivel` → 404 com a string de DOCUMENTO,
 *     não a de anotação: quem não pode saber que o documento existe também não
 *     pode saber que há anotação nele (ADR-05).
 *
 * ⚠️ `redigirPii` antes de gravar o texto novo (§1d), pela mesma razão do POST:
 * a fonte somos nós, e a resposta devolve o texto REDIGIDO.
 * ⚠️ `atualizadoEm` é setado NA MÃO dentro de `editarAnotacao`: não há trigger
 * em tabela nenhuma deste banco.
 * ⚠️ `audit_log` leva `{ anotacaoId, antes, depois }` com o TAMANHO do texto,
 * nunca o texto — a frase já está gravada, com outra retenção (§1d).
 *
 * Sem espelho BFF: rota web-only no NGINX (§5.9).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { auditLog, type AcervoAnotacao, type AlvoAnotacao } from "@/db/schema";
import { podeGerenciarDocumentosHabilitacao } from "@/lib/permissions";
import { requireAuth, handleApiError } from "@/lib/api/guards";
import { ehUuid } from "@/lib/conformidade/operacoes/validations";
import { formatZodErrors } from "@/lib/conformidade/cofre/validations";
import { paiRestritoInvisivel } from "@/lib/conformidade/cofre/queries";
import { EditarAnotacaoSchema } from "@/lib/conformidade/anotacoes/validations";
import {
  editarAnotacao,
  getAnotacaoRow,
  removerAnotacao,
} from "@/lib/conformidade/anotacoes/queries";
import { redigirPii } from "@/lib/seguranca/pii";

type Params = { params: Promise<{ id: string }> };

/**
 * De-para do alvo para a `entidade` do `audit_log` — os MESMOS rótulos das
 * ondas anteriores. Constante LOCAL, igual à do `../route.ts`: `route.ts` do
 * App Router só pode exportar handlers e `const` de configuração, e esta onda
 * não abre arquivo de lib novo para três linhas (§6 é lista fechada).
 */
const ENTIDADE_DO_ALVO: Record<AlvoAnotacao, string> = {
  OPERACAO:     "operacao",
  DOCUMENTO:    "documento_habilitacao",
  PROFISSIONAL: "profissional",
};

function anotacaoNaoEncontrada() {
  return NextResponse.json({ error: "Anotação não encontrada" }, { status: 404 });
}

function permissaoNegada() {
  return NextResponse.json({ error: "Permissão negada" }, { status: 403 });
}

function documentoNaoEncontrado() {
  return NextResponse.json({ error: "Documento não encontrado" }, { status: 404 });
}

/**
 * As SEIS checagens que PATCH e DELETE compartilham, na ordem do contrato.
 * Devolve a `NextResponse` de recusa OU a linha crua da anotação — os dois
 * handlers precisam dela (o audit precisa do "antes", e o alvo é quem decide o
 * `entidadeId`).
 */
async function guardaComum(
  id: string,
  sessionUser: { id: string; role: string },
): Promise<NextResponse | AcervoAnotacao> {
  if (!podeGerenciarDocumentosHabilitacao(sessionUser.role)) return permissaoNegada();

  // 404 — com a MESMA string — para id que não é UUID e para id inexistente.
  if (!ehUuid(id)) return anotacaoNaoEncontrada();

  const anotacao = await getAnotacaoRow(id);
  if (!anotacao) return anotacaoNaoEncontrada();

  // Autor ou ADMIN. `autorId === null` (autor desligado) recai no ADMIN: o
  // `null` nunca é igual a um id de sessão, então a comparação já resolve.
  const ehAutor = anotacao.autorId !== null && anotacao.autorId === sessionUser.id;
  if (!ehAutor && sessionUser.role !== "ADMIN") return permissaoNegada();

  // Barreira do pai restrito — ANTES de qualquer efeito, e com a string de
  // DOCUMENTO (ADR-05).
  if (anotacao.alvoTipo === "DOCUMENTO") {
    if (await paiRestritoInvisivel(anotacao.alvoId, sessionUser.role)) return documentoNaoEncontrado();
  }

  return anotacao;
}

// ── PATCH ────────────────────────────────────────────────────────────────────

export async function PATCH(request: NextRequest, { params }: Params) {
  let session;
  try {
    ({ session } = await requireAuth());
  } catch (e) {
    return handleApiError(e);
  }

  const { id } = await params;
  const guarda = await guardaComum(id, session.user);
  if (guarda instanceof NextResponse) return guarda;
  const atual = guarda;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const parsed = EditarAnotacaoSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: formatZodErrors(parsed.error) },
      { status: 422 }
    );
  }

  const data = parsed.data;

  // A redação é AQUI, como no POST — a query recebe o texto já redigido.
  const texto = data.texto !== undefined ? redigirPii(data.texto) : undefined;

  // Gêmea da conferência do POST: a redação só CRESCE o texto, e o teto do zod
  // vale para o que o usuário digitou. ANTES de `editarAnotacao` e antes do
  // `auditLog` — a mesma ordem "recusa antes de qualquer efeito" do arquivo —,
  // senão o UPDATE estoura o CHECK `chk_anot_texto` (23514) e vira 500.
  if (texto !== undefined && texto.length > 4000) {
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: { texto: "Anotação muito longa" } },
      { status: 422 }
    );
  }

  const atualizada = await editarAnotacao(id, { texto, resolvida: data.resolvida });
  // Só acontece se a anotação sumir entre a leitura e o UPDATE (outra aba
  // apagou). A resposta honesta é o mesmo 404.
  if (!atualizada) return anotacaoNaoEncontrada();

  // `{ antes, depois }` com APENAS o que mudou de valor, e com o TAMANHO do
  // texto — nunca o texto (§1d). Mandar de volta o valor que já estava gravado
  // não é edição e não pode virar linha de histórico.
  const antes: Record<string, unknown> = {};
  const depois: Record<string, unknown> = {};
  if (texto !== undefined && texto !== atual.texto) {
    antes.tamanho  = atual.texto.length;
    depois.tamanho = atualizada.texto.length;
  }
  const resolvidaAntes  = atual.resolvidaEm !== null;
  const resolvidaDepois = atualizada.resolvidaEm !== null;
  if (data.resolvida !== undefined && resolvidaAntes !== resolvidaDepois) {
    antes.resolvida  = resolvidaAntes;
    depois.resolvida = resolvidaDepois;
  }

  await db.insert(auditLog).values({
    userId:     session.user.id,
    acao:       "EDITAR_ANOTACAO",
    // `entidadeId` é o ALVO, nunca a anotação: é assim que a edição aparece no
    // histórico da obra (ou do documento) que foi anotada.
    entidade:   ENTIDADE_DO_ALVO[atual.alvoTipo],
    entidadeId: atual.alvoId,
    detalhes:   { anotacaoId: id, antes, depois },
  });

  return NextResponse.json(atualizada);
}

// ── DELETE ───────────────────────────────────────────────────────────────────

export async function DELETE(_request: NextRequest, { params }: Params) {
  let session;
  try {
    ({ session } = await requireAuth());
  } catch (e) {
    return handleApiError(e);
  }

  const { id } = await params;
  const guarda = await guardaComum(id, session.user);
  if (guarda instanceof NextResponse) return guarda;
  const atual = guarda;

  const removida = await removerAnotacao(id);
  // Corrida com outra aba: a anotação existia na leitura e não existe mais.
  if (!removida) return anotacaoNaoEncontrada();

  await db.insert(auditLog).values({
    userId:     session.user.id,
    acao:       "REMOVER_ANOTACAO",
    entidade:   ENTIDADE_DO_ALVO[atual.alvoTipo],
    entidadeId: atual.alvoId,
    detalhes:   { anotacaoId: id, alvoTipo: atual.alvoTipo, tamanho: atual.texto.length },
  });

  return NextResponse.json({ ok: true });
}
