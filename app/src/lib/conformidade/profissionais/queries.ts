/**
 * Queries Reutilizáveis — Profissionais, vínculos, atividades de ART e o
 * currículo do RT (migration 0043)
 *
 * Regra da casa: handler não monta SQL. Tudo o que as rotas
 * /api/conformidade/profissionais*, as satélites
 * /api/conformidade/cofre/documentos/[id]/{profissionais,atividades}, a tela
 * /acervo/profissionais e o relatório `curriculo-rt` (C1) leem do banco está
 * aqui — um só lugar decide o que é "o currículo de um RT".
 *
 * Quatro decisões valem para o arquivo inteiro:
 *
 * 1. `restricaoVisivel(role)` ENTRA EM TODA LISTA DE DOCUMENTO, nas linhas E
 *    na contagem (ADR-05 / 00-ARQUITETURA §3.2). Contar um documento restrito
 *    numa lista que não o mostra é denunciar a existência dele — e é o tipo de
 *    vazamento que nenhuma tela acusa. O predicado é o do cofre
 *    (`cofre/queries.ts`), nunca uma cópia.
 *
 * 2. CONTAGEM POR SUBCONSULTA AGREGADA, nunca `count()` no JOIN principal
 *    (Q10.5): `totalDocumentos` e `totalOperacoes` no mesmo GROUP BY do JOIN
 *    multiplicariam linha, e o número do profissional sairia inflado
 *    exatamente como o do sistema de origem. Molde: `contagensPorOperacao()`
 *    de `operacoes/queries.ts`.
 *
 * 3. NENHUMA SOMA MORA AQUI. O currículo exibe a quantidade escrita na ART
 *    (`quantidadeTexto`) como TEXTO — evidência literal, jamais somada.
 *
 * 4. `count(*)` leva `::int` — o driver `pg` entrega bigint como string e a
 *    tela espera 0, não "0".
 */

import { db } from "@/db";
import {
  disciplinas,
  documentoAtividades,
  documentosHabilitacao,
  operacaoDisciplinas,
  operacoes,
  profissionais,
  profissionalDocumentos,
  type PapelProfissional,
  type Profissional,
} from "@/db/schema";
import { and, asc, count, eq, gt, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { restricaoVisivel } from "@/lib/conformidade/cofre/queries";
import { escaparLike } from "@/lib/conformidade/disciplinas/queries";
// Só o TIPO: o shape dos chips de disciplina é contrato de R1, R3, da ficha e
// do currículo, e tem de ser um só (spec §4.3).
import type { DisciplinaDaOperacao } from "@/lib/conformidade/disciplinas/queries";
import { PAPEIS_PROFISSIONAL, type FiltrosProfissionalInput } from "./validations";

// ── Ordem de exibição do papel do profissional ──────────────────────────────

/**
 * RT primeiro, depois corresponsável, depois equipe — a MESMA ordem da tupla
 * `PAPEIS_PROFISSIONAL`, gerada dela (molde `ORDEM_PAPEL` de
 * `operacoes/queries.ts`) para não existir uma segunda lista de papéis fora do
 * domínio. O CHECK `chk_profdoc_papel` garante que nada cai no ELSE 99.
 */
const ORDEM_PAPEL_PROFISSIONAL = sql`CASE ${profissionalDocumentos.papel} ${sql.join(
  PAPEIS_PROFISSIONAL.map((papel, i) => sql`WHEN ${papel} THEN ${sql.raw(String(i))}`),
  sql` `
)} ELSE 99 END`;


// ═══════════════════════════════════════════════════════════════════════════
// LISTA E DETALHE DO PROFISSIONAL
// ═══════════════════════════════════════════════════════════════════════════

export type ProfissionalLista = {
  id: string;
  nome: string;
  crea: string | null;
  creaUf: string | null;
  formacao: string | null;
  ativo: boolean;
  /** documentos VISÍVEIS para o papel (restricaoVisivel) — nunca o total cru */
  totalDocumentos: number;
  /** operações DISTINCT desses documentos (documento sem operação não conta) */
  totalOperacoes: number;
  criadoEm: Date | null;
  atualizadoEm: Date | null;
};

/**
 * Subconsulta agregada: uma linha por profissional com quantos documentos
 * VISÍVEIS ele assina e em quantas operações distintas. `role` entra no
 * predicado (decisão 1 do cabeçalho) — sem ele, a contagem de um papel fora de
 * Conformidade denunciaria o documento restrito que a lista esconde.
 *
 * `count(DISTINCT …)::int` nos dois: `uniq_profdoc` já garante uma linha por
 * par, mas o DISTINCT é a trava que sobrevive a um JOIN a mais amanhã (Q10.5);
 * o `::int` é porque `count` é bigint e o driver `pg` entrega bigint como
 * string. `count(DISTINCT operacao_id)` ignora NULL de graça — documento sem
 * operação não vira "uma obra".
 */
function contagensPorProfissional(role: string) {
  return db
    .select({
      profissionalId: profissionalDocumentos.profissionalId,
      totalDocumentos: sql<number>`count(DISTINCT ${documentosHabilitacao.id})::int`.as("total_documentos"),
      totalOperacoes:  sql<number>`count(DISTINCT ${documentosHabilitacao.operacaoId})::int`.as("total_operacoes"),
    })
    .from(profissionalDocumentos)
    .innerJoin(documentosHabilitacao, eq(documentosHabilitacao.id, profissionalDocumentos.documentoId))
    .where(restricaoVisivel(role))
    .groupBy(profissionalDocumentos.profissionalId)
    .as("contagens");
}

/**
 * Lista de profissionais com filtros EXPLÍCITOS — nenhum corte escondido
 * (Q10.3): sem `ativo` na query a lista traz ativos E inativos, e `filtros`
 * ecoa exatamente o que foi aplicado.
 *
 * `comDocumento` é um estreitamento (o mesmo desenho do `comProva` de R1):
 * `true` acrescenta `totalDocumentos > 0`; `false` NÃO inverte o filtro (não
 * existe "só quem não tem documento" em tela nenhuma) e, por isso, não aparece
 * no eco — o eco diz o que foi aplicado, não o que foi digitado.
 *
 * Ordem `nome ASC, id ASC`: nome de pessoa repete, e sem o desempate a
 * paginação repetiria ou pularia linha entre páginas.
 */
export async function listProfissionais(
  filtros: FiltrosProfissionalInput,
  role: string,
): Promise<{ profissionais: ProfissionalLista[]; total: number; filtros: Record<string, unknown> }> {
  const contagens = contagensPorProfissional(role);

  const conditions: SQL[] = [];

  if (filtros.busca) {
    // `escaparLike` porque o termo vem de URL compartilhável: um `%` cru
    // viraria filtro escondido. `lower(nome) LIKE lower(termo)` usa o índice
    // `idx_profissional_nome` (que é em lower(nome)); o CREA é curto e casa
    // por ILIKE mesmo.
    const termo = `%${escaparLike(filtros.busca)}%`;
    conditions.push(
      or(
        sql`lower(${profissionais.nome}) LIKE lower(${termo})`,
        ilike(profissionais.crea, termo),
      )!
    );
  }

  if (filtros.ativo !== undefined) {
    conditions.push(eq(profissionais.ativo, filtros.ativo));
  }

  if (filtros.comDocumento) {
    conditions.push(gt(contagens.totalDocumentos, 0));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        id:       profissionais.id,
        nome:     profissionais.nome,
        crea:     profissionais.crea,
        creaUf:   profissionais.creaUf,
        formacao: profissionais.formacao,
        ativo:    profissionais.ativo,
        // COALESCE porque o LEFT JOIN devolve NULL para quem não assina nada —
        // a tela espera 0, e o profissional recém-criado não pode sumir.
        totalDocumentos: sql<number>`coalesce(${contagens.totalDocumentos}, 0)`.as("total_documentos"),
        totalOperacoes:  sql<number>`coalesce(${contagens.totalOperacoes}, 0)`.as("total_operacoes"),
        criadoEm:     profissionais.criadoEm,
        atualizadoEm: profissionais.atualizadoEm,
      })
      .from(profissionais)
      .leftJoin(contagens, eq(contagens.profissionalId, profissionais.id))
      .where(where)
      .orderBy(asc(profissionais.nome), asc(profissionais.id))
      .limit(filtros.limit)
      .offset(filtros.offset),

    db
      .select({ total: count() })
      .from(profissionais)
      .leftJoin(contagens, eq(contagens.profissionalId, profissionais.id))
      .where(where),
  ]);

  const eco: Record<string, unknown> = { limit: filtros.limit, offset: filtros.offset };
  if (filtros.busca)              eco.busca = filtros.busca;
  if (filtros.ativo !== undefined) eco.ativo = filtros.ativo;
  if (filtros.comDocumento)        eco.comDocumento = true;

  return { profissionais: rows, total: totalRow?.total ?? 0, filtros: eco };
}

export type DocumentoDoProfissional = {
  documentoId: string;
  titulo: string;
  tipoDocumento: string | null;
  nomeArquivo: string;
  contentType: string | null;
  papelProfissional: PapelProfissional;
  numeroArt: string | null;
  emitidoEm: Date | null;
  numeroDocumento: string | null;
  disciplina: { id: string; codigo: string; nome: string } | null;
  operacaoId: string | null;
  operacaoCodigo: string | null;
  clienteNome: string | null;
  clienteGrupo: string | null;
  /** coluna `date` — o Drizzle devolve a STRING "AAAA-MM-DD" */
  periodoInicio: string | null;
  periodoFim: string | null;
};

/**
 * As obras que a pessoa assina, na ordem do currículo: operação mais recente
 * primeiro (`periodoFim DESC NULLS LAST`, código como desempate), e dentro da
 * obra o papel do profissional (RT primeiro), depois emissão mais recente e
 * `id` como desempate total.
 *
 * `NULLS LAST` explícito no DESC: no Postgres, `DESC` põe NULL na FRENTE — sem
 * isso a obra sem período informado abriria o currículo.
 *
 * ⚠️ `valor`/`hh` da operação NÃO entram neste shape (P10): a lista de obras de
 * um RT não é o lugar de expor o porte comercial; quem quer o valor abre a
 * ficha, que já faz a omissão por papel.
 */
async function documentosDoProfissional(
  profissionalId: string,
  role: string,
): Promise<DocumentoDoProfissional[]> {
  const rows = await db
    .select({
      documentoId:       documentosHabilitacao.id,
      titulo:            documentosHabilitacao.titulo,
      tipoDocumento:     documentosHabilitacao.tipoDocumento,
      nomeArquivo:       documentosHabilitacao.nomeArquivo,
      contentType:       documentosHabilitacao.contentType,
      papelProfissional: profissionalDocumentos.papel,
      numeroArt:         profissionalDocumentos.numeroArt,
      emitidoEm:         documentosHabilitacao.emitidoEm,
      numeroDocumento:   documentosHabilitacao.numeroDocumento,
      // Achatados no SELECT e aninhados no map — o mesmo desmonte que
      // `listDocumentos` já faz com `operacao`.
      disciplinaId:     documentosHabilitacao.disciplinaId,
      disciplinaCodigo: disciplinas.codigo,
      disciplinaNome:   disciplinas.nome,
      operacaoId:       documentosHabilitacao.operacaoId,
      operacaoCodigo:   operacoes.codigo,
      clienteNome:      operacoes.clienteNome,
      clienteGrupo:     operacoes.clienteGrupo,
      periodoInicio:    operacoes.periodoInicio,
      periodoFim:       operacoes.periodoFim,
    })
    .from(profissionalDocumentos)
    .innerJoin(documentosHabilitacao, eq(documentosHabilitacao.id, profissionalDocumentos.documentoId))
    .leftJoin(operacoes, eq(documentosHabilitacao.operacaoId, operacoes.id))
    .leftJoin(disciplinas, eq(documentosHabilitacao.disciplinaId, disciplinas.id))
    .where(
      and(
        eq(profissionalDocumentos.profissionalId, profissionalId),
        restricaoVisivel(role),
      )
    )
    .orderBy(
      sql`${operacoes.periodoFim} DESC NULLS LAST`,
      asc(operacoes.codigo),
      ORDEM_PAPEL_PROFISSIONAL,
      sql`${documentosHabilitacao.emitidoEm} DESC NULLS LAST`,
      asc(documentosHabilitacao.id),
    );

  return rows.map((row) => {
    const { disciplinaId, disciplinaCodigo, disciplinaNome, ...documento } = row;
    return {
      ...documento,
      // Documento sem disciplina sai com `null`, não com um objeto de campos
      // nulos — o cliente não distingue "não tem" de "veio quebrado".
      disciplina:
        disciplinaId !== null && disciplinaCodigo !== null && disciplinaNome !== null
          ? { id: disciplinaId, codigo: disciplinaCodigo, nome: disciplinaNome }
          : null,
    };
  });
}

/**
 * A linha da pessoa COM as duas contagens — o mesmo shape da lista, para a
 * ficha do profissional e a tabela não discordarem em nenhum número.
 * `restricaoVisivel(role)` entra pela subconsulta (decisão 1 do cabeçalho).
 */
async function profissionalComContagens(id: string, role: string): Promise<ProfissionalLista | null> {
  const contagens = contagensPorProfissional(role);

  const [row] = await db
    .select({
      id:       profissionais.id,
      nome:     profissionais.nome,
      crea:     profissionais.crea,
      creaUf:   profissionais.creaUf,
      formacao: profissionais.formacao,
      ativo:    profissionais.ativo,
      totalDocumentos: sql<number>`coalesce(${contagens.totalDocumentos}, 0)`.as("total_documentos"),
      totalOperacoes:  sql<number>`coalesce(${contagens.totalOperacoes}, 0)`.as("total_operacoes"),
      criadoEm:     profissionais.criadoEm,
      atualizadoEm: profissionais.atualizadoEm,
    })
    .from(profissionais)
    .leftJoin(contagens, eq(contagens.profissionalId, profissionais.id))
    .where(eq(profissionais.id, id))
    .limit(1);

  return row ?? null;
}

/**
 * Detalhe: a pessoa e as obras que ela assina. `null` quando o id não existe —
 * a rota devolve o MESMO 404 do id não-UUID (ADR-05).
 *
 * As DUAS queries levam `restricaoVisivel(role)`: sem isso, um documento
 * restrito apareceria na contagem de um papel que não pode vê-lo.
 */
export async function getProfissionalById(
  id: string,
  role: string,
): Promise<{ profissional: ProfissionalLista; documentos: DocumentoDoProfissional[] } | null> {
  const [profissional, documentos] = await Promise.all([
    profissionalComContagens(id, role),
    documentosDoProfissional(id, role),
  ]);

  if (!profissional) return null;
  return { profissional, documentos };
}

/**
 * A linha crua, para as rotas decidirem sobre existência e `ativo` sem pagar
 * os JOINs (o PATCH precisa do "antes" campo a campo para o audit).
 */
export async function getProfissionalRow(id: string): Promise<Profissional | null> {
  const [row] = await db
    .select()
    .from(profissionais)
    .where(eq(profissionais.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * O profissional que já usa este CREA, se houver — a checagem que o POST e o
 * PATCH fazem ANTES de escrever, para o 23505 do índice único parcial
 * (`uniq_profissional_crea`) nunca virar 500 no lugar do 422 no campo.
 *
 * Devolve o id: o PATCH precisa comparar com o id que está editando (trocar o
 * CREA por ele mesmo não é conflito).
 */
export async function getProfissionalPorCrea(crea: string): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: profissionais.id })
    .from(profissionais)
    .where(eq(profissionais.crea, crea))
    .limit(1);
  return row ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
// VÍNCULO PROFISSIONAL × DOCUMENTO (B2)
// ═══════════════════════════════════════════════════════════════════════════

export type VinculoDoDocumento = {
  vinculoId: string;
  profissionalId: string;
  nome: string;
  crea: string | null;
  creaUf: string | null;
  papel: PapelProfissional;
  numeroArt: string | null;
};

/**
 * "Quem assina ESTE documento" — a lista da página do documento e do currículo.
 *
 * Sem `role`: quem chega aqui já passou por `paiRestritoInvisivel(id, role)` na
 * rota (ADR-05), que é onde a barreira do pai restrito mora. Repetir o
 * predicado aqui esconderia a lista sem esconder o 404, que é o contrário do
 * contrato.
 *
 * Ordem: RT primeiro, depois nome (e `id` como desempate total).
 */
export async function listProfissionaisDoDocumento(documentoId: string): Promise<VinculoDoDocumento[]> {
  return db
    .select({
      vinculoId:      profissionalDocumentos.id,
      profissionalId: profissionais.id,
      nome:           profissionais.nome,
      crea:           profissionais.crea,
      creaUf:         profissionais.creaUf,
      papel:          profissionalDocumentos.papel,
      numeroArt:      profissionalDocumentos.numeroArt,
    })
    .from(profissionalDocumentos)
    .innerJoin(profissionais, eq(profissionais.id, profissionalDocumentos.profissionalId))
    .where(eq(profissionalDocumentos.documentoId, documentoId))
    .orderBy(ORDEM_PAPEL_PROFISSIONAL, asc(profissionais.nome), asc(profissionais.id));
}

export type ResultadoVinculo =
  | { ok: true; vinculoId: string; criado: boolean }
  /** vai direto no 422 `{ error: "Dados inválidos", detalhes }` — campo a campo, como o zod */
  | { ok: false; detalhes: Record<string, string> };

/**
 * Vincula (ou re-vincula) um profissional ao documento.
 *
 * IDEMPOTENTE, não 409: o gesto da tela é "este profissional é RT deste
 * documento", e repetir o gesto não pode ser erro — vínculo já existente vira
 * UPDATE de `papel`/`numeroArt`. O UNIQUE `uniq_profdoc` é a trava de
 * INTEGRIDADE, não o contrato de UX.
 *
 * `onConflictDoUpdate` (e não SELECT + INSERT) porque duas abas salvando ao
 * mesmo tempo cairiam no 23505 → 500. O SELECT que vem antes serve só para a
 * rota saber se deve responder 201 ou 200 (§5.6) — se ele perder a corrida, o
 * pior que acontece é um 201 onde caberia 200, e o dado fica certo.
 *
 * Não confere `restricaoVisivel`: a barreira do pai restrito é
 * `paiRestritoInvisivel(documentoId, role)`, ANTES de qualquer efeito, na rota.
 */
export async function vincularProfissionalDocumento(args: {
  profissionalId: string;
  documentoId: string;
  papel: PapelProfissional;
  numeroArt: string | null;
}): Promise<ResultadoVinculo> {
  const [profissional] = await db
    .select({ id: profissionais.id })
    .from(profissionais)
    .where(eq(profissionais.id, args.profissionalId))
    .limit(1);

  if (!profissional) {
    return { ok: false, detalhes: { profissionalId: "Profissional não encontrado" } };
  }

  const [existente] = await db
    .select({ id: profissionalDocumentos.id })
    .from(profissionalDocumentos)
    .where(
      and(
        eq(profissionalDocumentos.profissionalId, args.profissionalId),
        eq(profissionalDocumentos.documentoId, args.documentoId),
      )
    )
    .limit(1);

  const [linha] = await db
    .insert(profissionalDocumentos)
    .values({
      profissionalId: args.profissionalId,
      documentoId:    args.documentoId,
      papel:          args.papel,
      numeroArt:      args.numeroArt,
    })
    .onConflictDoUpdate({
      target: [profissionalDocumentos.profissionalId, profissionalDocumentos.documentoId],
      set: { papel: args.papel, numeroArt: args.numeroArt },
    })
    .returning({ id: profissionalDocumentos.id });

  // O `returning` do upsert sempre devolve linha (INSERT ou UPDATE); o
  // fallback existe só para o tipo não mentir.
  return { ok: true, vinculoId: linha?.id ?? existente?.id ?? "", criado: existente === undefined };
}

/** `false` quando não havia vínculo — a rota devolve 404 `{ error: "Vínculo não encontrado" }`. */
export async function desvincularProfissionalDocumento(
  profissionalId: string,
  documentoId: string,
): Promise<boolean> {
  const apagados = await db
    .delete(profissionalDocumentos)
    .where(
      and(
        eq(profissionalDocumentos.profissionalId, profissionalId),
        eq(profissionalDocumentos.documentoId, documentoId),
      )
    )
    .returning({ id: profissionalDocumentos.id });

  return apagados.length > 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// ATIVIDADES DA ART (B3)
// ═══════════════════════════════════════════════════════════════════════════

export type AtividadeDoDocumento = {
  id: string;
  atividade: string;
  /**
   * ⚠️ TEXTO, nunca número (§1c / Q10.6): é a quantidade como está ESCRITA na
   * ART ("3.600,00 HH"). Exibida e jamais somada.
   */
  quantidadeTexto: string | null;
  ordem: number;
};

/**
 * O SELECT das atividades — compartilhado pela rota-satélite (um documento) e
 * pelo currículo (vários), para os dois devolverem o MESMO shape.
 */
function consultaAtividades() {
  return db
    .select({
      id:              documentoAtividades.id,
      documentoId:     documentoAtividades.documentoId,
      atividade:       documentoAtividades.atividade,
      quantidadeTexto: documentoAtividades.quantidadeTexto,
      ordem:           documentoAtividades.ordem,
    })
    .from(documentoAtividades);
}

type LinhaAtividade = Awaited<ReturnType<ReturnType<typeof consultaAtividades>["execute"]>>[number];

function montarAtividade(linha: LinhaAtividade): AtividadeDoDocumento {
  const { documentoId: _documentoId, ...atividade } = linha;
  return atividade;
}

/** As atividades de UM documento. Ordem: `ordem`, depois criação, `id` no fim como desempate total. */
export async function listAtividadesDoDocumento(documentoId: string): Promise<AtividadeDoDocumento[]> {
  const rows = await consultaAtividades()
    .where(eq(documentoAtividades.documentoId, documentoId))
    .orderBy(asc(documentoAtividades.ordem), asc(documentoAtividades.criadoEm), asc(documentoAtividades.id));

  return rows.map(montarAtividade);
}

/**
 * Cadastra uma atividade da ART. Devolve o id criado.
 *
 * `ordem` ausente → `max(ordem) + 1` calculado NO BANCO, não no cliente: duas
 * abas abertas na mesma ART calculariam a mesma ordem e as linhas sairiam
 * embaralhadas. `coalesce(max(...), -1) + 1` faz a primeira atividade nascer
 * com ordem 0, que é o default da coluna.
 */
export async function criarAtividade(args: {
  documentoId: string;
  atividade: string;
  quantidadeTexto: string | null;
  ordem: number | null;
}): Promise<string> {
  const proximaOrdem = sql<number>`(SELECT coalesce(max(${documentoAtividades.ordem}), -1) + 1
    FROM ${documentoAtividades} WHERE ${documentoAtividades.documentoId} = ${args.documentoId})`;

  const [linha] = await db
    .insert(documentoAtividades)
    .values({
      documentoId:     args.documentoId,
      atividade:       args.atividade,
      quantidadeTexto: args.quantidadeTexto,
      ordem:           args.ordem ?? proximaOrdem,
    })
    .returning({ id: documentoAtividades.id });

  return linha!.id;
}

/**
 * `false` quando a atividade não existe OU é de outro documento — o WHERE casa
 * os dois ids juntos (molde do DELETE de projeto), e a rota devolve o mesmo
 * 404 nos dois casos.
 */
export async function removerAtividade(documentoId: string, atividadeId: string): Promise<boolean> {
  const apagadas = await db
    .delete(documentoAtividades)
    .where(
      and(
        eq(documentoAtividades.id, atividadeId),
        eq(documentoAtividades.documentoId, documentoId),
      )
    )
    .returning({ id: documentoAtividades.id });

  return apagadas.length > 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// C1 — CURRÍCULO DO RT
// ═══════════════════════════════════════════════════════════════════════════

/** Uma linha da aba "Obras e atividades" do relatório C1 (§5.10) — o contrato das colunas. */
export type LinhaCurriculo = {
  operacaoCodigo: string;
  clienteNome: string;
  periodo: string | null;
  /** código da disciplina do DOCUMENTO (não a da obra) */
  disciplina: string | null;
  documentoTitulo: string;
  tipoDocumento: string | null;
  /** rótulo, de `PAPEL_PROFISSIONAL_LABELS` — nunca o enum cru */
  papelProfissional: string;
  numeroArt: string | null;
  /** null quando o documento não tem atividade cadastrada — e a linha existe assim mesmo */
  atividade: string | null;
  /** TEXTO da ART — nunca somado */
  quantidadeTexto: string | null;
};

export type DocumentoDoCurriculo = {
  documentoId: string;
  titulo: string;
  tipoDocumento: string | null;
  papelProfissional: PapelProfissional;
  numeroArt: string | null;
  emitidoEm: Date | null;
  disciplina: { id: string; codigo: string; nome: string } | null;
  atividades: AtividadeDoDocumento[];
};

export type OperacaoDoCurriculo = {
  operacaoId: string;
  codigo: string;
  clienteNome: string;
  clienteGrupo: string | null;
  periodoInicio: string | null;
  periodoFim: string | null;
  disciplinasDaOperacao: DisciplinaDaOperacao[];
  documentos: DocumentoDoCurriculo[];
};

export type CurriculoRt = {
  geradoEm: string;
  profissional: {
    id: string; nome: string; crea: string | null; creaUf: string | null;
    formacao: string | null; ativo: boolean;
  };
  /** operação → disciplina → documento → atividade (a hierarquia do C1) */
  operacoes: OperacaoDoCurriculo[];
  contagens: { operacoes: number; documentos: number; atividades: number };
  /** documentos do RT que ficaram FORA da hierarquia, e por quê — Q4 */
  ignorados: {
    /** sem operação: a hierarquia começa na obra, então não entram em `operacoes[]` */
    semOperacao: number;
  };
};

/**
 * As disciplinas de VÁRIAS operações numa query só (nunca uma por obra: o
 * currículo de um RT antigo tem dezenas de obras, e um `getDisciplinasByOperacao`
 * por linha seria N+1).
 *
 * Sem filtro por `ativo`: disciplina desativada que a obra TEVE continua sendo
 * verdade sobre a obra — esconder falsearia o histórico (§4.3).
 */
async function disciplinasPorOperacao(operacaoIds: string[]): Promise<Map<string, DisciplinaDaOperacao[]>> {
  const mapa = new Map<string, DisciplinaDaOperacao[]>();
  if (operacaoIds.length === 0) return mapa;

  const rows = await db
    .select({
      operacaoId: operacaoDisciplinas.operacaoId,
      id:         disciplinas.id,
      codigo:     disciplinas.codigo,
      nome:       disciplinas.nome,
    })
    .from(operacaoDisciplinas)
    .innerJoin(disciplinas, eq(disciplinas.id, operacaoDisciplinas.disciplinaId))
    .where(inArray(operacaoDisciplinas.operacaoId, operacaoIds))
    .orderBy(asc(disciplinas.ordem), asc(disciplinas.codigo));

  for (const row of rows) {
    const { operacaoId, ...disciplina } = row;
    const lista = mapa.get(operacaoId) ?? [];
    lista.push(disciplina);
    mapa.set(operacaoId, lista);
  }
  return mapa;
}

/**
 * C1 — o currículo técnico do profissional. UMA função, dois consumidores: a
 * tela `/acervo/profissionais/[id]` e o relatório `curriculo-rt` (Q10.6 — um
 * só lugar decide o que é o currículo). `null` quando o id não existe.
 *
 * Regras fechadas (§4.5), todas visíveis no código abaixo:
 * - `restricaoVisivel(role)` filtra os documentos, e os `documentoIds` que vão
 *   para a agregação são os JÁ FILTRADOS — a soma nunca inclui documento que o
 *   papel não vê;
 * - documento sem operação NÃO entra na hierarquia (ela começa na obra) e é
 *   contado em `ignorados.semOperacao`: a perda é explicada, não some —
 *   `contagens.documentos + ignorados.semOperacao` é o total de documentos
 *   visíveis do RT.
 */
export async function curriculoDoProfissional(
  profissionalId: string,
  role: string,
): Promise<CurriculoRt | null> {
  const profissional = await getProfissionalRow(profissionalId);
  if (!profissional) return null;

  const documentos = await documentosDoProfissional(profissionalId, role);

  // A hierarquia começa na obra: documento sem operação fica de fora e é
  // contado. `operacaoId` e `operacaoCodigo` vêm do mesmo LEFT JOIN, então um
  // não existe sem o outro — a conferência dupla é só para o TypeScript.
  const daHierarquia = documentos.filter(
    (documento) => documento.operacaoId !== null && documento.operacaoCodigo !== null,
  );
  const semOperacao = documentos.length - daHierarquia.length;

  const documentoIds = daHierarquia.map((documento) => documento.documentoId);
  const operacaoIds = [...new Set(daHierarquia.map((documento) => documento.operacaoId!))];

  const [atividades, disciplinasDaObra] = await Promise.all([
    documentoIds.length === 0
      ? Promise.resolve([])
      : consultaAtividades()
          .where(inArray(documentoAtividades.documentoId, documentoIds))
          .orderBy(asc(documentoAtividades.ordem), asc(documentoAtividades.criadoEm), asc(documentoAtividades.id)),
    disciplinasPorOperacao(operacaoIds),
  ]);

  const atividadesPorDocumento = new Map<string, AtividadeDoDocumento[]>();
  for (const linha of atividades) {
    const lista = atividadesPorDocumento.get(linha.documentoId) ?? [];
    lista.push(montarAtividade(linha));
    atividadesPorDocumento.set(linha.documentoId, lista);
  }

  // Grupo por operação preservando a ORDEM em que os documentos vieram do
  // banco (período mais recente primeiro, papel do profissional, emissão):
  // o Map do JS mantém ordem de inserção, então a hierarquia sai ordenada sem
  // um segundo `sort` que pudesse discordar do SQL.
  const porOperacao = new Map<string, OperacaoDoCurriculo>();
  let totalAtividades = 0;

  for (const documento of daHierarquia) {
    const operacaoId = documento.operacaoId!;

    let operacao = porOperacao.get(operacaoId);
    if (!operacao) {
      operacao = {
        operacaoId,
        codigo:        documento.operacaoCodigo!,
        clienteNome:   documento.clienteNome ?? "",
        clienteGrupo:  documento.clienteGrupo,
        periodoInicio: documento.periodoInicio,
        periodoFim:    documento.periodoFim,
        disciplinasDaOperacao: disciplinasDaObra.get(operacaoId) ?? [],
        documentos: [],
      };
      porOperacao.set(operacaoId, operacao);
    }

    const atividadesDoDocumento = atividadesPorDocumento.get(documento.documentoId) ?? [];

    totalAtividades += atividadesDoDocumento.length;

    operacao.documentos.push({
      documentoId:       documento.documentoId,
      titulo:            documento.titulo,
      tipoDocumento:     documento.tipoDocumento,
      papelProfissional: documento.papelProfissional,
      numeroArt:         documento.numeroArt,
      emitidoEm:         documento.emitidoEm,
      disciplina:        documento.disciplina,
      atividades:        atividadesDoDocumento,
    });
  }

  const operacoesDoCurriculo = [...porOperacao.values()];

  return {
    geradoEm: new Date().toISOString(),
    profissional: {
      id:       profissional.id,
      nome:     profissional.nome,
      crea:     profissional.crea,
      creaUf:   profissional.creaUf,
      formacao: profissional.formacao,
      ativo:    profissional.ativo,
    },
    operacoes: operacoesDoCurriculo,
    contagens: {
      operacoes:  operacoesDoCurriculo.length,
      documentos: daHierarquia.length,
      atividades: totalAtividades,
    },
    ignorados: { semOperacao },
  };
}
