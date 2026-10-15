/**
 * Queries Reutilizáveis — Disciplinas do acervo (migration 0043)
 *
 * Regra da casa: handler não monta SQL. Tudo o que as rotas
 * /api/conformidade/disciplinas*, /api/conformidade/operacoes/[id]/disciplinas
 * e o card do painel leem do banco está aqui.
 *
 * As rotas desta pasta são WEB-ONLY (spec ONDA-4 §1i): não há espelho Python a
 * manter em paridade — o que muda aqui não quebra o BFF. A regra importada de
 * fora (`CONTA_NA_BARRA`) existe justamente para não haver segunda escrita da
 * mesma regra: a cobertura tem de contar atestado do mesmo jeito que a barra
 * da ficha.
 */

import { db } from "@/db";
import {
  disciplinas,
  documentosHabilitacao,
  operacaoDisciplinas,
  operacoes,
} from "@/db/schema";
import { and, asc, eq, gte, ilike, inArray, isNotNull, lte, or, sql, type SQL } from "drizzle-orm";
import { restricaoVisivel } from "@/lib/conformidade/cofre/queries";
import { CONTA_NA_BARRA } from "@/lib/conformidade/operacoes/queries";
import type { CoberturaQueryInput } from "./validations";

/** Escapa `\`, `%` e `_` para o termo do usuário valer literal num ILIKE. */
export function escaparLike(termo: string): string {
  return termo.replace(/[\\%_]/g, (c) => "\\" + c);
}

/**
 * A disciplina informada existe no catálogo? `null`/`undefined` = sem
 * disciplina, que é válido. A rota responde 422 quando devolve `false`.
 */
export async function conferirDisciplina(
  disciplinaId: string | null | undefined
): Promise<boolean> {
  if (disciplinaId === null || disciplinaId === undefined) return true;

  const [row] = await db
    .select({ id: disciplinas.id })
    .from(disciplinas)
    .where(eq(disciplinas.id, disciplinaId))
    .limit(1);
  return row !== undefined;
}

// ── 1. O catálogo ────────────────────────────────────────────────────────────

export type DisciplinaCatalogo = {
  id: string;
  codigo: string;
  nome: string;
  ordem: number;
  ativo: boolean;
};

/**
 * O catálogo, na ordem de exibição. `apenasAtivas` é o default da tela, ecoado
 * pela rota (`filtros.ativas`) — default é corte, e corte aparece (Q10.3).
 *
 * `ORDER BY ordem ASC, codigo ASC`: `ordem` é o que o dono escreveu no seed e
 * `codigo` desempata — duas disciplinas com a mesma `ordem` (o default 0 de
 * quem for acrescentada depois) sairiam em ordem imprevisível entre chamadas,
 * e o `<select>` mudaria de ordem sozinho.
 */
export async function listDisciplinas(apenasAtivas = true): Promise<DisciplinaCatalogo[]> {
  return db
    .select({
      id:     disciplinas.id,
      codigo: disciplinas.codigo,
      nome:   disciplinas.nome,
      ordem:  disciplinas.ordem,
      ativo:  disciplinas.ativo,
    })
    .from(disciplinas)
    .where(apenasAtivas ? eq(disciplinas.ativo, true) : undefined)
    .orderBy(asc(disciplinas.ordem), asc(disciplinas.codigo));
}

// ── 2. Disciplinas de UMA operação ───────────────────────────────────────────

/** O shape que R1, R3, a ficha e o chip usam. Sempre `[]`, nunca null. */
export type DisciplinaDaOperacao = { id: string; codigo: string; nome: string };

/**
 * As disciplinas declaradas pela obra, na mesma ordem do catálogo (a ordem dos
 * chips na ficha é contrato — e é a MESMA do `json_agg` de R1).
 *
 * SEM filtro por `ativo`: disciplina desativada que a obra teve continua sendo
 * verdade sobre a obra; escondê-la falsearia o histórico (é por isso que o
 * catálogo tem `ativo` em vez de DELETE).
 */
export async function getDisciplinasByOperacao(operacaoId: string): Promise<DisciplinaDaOperacao[]> {
  return db
    .select({
      id:     disciplinas.id,
      codigo: disciplinas.codigo,
      nome:   disciplinas.nome,
    })
    .from(operacaoDisciplinas)
    .innerJoin(disciplinas, eq(operacaoDisciplinas.disciplinaId, disciplinas.id))
    .where(eq(operacaoDisciplinas.operacaoId, operacaoId))
    .orderBy(asc(disciplinas.ordem), asc(disciplinas.codigo));
}

/**
 * Quais dos ids existem — a checagem que o PUT faz ANTES de escrever, para o
 * 422 sair no campo em vez de o Postgres devolver 23503/500 (spec §1a).
 * Devolve os ids ENCONTRADOS; a rota calcula a diferença.
 *
 * UMA query com `IN`, nunca N: a lista chega com até 20 ids e um `SELECT` por
 * id seria 20 idas ao banco para responder uma pergunta só. `ids` vazio nem vai
 * ao banco (e um `IN ()` seria SQL inválido).
 */
export async function disciplinasExistentes(ids: readonly string[]): Promise<string[]> {
  const unicos = [...new Set(ids)];
  if (unicos.length === 0) return [];

  const rows = await db
    .select({ id: disciplinas.id })
    .from(disciplinas)
    .where(inArray(disciplinas.id, unicos));
  return rows.map((r) => r.id);
}

/**
 * Regrava o conjunto INTEIRO de disciplinas da operação, em UMA transação
 * (delete + insert). Devolve `{ antes, depois }` com os CÓDIGOS ordenados — é
 * o que vai para o audit `DEFINIR_DISCIPLINAS_OPERACAO` (código, não uuid:
 * quem lê o audit precisa entender sem consultar catálogo).
 *
 * Deduplica `disciplinaIds` antes do INSERT (Set): duplicata no body é
 * descuido de cliente, não erro de dado — o PK composto recusaria a segunda
 * linha e derrubaria a transação inteira.
 *
 * O `depois` é RELIDO do banco, não montado a partir dos ids recebidos: o
 * audit registra o que ficou gravado, e reler é a única forma de isso ser
 * verdade (e de os códigos saírem na mesma ordem do `antes`).
 *
 * A ordem dos códigos é a do CATÁLOGO (`ordem`, depois `codigo`) — a mesma de
 * `listDisciplinas` e `getDisciplinasByOperacao`, e a mesma dos chips na tela.
 * É o exemplo literal do §8.17 (`["TUB","ELE"]`, que em ordem alfabética seria
 * `["ELE","TUB"]`): quem compara o audit com a ficha vê a MESMA sequência.
 *
 * ⚠️ `operacoes.atualizadoEm` NÃO é tocado (§5.2): disciplina não é coluna da
 * operação, e mexer no campo faria a ficha dizer que o cadastro mudou quando
 * não mudou.
 */
export async function setDisciplinasDaOperacao(
  operacaoId: string,
  disciplinaIds: readonly string[],
): Promise<{ antes: string[]; depois: string[] }> {
  const unicos = [...new Set(disciplinaIds)];

  return db.transaction(async (tx) => {
    const codigosDaOperacao = () =>
      tx
        .select({ codigo: disciplinas.codigo })
        .from(operacaoDisciplinas)
        .innerJoin(disciplinas, eq(operacaoDisciplinas.disciplinaId, disciplinas.id))
        .where(eq(operacaoDisciplinas.operacaoId, operacaoId))
        .orderBy(asc(disciplinas.ordem), asc(disciplinas.codigo));

    const antes = await codigosDaOperacao();

    await tx.delete(operacaoDisciplinas).where(eq(operacaoDisciplinas.operacaoId, operacaoId));

    if (unicos.length > 0) {
      await tx
        .insert(operacaoDisciplinas)
        .values(unicos.map((disciplinaId) => ({ operacaoId, disciplinaId })));
    }

    const depois = await codigosDaOperacao();

    return { antes: antes.map((r) => r.codigo), depois: depois.map((r) => r.codigo) };
  });
}

// ── 3. C3 — cobertura por disciplina ─────────────────────────────────────────

export type LinhaCoberturaDisciplina = {
  disciplinaId: string;
  codigo: string;
  nome: string;
  ordem: number;
  ativo: boolean;
  /** operações DISTINCT que declaram esta disciplina (dentro dos filtros) */
  operacoes: number;
  /** destas, quantas têm ao menos um atestado que CONTA na barra */
  comAtestado: number;
  /** documentos DISTINCT cuja `disciplina_id` é esta (visíveis para o papel) */
  documentos: number;
};

export type RespostaCobertura = {
  filtros: { cliente?: string; de?: string; ate?: string; incluirInativas: boolean };
  linhas: LinhaCoberturaDisciplina[];
  totais: {
    /** operações DISTINCT dentro dos filtros, com ou sem disciplina */
    operacoes: number;
    /** destas, quantas não têm NENHUMA linha em operacao_disciplinas */
    semDisciplina: number;
    /** operações fora da janela por não terem período informado (0 quando de/ate ausentes) */
    semPeriodo: number;
  };
};

/**
 * O predicado de ATESTADO da barra de comprovação, colado ao `CONTA_NA_BARRA`
 * importado de `operacoes/queries.ts`: é a MESMA regra do `totalAtestados` de
 * R1 (tipo 'ATESTADO', com o fallback por `papel` para os legados de
 * `tipo_documento` NULL). Duas escritas da mesma regra divergem, e aí a ficha e
 * a cobertura mostram números diferentes para a mesma obra (Q10.6).
 */
const ATESTADO_QUE_CONTA: SQL = sql`(${CONTA_NA_BARRA}
  AND (${documentosHabilitacao.tipoDocumento} = 'ATESTADO'
       OR (${documentosHabilitacao.tipoDocumento} IS NULL AND ${documentosHabilitacao.papel} = 'ATESTADO')))`;

/**
 * C3. Uma linha por disciplina do catálogo (inclusive as com zero operações —
 * "não temos nada provado em Telecom" é a resposta mais importante que esta
 * consulta dá, e ela sumiria com INNER JOIN).
 *
 * As três armadilhas, resolvidas aqui (spec §4.3):
 *
 * 1. `disciplinas` é a tabela BASE e os três JOINs são LEFT. INNER em qualquer
 *    um apagaria a linha "zero", que é o achado. Os filtros de cliente/janela
 *    vão no ON do JOIN de `operacoes` — no WHERE, um LEFT JOIN vira INNER na
 *    prática (linha NULL não satisfaz `ILIKE`) e a linha zero sumiria de novo.
 * 2. `count(DISTINCT …)` em tudo: o JOIN de documentos NÃO passa pela operação
 *    (o documento declara a própria disciplina), então cada operação aparece
 *    multiplicada pelos documentos daquela disciplina. Sem DISTINCT, uma obra
 *    com 3 atestados contaria 3 (Q10.5). Com DISTINCT, conta 1.
 * 3. Todo filtro é explícito e volta ecoado em `filtros` — `cliente` com
 *    `escaparLike` (um `%` cru vindo de URL compartilhável viraria filtro
 *    escondido), `de`/`ate` exigindo período informado, `incluirInativas`
 *    dizendo se as desativadas entraram.
 *
 * ⚠️ `documentos` NÃO é recortado por cliente/janela, e isso é deliberado: o
 * JOIN é por `disciplina_id`, não pela operação, então a coluna responde
 * "quantos documentos do acervo carregam esta disciplina" — inclusive os
 * órfãos, que não têm operação para filtrar. `operacoes` e `comAtestado` são as
 * colunas do recorte.
 *
 * `restricaoVisivel(role)` entra no ON dos documentos (não no WHERE, pelo mesmo
 * motivo do item 1): o guard da rota é `requireConformidade` e na prática o
 * predicado é `true`, mas a regra fica no MESMO lugar de todo o cofre em vez de
 * virar exceção (ADR-05, defesa em profundidade).
 */
export async function coberturaPorDisciplina(
  filtros: CoberturaQueryInput,
  role: string,
): Promise<RespostaCobertura> {
  // Cliente: nome OU grupo, ILIKE com o termo ESCAPADO (mesma função do Q5).
  const cliente: SQL[] = [];
  if (filtros.cliente) {
    const termo = `%${escaparLike(filtros.cliente)}%`;
    cliente.push(or(ilike(operacoes.clienteNome, termo), ilike(operacoes.clienteGrupo, termo))!);
  }

  // Janela sobre o PERÍODO DA OPERAÇÃO — só existe se `de` ou `ate` vieram, e
  // aí exige os dois limites informados: `periodo_fim >= de` com fim NULL não é
  // "não sei", é "fora" — e o que sai por isso é contado em `totais.semPeriodo`.
  const temJanela = filtros.de !== undefined || filtros.ate !== undefined;
  const janela: SQL[] = [];
  if (temJanela) {
    janela.push(isNotNull(operacoes.periodoInicio), isNotNull(operacoes.periodoFim));
    if (filtros.de)  janela.push(gte(operacoes.periodoFim, filtros.de));
    if (filtros.ate) janela.push(lte(operacoes.periodoInicio, filtros.ate));
  }
  // A mesma janela dentro dos FILTER dos totais; `true` quando não há janela,
  // para o fragmento existir sem mudar o resultado (molde do Q5, onda 2).
  const condJanela: SQL = janela.length > 0 ? and(...janela)! : sql`true`;

  const [linhas, [totais]] = await Promise.all([
    db
      .select({
        disciplinaId: disciplinas.id,
        codigo:       disciplinas.codigo,
        nome:         disciplinas.nome,
        ordem:        disciplinas.ordem,
        ativo:        disciplinas.ativo,
        // `::int` em toda contagem: `count` devolve bigint e o driver `pg`
        // entrega bigint como STRING — sem o cast, `operacoes` viraria "34".
        operacoes: sql<number>`count(DISTINCT ${operacoes.id})::int`.as("operacoes"),
        // O `documentos_habilitacao.operacao_id = operacoes.id` DENTRO do
        // FILTER é o que amarra o atestado à obra: sem ele, qualquer atestado
        // da disciplina (de outra obra) marcaria todas as obras da disciplina.
        comAtestado: sql<number>`
          count(DISTINCT ${operacoes.id}) FILTER (
            WHERE ${documentosHabilitacao.operacaoId} = ${operacoes.id} AND ${ATESTADO_QUE_CONTA}
          )::int
        `.as("com_atestado"),
        documentos: sql<number>`count(DISTINCT ${documentosHabilitacao.id})::int`.as("documentos"),
      })
      .from(disciplinas)
      .leftJoin(operacaoDisciplinas, eq(operacaoDisciplinas.disciplinaId, disciplinas.id))
      .leftJoin(
        operacoes,
        and(eq(operacoes.id, operacaoDisciplinas.operacaoId), ...cliente, ...janela)
      )
      .leftJoin(
        documentosHabilitacao,
        and(eq(documentosHabilitacao.disciplinaId, disciplinas.id), restricaoVisivel(role))
      )
      .where(filtros.incluirInativas ? undefined : eq(disciplinas.ativo, true))
      .groupBy(disciplinas.id, disciplinas.codigo, disciplinas.nome, disciplinas.ordem, disciplinas.ativo)
      .orderBy(asc(disciplinas.ordem), asc(disciplinas.codigo)),

    // Totais — SEGUNDA query, sobre `operacoes`, com o MESMO recorte de
    // cliente/janela. Sem eles a soma das colunas `operacoes` das disciplinas
    // não bate com o total de obras e ninguém explica a diferença (Q4).
    //
    // A janela vai nos FILTER e não no WHERE (molde do Q5, onda 2 §4a): no
    // WHERE ela excluiria as operações sem período, e aí `semPeriodo` seria
    // sempre 0 — que é exatamente o número que precisa aparecer.
    db
      .select({
        operacoes: sql<number>`count(*) FILTER (WHERE ${condJanela})::int`.as("operacoes"),
        semDisciplina: sql<number>`
          count(*) FILTER (WHERE ${condJanela} AND NOT EXISTS (
            SELECT 1 FROM ${operacaoDisciplinas} od WHERE od.operacao_id = ${operacoes.id}
          ))::int
        `.as("sem_disciplina"),
        // Só faz sentido com janela: sem ela, operação sem período ENTRA na
        // contagem normalmente e nada é ignorado por período (o corte só existe
        // quando é pedido).
        semPeriodo: temJanela
          ? sql<number>`
              count(*) FILTER (
                WHERE ${operacoes.periodoInicio} IS NULL OR ${operacoes.periodoFim} IS NULL
              )::int
            `.as("sem_periodo")
          : sql<number>`0`.as("sem_periodo"),
      })
      .from(operacoes)
      .where(cliente.length > 0 ? and(...cliente) : undefined),
  ]);

  // ECO dos filtros: só o que foi REALMENTE aplicado. `incluirInativas` sempre
  // aparece (é um corte com default), `cliente`/`de`/`ate` só quando vieram.
  const eco: RespostaCobertura["filtros"] = { incluirInativas: filtros.incluirInativas };
  if (filtros.cliente) eco.cliente = filtros.cliente;
  if (filtros.de)      eco.de      = filtros.de;
  if (filtros.ate)     eco.ate     = filtros.ate;

  return {
    filtros: eco,
    linhas,
    totais: {
      operacoes:     totais?.operacoes     ?? 0,
      semDisciplina: totais?.semDisciplina ?? 0,
      semPeriodo:    totais?.semPeriodo    ?? 0,
    },
  };
}
