/**
 * Queries Reutilizáveis — Cofre por operação (migration 0033)
 *
 * Regra da casa: handler não monta SQL. Tudo o que as rotas
 * /api/conformidade/operacoes* leem do banco está aqui, e o espelho do BFF
 * replica ESTAS consultas (mesmas condições, mesma ordenação, mesmo shape).
 */

import { db } from "@/db";
import {
  operacoes,
  documentosHabilitacao,
  documentosFamilias,
  disciplinas,
  familias,
  type Operacao,
} from "@/db/schema";
import { and, asc, count, eq, gt, ilike, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { PAPEIS_DOCUMENTO } from "@/lib/conformidade/operacoes";
import { restricaoVisivel } from "@/lib/conformidade/cofre/queries";
// O shape de disciplina que R1, R3, a ficha e o chip compartilham mora no
// módulo de disciplinas (0043) — aqui só se consome, para não existir uma
// segunda declaração do mesmo objeto.
import type { DisciplinaDaOperacao } from "@/lib/conformidade/disciplinas/queries";
import type { FiltrosOperacaoInput } from "./validations";

// ── Regra da barra de comprovação (00-ARQUITETURA §1.2) ─────────────────────

/**
 * `conta_na_barra`: NULL conta (legado/não avaliada); RASCUNHO, SUPERADA,
 * CANCELADA e MODELO não contam. O fallback por `papel` (tipo NULL) cobre os
 * legados pós-backfill — sem ele a barra da onda O1 nasceria zerada.
 * SQL literal espelhado no BFF (conf_operacoes.py) — mudar aqui exige mudar lá.
 *
 * 0043: exportada porque a cobertura por disciplina (C3,
 * `disciplinas/queries.ts`) conta atestados com ESTA regra. Duas escritas da
 * mesma regra divergem, e aí a ficha e a cobertura mostram números diferentes
 * para a mesma obra (spec ONDA-4 §4.3).
 */
export const CONTA_NA_BARRA = sql`(${documentosHabilitacao.situacaoProva} IS NULL
  OR ${documentosHabilitacao.situacaoProva} IN ('ASSINADA_PROPONENTE','ASSINADA_CLIENTE','INDEFINIDA'))`;

// ── Contagem de provas por operação ──────────────────────────────────────────

/**
 * Subconsulta agregada: uma linha por operação com quantas provas ela tem.
 *
 * É `GROUP BY` no banco, não `filter()` em JS: a lista precisa de
 * totalDocumentos/totalAtestados de TODAS as operações da página, e trazer os
 * documentos para contar no app seria um N+1 (ou um `SELECT *` do cofre inteiro).
 *
 * `count(*)::int` e não `count(*)`: `count` devolve bigint e o driver `pg`
 * entrega bigint como STRING — sem o cast, `totalDocumentos` viraria "3".
 *
 * 0034 (R1): 4 agregados com a regra da barra — `totalAtestados` MUDA de
 * semântica (excluía nada; passa a excluir RASCUNHO/SUPERADA/CANCELADA/MODELO)
 * e nascem `totalArtCat`/`totalContratos`. Sem predicado restrito aqui: com o
 * guard P10 só Conformidade chega em R1, e Conformidade vê tudo (§3.2).
 */
function contagensPorOperacao() {
  return db
    .select({
      operacaoId: documentosHabilitacao.operacaoId,
      totalDocumentos: sql<number>`count(*)::int`.as("total_documentos"),
      totalAtestados: sql<number>`
        count(*) FILTER (WHERE ${CONTA_NA_BARRA}
          AND (${documentosHabilitacao.tipoDocumento} = 'ATESTADO'
               OR (${documentosHabilitacao.tipoDocumento} IS NULL AND ${documentosHabilitacao.papel} = 'ATESTADO')))::int
      `.as("total_atestados"),
      totalArtCat: sql<number>`
        count(*) FILTER (WHERE ${CONTA_NA_BARRA}
          AND (${documentosHabilitacao.tipoDocumento} IN ('ART','CAT')
               OR (${documentosHabilitacao.tipoDocumento} IS NULL AND ${documentosHabilitacao.papel} = 'CAT_ART')))::int
      `.as("total_art_cat"),
      totalContratos: sql<number>`
        count(*) FILTER (WHERE ${CONTA_NA_BARRA}
          AND (${documentosHabilitacao.tipoDocumento} IN ('CONTRATO','ADITIVO','ANEXO_CONTRATO')
               OR (${documentosHabilitacao.tipoDocumento} IS NULL AND ${documentosHabilitacao.papel} IN ('CONTRATO','ADITIVO'))))::int
      `.as("total_contratos"),
    })
    .from(documentosHabilitacao)
    .where(isNotNull(documentosHabilitacao.operacaoId))
    .groupBy(documentosHabilitacao.operacaoId)
    .as("contagens");
}

// ── Listagem com filtros ─────────────────────────────────────────────────────

/**
 * Lista operações do catálogo + as cadastradas à mão.
 *
 * 0044 (D11): o recorte por `ativo` e a janela de período são EXPLÍCITOS e
 * ecoados. Nenhum deles tem default que corte: sem parâmetro, a lista traz o
 * MESMO conjunto de hoje (ativas e inativas, sem janela). É o oposto de uma
 * data de corte literal embutida nas consultas, em que dois usuários veem
 * somas diferentes sem saber por quê.
 *
 * `comProva` vira um predicado sobre a subconsulta (o LEFT JOIN passa a se
 * comportar como INNER): é exatamente o "só as que têm documento" da tela do
 * cofre, enquanto a busca continua enxergando todas.
 *
 * Ordem fixa por `codigo` — é a ordem da Relação de Operações e a única estável
 * (nome de cliente repete, data pode ser nula no catálogo).
 */
export async function listOperacoes(filtros: FiltrosOperacaoInput) {
  const contagens = contagensPorOperacao();

  const conditions: SQL[] = [];

  if (filtros.busca) {
    const termo = `%${filtros.busca}%`;
    conditions.push(
      or(
        ilike(operacoes.codigo, termo),
        ilike(operacoes.clienteNome, termo),
        ilike(operacoes.contratoNumero, termo)
      )!
    );
  }

  if (filtros.detentora) {
    conditions.push(eq(operacoes.detentora, filtros.detentora));
  }

  if (filtros.comProva) {
    conditions.push(gt(contagens.totalDocumentos, 0));
  }

  // D11: recorte explícito. `undefined` não empilha condição nenhuma — o
  // conjunto de hoje continua sendo o default.
  if (filtros.ativo !== undefined) {
    conditions.push(eq(operacoes.ativo, filtros.ativo));
  }

  // Fotografia do recorte ANTES da janela: é sobre ela que `semPeriodo` conta
  // (mesma busca, mesma detentora, mesmo `comProva`, mesmo `ativo` — só sem o
  // período), senão o número que "explica a diferença" seria de outro conjunto.
  const condicoesSemJanela = [...conditions];

  // Janela: a obra tem de ter os DOIS extremos para ser comparável; obra sem
  // período fica FORA e é CONTADA à parte (`semPeriodo`), nunca some calada.
  if (filtros.de) {
    conditions.push(sql`${operacoes.periodoFim} IS NOT NULL AND ${operacoes.periodoFim} >= ${filtros.de}`);
  }
  if (filtros.ate) {
    conditions.push(sql`${operacoes.periodoInicio} IS NOT NULL AND ${operacoes.periodoInicio} <= ${filtros.ate}`);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // Sem `de`/`ate`, NENHUMA query extra roda e o número é 0 literal (§4.7).
  const temJanela = Boolean(filtros.de) || Boolean(filtros.ate);
  const semPeriodoQuery = temJanela
    ? db
        .select({ total: sql<number>`count(*)::int` })
        .from(operacoes)
        .leftJoin(contagens, eq(contagens.operacaoId, operacoes.id))
        .where(
          and(
            ...condicoesSemJanela,
            sql`(${operacoes.periodoInicio} IS NULL OR ${operacoes.periodoFim} IS NULL)`
          )
        )
    : null;

  const [rows, [totalRow], semPeriodoRows] = await Promise.all([
    db
      .select({
        id:              operacoes.id,
        codigo:          operacoes.codigo,
        clienteNome:     operacoes.clienteNome,
        clienteGrupo:    operacoes.clienteGrupo,
        contratoNumero:  operacoes.contratoNumero,
        unidade:         operacoes.unidade,
        area:            operacoes.area,      // 0044 (B5)
        detentora:       operacoes.detentora,
        periodoInicio:   operacoes.periodoInicio,
        periodoFim:      operacoes.periodoFim,
        valor:           operacoes.valor,
        escopo:          operacoes.escopo,
        // COALESCE porque o LEFT JOIN devolve NULL para operação sem prova
        // nenhuma — a tela espera 0, não null. O `.as()` é só para a coluna de
        // saída ter nome no SQL (o Drizzle mapeia por posição, mas sem ele as
        // duas sairiam como "coalesce" e o SQL fica ilegível no log/EXPLAIN).
        totalDocumentos: sql<number>`coalesce(${contagens.totalDocumentos}, 0)`.as("total_documentos"),
        totalAtestados:  sql<number>`coalesce(${contagens.totalAtestados}, 0)`.as("total_atestados"),
        totalArtCat:     sql<number>`coalesce(${contagens.totalArtCat}, 0)`.as("total_art_cat"),
        totalContratos:  sql<number>`coalesce(${contagens.totalContratos}, 0)`.as("total_contratos"),
        // 0043 — Disciplinas da operação. Subconsulta CORRELACIONADA, não JOIN:
        // um `leftJoin(operacaoDisciplinas)` no SELECT principal multiplicaria
        // as linhas e, com elas, os quatro agregados de `contagens` (Q10.5).
        // `coalesce(..., '[]')` porque operação sem disciplina tem de sair com
        // array vazio, nunca null — o cliente não distingue "não tem" de "não
        // veio". A `ORDER BY` vai DENTRO do `json_agg`: fora dele o Postgres
        // não a aplica ao array e a ordem dos chips mudaria entre chamadas (e
        // entre Next e BFF). Espelho obrigatório em conf_operacoes.py.
        disciplinas: sql<DisciplinaDaOperacao[]>`(
          SELECT coalesce(json_agg(json_build_object('id', d.id, 'codigo', d.codigo, 'nome', d.nome)
                                   ORDER BY d.ordem, d.codigo), '[]'::json)
            FROM operacao_disciplinas od
            JOIN disciplinas d ON d.id = od.disciplina_id
           WHERE od.operacao_id = ${operacoes.id}
        )`.as("disciplinas"),
      })
      .from(operacoes)
      .leftJoin(contagens, eq(contagens.operacaoId, operacoes.id))
      .where(where)
      .orderBy(asc(operacoes.codigo))
      .limit(filtros.limit)
      .offset(filtros.offset),

    db
      .select({ total: count() })
      .from(operacoes)
      .leftJoin(contagens, eq(contagens.operacaoId, operacoes.id))
      .where(where),

    semPeriodoQuery ?? Promise.resolve([] as Array<{ total: number }>),
  ]);

  // ECO do recorte: só o que foi APLICADO (chave ausente = filtro ausente), na
  // ordem do contrato. É o que deixa a tela escrever a frase do cabeçalho sem
  // adivinhar, e o que impede um corte de existir sem estar escrito.
  const filtrosAplicados: FiltrosOperacaoInput = {
    ...(filtros.busca ? { busca: filtros.busca } : {}),
    ...(filtros.detentora ? { detentora: filtros.detentora } : {}),
    comProva: filtros.comProva,
    ...(filtros.ativo !== undefined ? { ativo: filtros.ativo } : {}),
    ...(filtros.de ? { de: filtros.de } : {}),
    ...(filtros.ate ? { ate: filtros.ate } : {}),
    limit: filtros.limit,
    offset: filtros.offset,
  };

  return {
    operacoes: rows,
    total: totalRow?.total ?? 0,
    filtros: filtrosAplicados,
    // Quantas obras ficaram fora da janela por não terem período informado.
    // Sem esse número a soma não fecha com o total de obras e ninguém explica
    // a diferença (Q4 aplicado ao índice).
    semPeriodo: semPeriodoRows[0]?.total ?? 0,
  };
}

// ── Buscar por ID / por código ───────────────────────────────────────────────

export async function getOperacaoById(id: string): Promise<Operacao | null> {
  const [row] = await db
    .select()
    .from(operacoes)
    .where(eq(operacoes.id, id))
    .limit(1);
  return row ?? null;
}

/** Unicidade do cadastro manual: `codigo` é a chave de negócio (UNIQUE no banco). */
export async function getOperacaoByCodigo(codigo: string): Promise<Operacao | null> {
  const [row] = await db
    .select()
    .from(operacoes)
    .where(eq(operacoes.codigo, codigo))
    .limit(1);
  return row ?? null;
}

// ── Provas de uma operação (dossiê) ──────────────────────────────────────────

/**
 * Ordem de exibição do papel — a MESMA da tupla `PAPEIS_DOCUMENTO`: o atestado
 * primeiro porque é a prova que habilita, o resto é lastro. Papel NULL
 * (documentos legados antes do backfill) e valor desconhecido caem no fim (99).
 * Gerado da tupla para não existir uma segunda lista de papéis fora do domínio.
 */
const ORDEM_PAPEL = sql`CASE ${documentosHabilitacao.papel} ${sql.join(
  PAPEIS_DOCUMENTO.map((papel, i) => sql`WHEN ${papel} THEN ${sql.raw(String(i))}`),
  sql` `
)} ELSE 99 END`;

/**
 * Provas guardadas da operação, na ordem do dossiê: papel, depois mais antiga
 * primeiro. `id` no fim como desempate — sem ele duas provas criadas no mesmo
 * milissegundo sairiam em ordem imprevisível e a paridade com o BFF quebraria.
 *
 * 0034 (R3/B4): ganha as colunas do dossiê, o chip de famílias e o parâmetro
 * `role` — documento `restrito=true` é FILTRADO da lista para papel fora de
 * Conformidade (predicado único de cofre/queries.ts). As famílias saem numa
 * SEGUNDA query, uma só para todos os documentos (nada de N+1), agregadas por
 * documento; a ordenação `codigo ASC, id ASC` é parte do contrato de paridade.
 */
export async function getDocumentosByOperacao(operacaoId: string, role: string) {
  const rows = await db
    .select({
      id:              documentosHabilitacao.id,
      titulo:          documentosHabilitacao.titulo,
      papel:           documentosHabilitacao.papel,
      subcategoria:    documentosHabilitacao.subcategoria,
      nomeArquivo:     documentosHabilitacao.nomeArquivo,
      tamanhoBytes:    documentosHabilitacao.tamanhoBytes,
      contentType:     documentosHabilitacao.contentType,
      versao:          documentosHabilitacao.versao,
      revisao:         documentosHabilitacao.revisao,   // 0044 (B6)
      criadoEm:        documentosHabilitacao.criadoEm,
      // 0034 — colunas do dossiê (B4).
      emitidoEm:       documentosHabilitacao.emitidoEm,
      numeroDocumento: documentosHabilitacao.numeroDocumento,
      validadeFim:     documentosHabilitacao.validadeFim,
      status:          documentosHabilitacao.status,
      tipoDocumento:   documentosHabilitacao.tipoDocumento,
      situacaoProva:   documentosHabilitacao.situacaoProva,
      detentora:       documentosHabilitacao.detentora,
      sha256:          documentosHabilitacao.sha256,
      restrito:        documentosHabilitacao.restrito,
      origemPath:      documentosHabilitacao.origemPath,
      // 0043 — a disciplina que ESTE documento prova. Achatada no SELECT e
      // aninhada no map final, o mesmo desmonte que `operacao` em
      // `listDocumentos` e que `familias` aqui embaixo. LEFT: documento sem
      // disciplina é a maioria e não pode sumir da ficha.
      disciplinaId:     documentosHabilitacao.disciplinaId,
      disciplinaCodigo: disciplinas.codigo,
      disciplinaNome:   disciplinas.nome,
    })
    .from(documentosHabilitacao)
    .leftJoin(disciplinas, eq(documentosHabilitacao.disciplinaId, disciplinas.id))
    .where(and(eq(documentosHabilitacao.operacaoId, operacaoId), restricaoVisivel(role)))
    .orderBy(ORDEM_PAPEL, asc(documentosHabilitacao.criadoEm), asc(documentosHabilitacao.id));

  if (rows.length === 0) return [];

  // Chip de família da ficha: `codigo` no JSON é o codigo_crc da família (o
  // nome de exibição consagrado no módulo) — a chave da resposta é contrato.
  const vinculos = await db
    .select({
      documentoId: documentosFamilias.documentoId,
      id:          familias.id,
      codigo:      familias.codigoCrc,
    })
    .from(documentosFamilias)
    .innerJoin(familias, eq(documentosFamilias.familiaId, familias.id))
    .where(inArray(documentosFamilias.documentoId, rows.map((r) => r.id)))
    .orderBy(asc(familias.codigoCrc), asc(familias.id));

  const familiasPorDocumento = new Map<string, Array<{ id: string; codigo: string }>>();
  for (const v of vinculos) {
    const lista = familiasPorDocumento.get(v.documentoId) ?? [];
    lista.push({ id: v.id, codigo: v.codigo });
    familiasPorDocumento.set(v.documentoId, lista);
  }

  // Documento sem família → `[]` (nunca omitido) — mesmo contrato do BFF.
  // Documento sem disciplina → `disciplina: null`, não um objeto de campos
  // nulos (o mesmo contrato de `operacao` em `listDocumentos`); `disciplinaId`
  // continua no topo do item, que é por onde o PATCH e o filtro trabalham.
  return rows.map((row) => {
    const { disciplinaCodigo, disciplinaNome, ...documento } = row;
    return {
      ...documento,
      familias: familiasPorDocumento.get(row.id) ?? [],
      disciplina:
        documento.disciplinaId !== null && disciplinaCodigo !== null && disciplinaNome !== null
          ? { id: documento.disciplinaId, codigo: disciplinaCodigo, nome: disciplinaNome }
          : null,
    };
  });
}
