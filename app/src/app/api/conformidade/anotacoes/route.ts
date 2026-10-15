export const runtime = "nodejs";

/**
 * GET  /api/conformidade/anotacoes?alvoTipo=&alvoId=&resolvidas= — as anotações
 *      de UM alvo (B7). Os dois primeiros são OBRIGATÓRIOS: não existe "listar
 *      todas as anotações" — a anotação só faz sentido ao lado da coisa
 *      anotada, e uma lista global viraria um mural que ninguém mantém.
 * POST /api/conformidade/anotacoes — grava uma anotação.
 *
 * Query do GET:
 *  - `alvoTipo`:   OPERACAO | DOCUMENTO | PROFISSIONAL;
 *  - `alvoId`:     uuid do alvo;
 *  - `resolvidas?`: `"1"`/`"true"` traz também as resolvidas, lido FORA do zod
 *    (padrão do `semOperacao` do cofre e do `comProva` de R1). Default `false`,
 *    e o default é ECOADO em `filtros` — corte que existe aparece (Q10.3).
 *
 * Resposta do GET: `{ anotacoes, abertas, resolvidas, filtros }`. Os dois
 * contadores contam o ALVO INTEIRO, não o recorte: se levassem o filtro,
 * `resolvidas: false` devolveria `resolvidas: 0` e a frase da tela esconderia
 * exatamente o que o eco existe para mostrar.
 *
 * Body do POST: `{ alvoTipo, alvoId, texto }`.
 * ⚠️ `autorId`/`autorNome` NÃO são campos de formulário: vêm da sessão (o
 * `z.object()` faz strip de quem os mandar no body).
 *
 * ⚠️ `alvoExiste` NÃO é chamado no GET (spec ONDA-5 §5.1): alvo inexistente
 * devolve lista vazia com 200, que é a verdade ("não há anotação"), e a
 * checagem custaria uma query em toda abertura de ficha. No POST ela é
 * obrigatória — lá o dano é gravar apontando para nada.
 *
 * ⚠️ O texto vai REDIGIDO (`redigirPii`) para o banco E para a resposta (§1d).
 * Quem escreveu um CPF recebe `[CPF-REMOVIDO]` de volta — é assim que ele
 * descobre a regra. Devolver o original faria a tela mentir sobre o que ficou
 * gravado. O número de ART de 11 dígitos continua legível: `cpfValido` confere
 * os dois dígitos verificadores antes de marcar.
 *
 * ⚠️ A anotação NÃO mora em `audit_log` (§1d): aquela tabela tem expurgo de 12
 * meses (0035_audit_restrito.sql:4) e a anotação é conhecimento do acervo. O
 * `audit_log` registra QUE houve anotação — `{ anotacaoId, alvoTipo, tamanho }`
 * —, nunca o texto.
 *
 * Guards: GET  = `requireConformidade` (403 COM `code`);
 *         POST = `requireAuth` + `podeGerenciarDocumentosHabilitacao`
 *         (403 SEM `code`, checagem inline).
 * Alvo DOCUMENTO restrito para papel fora de Conformidade recebe o MESMO 404 do
 * inexistente, ANTES de qualquer efeito (`paiRestritoInvisivel`, ADR-05).
 *
 * Sem espelho BFF: rota web-only no NGINX (§5.9).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { auditLog, type AlvoAnotacao } from "@/db/schema";
import { podeGerenciarDocumentosHabilitacao } from "@/lib/permissions";
import { requireAuth, requireConformidade, handleApiError } from "@/lib/api/guards";
import { formatZodErrors } from "@/lib/conformidade/cofre/validations";
import { paiRestritoInvisivel } from "@/lib/conformidade/cofre/queries";
import {
  CriarAnotacaoSchema,
  FiltrosAnotacaoSchema,
} from "@/lib/conformidade/anotacoes/validations";
import { alvoExiste, criarAnotacao, listAnotacoes } from "@/lib/conformidade/anotacoes/queries";
import { redigirPii } from "@/lib/seguranca/pii";

/**
 * De-para do alvo para a `entidade` do `audit_log` — os MESMOS rótulos que as
 * ondas anteriores já gravam. `entidadeId` é o ALVO, nunca a anotação: quem
 * abre o histórico de uma obra tem de ver que alguém anotou nela, e um audit
 * indexado pelo id da anotação não aparece em tela nenhuma.
 *
 * Constante LOCAL, repetida no `[id]/route.ts` irmão: `route.ts` do App Router
 * só pode exportar os handlers e os `const` de configuração, e esta onda não
 * abre arquivo de lib novo para três linhas (§6 é lista fechada).
 */
const ENTIDADE_DO_ALVO: Record<AlvoAnotacao, string> = {
  OPERACAO:     "operacao",
  DOCUMENTO:    "documento_habilitacao",
  PROFISSIONAL: "profissional",
};

function documentoNaoEncontrado() {
  return NextResponse.json({ error: "Documento não encontrado" }, { status: 404 });
}

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  let user: Awaited<ReturnType<typeof requireConformidade>>["user"];
  try {
    ({ user } = await requireConformidade());
  } catch (e) {
    return handleApiError(e);
  }

  const { searchParams } = new URL(request.url);

  // Flag booleana lida fora do zod: "1" e "true" ligam, qualquer outra coisa
  // (inclusive ausente) desliga — e o `false` resultante é ecoado em `filtros`.
  const resolvidasRaw = searchParams.get("resolvidas");

  const parsed = FiltrosAnotacaoSchema.safeParse({
    alvoTipo:   searchParams.get("alvoTipo") ?? undefined,
    alvoId:     searchParams.get("alvoId")   ?? undefined,
    resolvidas: resolvidasRaw === "1" || resolvidasRaw === "true",
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: formatZodErrors(parsed.error) },
      { status: 422 }
    );
  }

  // Barreira do pai restrito (ADR-05) — o 404 é o MESMO do documento
  // inexistente: quem não pode saber que o documento existe também não pode
  // saber que há anotação nele.
  //
  // Neste GET ela é cinto-e-suspensório, e de propósito: `requireConformidade`
  // já barrou todo papel que `paiRestritoInvisivel` recusaria, então hoje ela
  // nunca dispara. Fica porque o dia em que o guard deste GET descer para
  // `requireVisualizar` (como `projetos/`) não pode ser o dia em que o
  // documento restrito vaza pela lista de anotações. Mesma decisão das duas
  // satélites da onda 4.
  if (parsed.data.alvoTipo === "DOCUMENTO") {
    if (await paiRestritoInvisivel(parsed.data.alvoId, user.role)) return documentoNaoEncontrado();
  }

  const resultado = await listAnotacoes(parsed.data);
  return NextResponse.json(resultado);
}

// ── POST ─────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  let session;
  try {
    ({ session } = await requireAuth());
  } catch (e) {
    return handleApiError(e);
  }
  if (!podeGerenciarDocumentosHabilitacao(session.user.role)) {
    return NextResponse.json({ error: "Permissão negada" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const parsed = CriarAnotacaoSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: formatZodErrors(parsed.error) },
      { status: 422 }
    );
  }

  const data = parsed.data;

  // Barreira do pai restrito — ANTES de qualquer efeito, inclusive antes da
  // checagem de existência (que responderia 422 e denunciaria o documento).
  if (data.alvoTipo === "DOCUMENTO") {
    if (await paiRestritoInvisivel(data.alvoId, session.user.role)) return documentoNaoEncontrado();
  }

  // `alvo_id` não tem FK, de propósito (§2.3): sem esta checagem a anotação
  // nasceria apontando para nada e ninguém a alcançaria de novo.
  if (!(await alvoExiste(data.alvoTipo, data.alvoId))) {
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: { alvoId: "Alvo não encontrado" } },
      { status: 422 }
    );
  }

  // A redação é AQUI, no handler, e não num `.transform()` do zod nem dentro da
  // query: é onde a política do módulo já está escrita para o `ocrTexto`, e é
  // onde quem lê o handler a enxerga (§4.3).
  const texto = redigirPii(data.texto);

  // A redação só CRESCE o texto (`[EMAIL-REMOVIDO]` tem 16 caracteres e cabe
  // num e-mail de 6; `[CPF-REMOVIDO]` tem 14 e cabe num CPF de 11): o teto do
  // zod vale para o que o usuário DIGITOU, e é o teto do CHECK `chk_anot_texto`
  // (0044) que o texto GRAVADO tem de respeitar. Sem esta conferência o INSERT
  // estoura 23514 e o handler devolve 500 onde cabe um 422.
  if (texto.length > 4000) {
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: { texto: "Anotação muito longa" } },
      { status: 422 }
    );
  }

  const criada = await criarAnotacao({
    alvoTipo:  data.alvoTipo,
    alvoId:    data.alvoId,
    autorId:   session.user.id,
    // `users.nome` é NULLABLE e o usuário pode ser desligado: o nome vai
    // desnormalizado para a linha, senão a anotação viraria "alguém escreveu
    // isto". O último fallback nunca dispara com o login por e-mail de hoje.
    autorNome: session.user.name ?? session.user.email ?? "Usuário",
    texto,
  });

  // `entidadeId` é o ALVO (§5): é assim que a anotação de uma obra aparece no
  // HistoricoAuditoria DA OBRA. `detalhes` leva o TAMANHO, nunca o texto — a
  // frase já está gravada, com retenção diferente da do `audit_log` (§1d).
  await db.insert(auditLog).values({
    userId:     session.user.id,
    acao:       "CRIAR_ANOTACAO",
    entidade:   ENTIDADE_DO_ALVO[data.alvoTipo],
    entidadeId: data.alvoId,
    detalhes:   { anotacaoId: criada.id, alvoTipo: data.alvoTipo, tamanho: texto.length },
  });

  return NextResponse.json(criada, { status: 201 });
}
