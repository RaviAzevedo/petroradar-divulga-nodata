export const runtime = "nodejs";

/**
 * GET  /api/conformidade/operacoes — Lista operações (catálogo + manuais) com
 *      contagem de provas por operação
 * POST /api/conformidade/operacoes — Cadastra operação à mão (origem = MANUAL)
 *
 * Query do GET:
 *  - busca?:     casa código, cliente ou nº do contrato (ILIKE, sem caixa)
 *  - comProva?:  "1"/"true" → só operações que já têm documento no cofre
 *  - detentora?: PROPONENTE | COLIGADA | PARCEIRO
 *  - ativo?:     "1"/"true" → só ativas; "0"/"false" → só inativas.
 *    ⚠️ AUSENTE = SEM FILTRO (ativas E inativas), que é EXATAMENTE o conjunto
 *    de hoje. Um default `true` aqui seria, ele mesmo, o corte escondido que o
 *    D11 existe para não repetir (spec ONDA-5 §1c) — e o dia seguinte seria
 *    "sumiram obras do índice". Lido FORA do zod, como `comProva`.
 *  - de? / ate?: janela AAAA-MM-DD sobre o PERÍODO DA OBRA, ambos ausentes por
 *    padrão. Obra sem um dos extremos fica fora e é CONTADA em `semPeriodo` —
 *    o número que sai da conta é contado, nunca sumido (Q4).
 *  - limit?:     1..200 (default 50)   - offset?: >=0 (default 0)
 *
 * Resposta do GET: `{ operacoes, total, filtros, semPeriodo }`. `filtros` ecoa
 * SÓ o que foi aplicado (chave ausente = filtro ausente) e `semPeriodo` sai
 * sempre — 0 quando não há janela. É o eco que deixa a tela escrever o recorte
 * por extenso sem adivinhar.
 *
 * ⚠️ Parâmetro inválido responde **400** `{ error: "Parâmetros inválidos",
 * detalhes }`, não 422: é o contrato de hoje desta rota e a tela já o trata
 * (§0.2). Não uniformizar ao acrescentar filtro.
 *
 * Guards: GET = requireConformidade (P10 — a lista expõe `valor`, e a tela foi
 *         homologada só para ADMIN/LIDER/SGI; 403 COM `code`).
 *         POST = requireAuth + podeGerenciarDocumentosHabilitacao — o MESMO do
 *         POST de documento no cofre, e o 403 sai SEM `code` (objeto de uma
 *         chave só), como todo 403 de papel checado à mão neste módulo.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { operacoes, auditLog } from "@/db/schema";
import { podeGerenciarDocumentosHabilitacao } from "@/lib/permissions";
import { requireAuth, requireConformidade, handleApiError } from "@/lib/api/guards";
import {
  CriarOperacaoSchema,
  FiltrosOperacaoSchema,
  formatZodErrors,
} from "@/lib/conformidade/operacoes/validations";
import { listOperacoes, getOperacaoByCodigo } from "@/lib/conformidade/operacoes/queries";

/**
 * `valor`/`hh` chegam como número no JSON, mas a coluna é `numeric` e o Drizzle
 * trabalha com STRING nela (é assim que o valor sai na resposta também).
 */
function numeroParaNumeric(valor: number | null | undefined): string | null {
  return valor === null || valor === undefined ? null : String(valor);
}

/**
 * D11 — flag booleana de TRÊS estados, lida fora do zod (molde literal do
 * `flagTresEstados` de `profissionais/route.ts`, onda 4): `"1"`/`"true"` ligam,
 * `"0"`/`"false"` desligam e qualquer outra coisa — inclusive o parâmetro
 * AUSENTE — é `undefined`, isto é, SEM FILTRO.
 *
 * É a diferença entre "só ativas" e "todas", e ela é explícita: o `undefined`
 * não empilha condição nenhuma na query e a chave nem aparece no eco de
 * `filtros`. Trocar por `z.coerce.boolean()` transformaria o ausente em
 * `false` e esconderia as ativas — o oposto do que D11 pede.
 */
function flagTresEstados(valor: string | null): boolean | undefined {
  if (valor === "1" || valor === "true")  return true;
  if (valor === "0" || valor === "false") return false;
  return undefined;
}

// ── GET /api/conformidade/operacoes ───────────────────────────────────────────

export async function GET(request: NextRequest) {
  // P10: era requireVisualizar e vazava `valor` a 6 papéis. Consequência aceita
  // (ADR-06): ORCAMENTISTA/TECNICO perdem o SeletorOperacao do upload — seguem
  // subindo documento SEM operação (o POST do cofre não muda de guard).
  try {
    await requireConformidade();
  } catch (e) {
    return handleApiError(e);
  }

  const { searchParams } = new URL(request.url);

  // Flag booleana lida fora do zod, igual ao `validadeIndeterminada` do POST do
  // cofre: "1" e "true" ligam, qualquer outra coisa (inclusive ausente) desliga.
  const comProvaRaw = searchParams.get("comProva");

  const parsed = FiltrosOperacaoSchema.safeParse({
    busca:     searchParams.get("busca")     ?? undefined,
    comProva:  comProvaRaw === "1" || comProvaRaw === "true",
    detentora: searchParams.get("detentora") ?? undefined,
    // D11 (0044): tri-estado e janela de período, todos SEM default que corte.
    ativo:     flagTresEstados(searchParams.get("ativo")),
    de:        searchParams.get("de")        ?? undefined,
    ate:       searchParams.get("ate")       ?? undefined,
    limit:     searchParams.get("limit")     ?? "50",
    offset:    searchParams.get("offset")    ?? "0",
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Parâmetros inválidos", detalhes: formatZodErrors(parsed.error) },
      { status: 400 }
    );
  }

  const result = await listOperacoes(parsed.data);
  return NextResponse.json(result);
}

// ── POST /api/conformidade/operacoes ──────────────────────────────────────────

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

  const parsed = CriarOperacaoSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: formatZodErrors(parsed.error) },
      { status: 422 }
    );
  }

  const data = parsed.data;

  // Unicidade pelo código (a chave de negócio, UNIQUE no banco). Comparação
  // exata: o código é alfanumérico e o catálogo já o traz normalizado.
  const existente = await getOperacaoByCodigo(data.codigo);
  if (existente) {
    return NextResponse.json(
      { error: "Já existe operação com esse código" },
      { status: 409 }
    );
  }

  const [nova] = await db
    .insert(operacoes)
    .values({
      codigo:            data.codigo,
      clienteNome:       data.clienteNome,
      clienteGrupo:      data.clienteGrupo    ?? null,
      clienteCnpj:       data.clienteCnpj     ?? null,
      contratoNumero:    data.contratoNumero  ?? null,
      unidade:           data.unidade         ?? null,
      // 0044 (B5): a ÁREA dentro da planta ("U-32", "Área 30", "Off-site").
      // Texto livre, sem catálogo — o vocabulário é do cliente (§1l). Convive
      // com `unidade`, que diz outra coisa (a planta/base) e não muda.
      area:              data.area            ?? null,
      detentora:         data.detentora,
      ramo:              data.ramo            ?? null,
      onshoreOffshore:   data.onshoreOffshore ?? null,
      periodoInicio:     data.periodoInicio   ?? null,
      periodoFim:        data.periodoFim      ?? null,
      valor:             numeroParaNumeric(data.valor),
      hh:                numeroParaNumeric(data.hh),
      escopo:            data.escopo            ?? null,
      familiasSugeridas: data.familiasSugeridas ?? null,
      // Cadastro de tela é sempre MANUAL: CATALOGO é privativo do seed, e a
      // separação é o que deixa re-semear o catálogo sem pisar no que foi digitado.
      origem: "MANUAL",
    })
    .returning();

  await db.insert(auditLog).values({
    userId:     session.user.id,
    acao:       "CRIAR_OPERACAO",
    entidade:   "operacao",
    entidadeId: nova.id,
    detalhes:   { codigo: nova.codigo, clienteNome: nova.clienteNome, detentora: nova.detentora },
  });

  return NextResponse.json(nova, { status: 201 });
}
