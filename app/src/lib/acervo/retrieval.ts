/**
 * Retrieval semântico sobre acervo_chunks (pgvector).
 *
 * Fluxo do RAG:
 *   1. /api/acervo/buscar gera o embedding da pergunta (embeddings.ts).
 *   2. buscarChunksSimilares() faz o k-NN por distância de cosseno (<=>) no
 *      Postgres, aplicando filtros de metadata (origemTipo, licitacaoId) e o
 *      corte de similaridade mínima (config.acervo.similaridadeMinima).
 *   3. A rota monta o contexto e pede ao Claude responder COM CITAÇÃO da origem.
 *
 * Similaridade de cosseno = 1 - (embedding <=> query). O operador `<=>` exige a
 * extensão pgvector (criada na migration 0013 pela lane-schema). O índice HNSW
 * (idx_acervo_embedding) acelera o ORDER BY; sem ele, o Postgres faz scan
 * sequencial — correto, só mais lento.
 *
 * Anti-IDOR: o retrieval só roda para usuários internos (gate requireAcervo na
 * rota). Hoje não há ACL por documento, então a superfície segura é "tudo do
 * tenant interno"; quando houver ACL fina, filtra-se aqui por origem permitida
 * (e a rota aplica assertAcessoObjeto por linha).
 */

import { db } from "@/db";
import { sql } from "drizzle-orm";
import { config } from "@/lib/config";
import { isConformidade } from "@/lib/permissions";
import type { OrigemAcervo } from "@/db/schema";

export interface ChunkRecuperado {
  id: string;
  origemTipo: OrigemAcervo;
  origemId: string;
  licitacaoId: string | null;
  chunkIndex: number;
  texto: string;
  metadata: Record<string, unknown> | null;
  /** Similaridade de cosseno 0..1 (1 = idêntico). Continua exposta porque a
   *  tela a exibe, mas NÃO é mais o critério de ordenação — quem ordena é o RRF. */
  similaridade: number;
  /** Score da fusão (soma dos recíprocos de posição). Critério de ordem. */
  rrf: number;
  /** Posição na lista vetorial (null = não veio pelo vetor). */
  posVetor: number | null;
  /** Posição na lista textual (null = não veio pelo texto). Permite à tela
   *  dizer "achado pelo texto" e é o que isenta o resultado do piso de
   *  similaridade. */
  posTexto: number | null;
  /** Identidade do arquivo de origem — o que a pessoa reconhece e clica. */
  arquivo?: ArquivoOrigem;
}

export interface FiltroRetrieval {
  /** Restringe a um ou mais tipos de origem. */
  origemTipo?: OrigemAcervo[];
  /** Restringe a uma licitação específica. */
  licitacaoId?: string;
  /** Sobrescreve o top-K default (config.acervo.topK). */
  topK?: number;
  /** Texto da pergunta — alimenta o lado TEXTUAL da busca híbrida. Sem ele a
   *  busca degrada para k-NN puro (hit@10 medido: 85% → 30%). */
  pergunta?: string;
  /** Empresa detentora da operação (PROPONENTE | COLIGADA | PARCEIRO). */
  detentora?: string[];
  /** Tipos de documento (ATESTADO, CAT, ART, CONTRATO…). */
  tipoDocumento?: string[];
  /** Só operações encerradas (ou documentos emitidos) a partir deste ano. */
  desde?: number;
  /** Sobrescreve a similaridade mínima default (config.acervo.similaridadeMinima). */
  similaridadeMinima?: number;
}

/**
 * Neutraliza a SINTAXE de operador do `websearch_to_tsquery` sem tocar no
 * CONTEÚDO da pergunta.
 *
 * MEDIDO no parser do PostgreSQL 16.14 (2026-08-29):
 *
 *   " - REFX"  → !'refx'   o "-" vira NOT quando NÃO está colado a um
 *                            alfanumérico à esquerda (espaço, início, "(", tab)
 *   '"'         → <-> (frase); aspa ÍMPAR faz frase até o fim da string
 *   "or"/"OR"   → | (OR), quando token solto entre operandos
 *   & | ! < > ( ) :* e "and" NÃO são operadores aqui — viram pontuação
 *
 * O caso real: "Refinaria Exemplo Norte - REFX - Município … - SP" virava
 * `… & !'refx' & !'municipi' & … & !'sp' & …` — o braço estrito EXCLUÍA os três
 * termos que identificam a refinaria e devolvia 0 chunks. Texto colado de edital
 * é o uso normal desta busca, então isto não era caso de borda.
 *
 * TRÊS CUIDADOS QUE CUSTARAM MEDIÇÃO:
 *
 * 1. As classes são UNICODE, não ASCII. O `f_unaccent` roda DENTRO do SQL,
 *    DEPOIS desta função, e converte 15 codepoints de travessão para "-" e 9 de
 *    aspa para '"'. Tratar só o ASCII não conserta texto vindo de Word ou PDF —
 *    e o conjunto de perguntas de referência traz U+2014 na maioria das
 *    perguntas de identificador.
 *
 * 2. A ordem é ASPAS → OR → HÍFEN. Remover o "or" DEPOIS do hífen CRIA negação
 *    que não existia: "alfa or-beta" (que o parser lê como frase) viraria
 *    "alfa -beta" = `'alfa' & !'bet'`.
 *
 * 3. O "-" COLADO à esquerda é INTOCÁVEL. "contrato PJ-1234567" indexa como
 *    'contrat' + 'pj' + '-1234567' — o hífen fica DENTRO do lexema. Trocá-lo por
 *    espaço geraria '1234567', que não casa com o '-1234567' do índice, e mataria
 *    o caso "identificador". Idem U-32, P-87, Macaé-RJ, 11.222.333/0001-81.
 *
 * Sem lookbehind de propósito: `app/tsconfig.json` tem target ES2017 e lookbehind
 * é ES2018. A forma com grupo de captura é equivalente.
 *
 * Espelho exato de `_sanitizar_websearch` em
 * bff/app/routers/migrated/acervo_buscar.py — 0 divergências em 55 casos de
 * borda, U+FEFF incluído.
 */
const RE_ASPAS = /["ʺ“”‟″〝〞＂]/g;
const RE_OR_OPERADOR = /(^|[\s(])[oO][rR](?=[\s)]|$)/g;
const RE_HIFEN_OPERADOR =
  /(^|[^0-9A-Za-zÀ-ÖØ-öø-ÿ])[-­˗‐-―−︱︲﹘﹣－]+/g;
const RE_ESPACOS = /[\s﻿]+/g;
/** Brancos que `String.prototype.trim` já cobre, mais o BOM. */
const RE_BRANCOS_BORDA = /^[\s﻿ ]+|[\s﻿ ]+$/g;

export function sanitizarWebsearch(pergunta: string): string {
  return (pergunta ?? "")
    .replace(RE_ASPAS, " ")
    .replace(RE_OR_OPERADOR, "$1 ")
    .replace(RE_HIFEN_OPERADOR, "$1 ")
    .replace(RE_ESPACOS, " ")
    .replace(RE_BRANCOS_BORDA, "");
}

/**
 * Serializa um vetor TS para o literal textual aceito pelo pgvector ("[a,b,c]").
 * Sanitiza para conter apenas números finitos — defesa contra injeção via
 * sql.raw (os valores vêm do provider de embeddings, mas validamos mesmo assim).
 */
function vetorParaLiteral(vetor: number[]): string {
  const nums = vetor.map((v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) {
      throw new Error("Embedding contém valor não-numérico");
    }
    return n;
  });
  return `[${nums.join(",")}]`;
}

/**
 * Identidade do arquivo por tras do trecho: o que exibir e para onde levar.
 *
 * `href` aponta para a PAGINA do documento, nao para o download direto: a pagina
 * mostra situacao da prova, operacao vinculada e familias, que e o contexto que
 * decide se aquela prova serve. O download fica a um clique de la.
 */
export interface ArquivoOrigem {
  nome: string;
  tipo: string | null;
  /** Nº do documento (CAT, atestado) — o que o cliente cita em edital. */
  numero: string | null;
  emitidoEm: string | null;
  situacao: string | null;
  /** PROPONENTE | COLIGADA | PARCEIRO — de `operacoes`, que é a fonte com CHECK. */
  detentora: string | null;
  operacao: string | null;
  contrato: string | null;
  cliente: string | null;
  clienteGrupo: string | null;
  unidade: string | null;
  /** O QUE foi executado. É isto que decide se a prova serve à família. */
  escopo: string | null;
  /** "2018–2021" — janela da operação, já formatada. */
  periodo: string | null;
  href: string | null;
  download: string | null;
}

/** Ano de uma data que chega como Date (driver) ou string ISO. */
function ano(v: Date | string | null): string | null {
  if (!v) return null;
  const s = v instanceof Date ? v.toISOString() : String(v);
  const m = /^(\d{4})/.exec(s);
  return m ? m[1] : null;
}

/** "2018–2021" · "2018–" · "–2021" · null. Sem inventar quando falta ponta. */
function periodo(ini: Date | string | null, fim: Date | string | null): string | null {
  const a = ano(ini), b = ano(fim);
  if (!a && !b) return null;
  if (a && b) return a === b ? a : `${a}–${b}`;
  return a ? `${a}–` : `–${b}`;
}

function identidade(row: {
  origemTipo: OrigemAcervo; origemId: string; licitacaoId: string | null;
  docTitulo: string | null; docArquivo: string | null; docTipo: string | null;
  docSituacao: string | null; docDetentora: string | null;
  docNumero: string | null; docEmitidoEm: Date | string | null;
  opCodigo: string | null; opCliente: string | null; anexoDescricao: string | null;
  opDetentora: string | null; opClienteGrupo: string | null;
  opContrato: string | null; opUnidade: string | null; opEscopo: string | null;
  opInicio: Date | string | null; opFim: Date | string | null;
  metadata: Record<string, unknown> | null;
}): ArquivoOrigem {
  const doMeta = typeof row.metadata?.titulo === "string" ? row.metadata.titulo : null;
  if (row.origemTipo === "DOC_HABILITACAO") {
    return {
      nome: row.docTitulo || row.docArquivo || doMeta || "documento sem título",
      tipo: row.docTipo,
      numero: row.docNumero,
      emitidoEm: ano(row.docEmitidoEm),
      situacao: row.docSituacao,
      // `operacoes.detentora` é NOT NULL com CHECK; `documentos.detentora` é
      // livre e às vezes vem vazia. A da operação manda quando existe.
      detentora: row.opDetentora || row.docDetentora,
      operacao: row.opCodigo,
      contrato: row.opContrato,
      cliente: row.opCliente,
      clienteGrupo: row.opClienteGrupo,
      unidade: row.opUnidade,
      escopo: row.opEscopo,
      periodo: periodo(row.opInicio, row.opFim),
      href: `/acervo/cofre/${row.origemId}`,
      download: `/api/conformidade/cofre/documentos/${row.origemId}/download`,
    };
  }
  if (row.origemTipo === "ANEXO_EDITAL") {
    return {
      nome: row.anexoDescricao || doMeta || "anexo de edital",
      tipo: "ANEXO_EDITAL", numero: null, emitidoEm: null, situacao: null,
      detentora: null, operacao: null, contrato: null, cliente: null,
      clienteGrupo: null, unidade: null, escopo: null, periodo: null,
      href: row.licitacaoId ? `/licitacoes/${row.licitacaoId}` : null,
      download: null,
    };
  }
  return {
    nome: doMeta || "origem não identificada",
    tipo: row.origemTipo, numero: null, emitidoEm: null, situacao: null,
    detentora: null, operacao: null, contrato: null, cliente: null,
    clienteGrupo: null, unidade: null, escopo: null, periodo: null,
    href: null, download: null,
  };
}

/** RRF: score = Σ 1/(K + posição). K amortece o topo (Cormack et al.). */
const RRF_K = 60;

/**
 * Busca HÍBRIDA em acervo_chunks: vetor + texto (estrito e amplo), fundidos por
 * Reciprocal Rank Fusion, com dedup de trecho repetido.
 *
 * Espelho de `_buscar_chunks_similares` em acervo_buscar.py — a rota /api/acervo
 * é servida pelo BFF, mas a paridade é contrato do projeto.
 *
 * MEDIDO contra um conjunto de referência (40 perguntas, 3 tipos):
 *
 *              hit@10   MRR      hit@10 por tipo (sem/ident/fato)
 *   k-NN puro    30%   0,242      35% / 17% / 38%
 *   híbrido      85%   0,636      90% / 83% / 75%
 *
 * As três listas existem porque nenhuma sozinha serve às três perguntas:
 * o vetor reconhece assunto mas não ordena (a amplitude de similaridade entre a
 * 1ª e a 20ª posição é 0,03–0,07); o texto ESTRITO (AND) acerta identificador e
 * falha em linguagem natural; o texto AMPLO (OR) faz o inverso. Ver os
 * comentários do acervo_buscar.py para os números de cada combinação isolada.
 *
 * `role` (0034/S16): papel do usuário para o predicado restrito no cruzamento
 * com documentos_habilitacao. O default `""` (nenhum papel) é deliberadamente
 * o ramo RESTRITIVO — quem não informa papel não vê restrito.
 */
export async function buscarChunksSimilares(
  embedding: number[],
  filtro: FiltroRetrieval = {},
  role: string = "",
): Promise<ChunkRecuperado[]> {
  const topK = Math.max(1, Math.min(50, filtro.topK ?? config.acervo.topK));
  // Candidatos por braço antes da fusão.
  //
  // ⚠️ ERA 60 FIXO, E O TETO NUNCA VALIA (medido 2026-08-29). Quem serve o
  // braço vetorial é um índice HNSW, e o pgvector limita as linhas devolvidas a
  // `hnsw.ef_search` — default 40. Pedindo LIMIT 60 o índice entregava ~44;
  // pedindo LIMIT 200, as MESMAS ~44. Subir esta constante sem subir o
  // ef_search não muda absolutamente nada.
  const candidatos = Math.max(1, Math.min(500, Math.trunc(config.acervo.candidatos) || 120));
  // ef_search >= candidatos, sempre. Ponta a ponta, contra as 40 perguntas do
  // conjunto de referência:
  //   ef=40  cand=60   hit@5 75%  hit@10 85%  MRR 0,636  mediana 446 ms
  //   ef=400 cand=120  hit@5 85%  hit@10 90%  MRR 0,745  mediana 474 ms
  // Clampeado a [candidatos, 1000]: 1000 é o teto do pgvector, e o piso
  // garante que o braço vetorial nunca trunque abaixo do que foi pedido.
  const efSearch = Math.max(candidatos,
    Math.min(1000, Math.trunc(config.acervo.efSearch) || 400));
  const orcamentoAmpla = Math.max(1, Math.trunc(config.acervo.orcamentoAmpla) || 12_000);
  const simMin =
    filtro.similaridadeMinima ?? config.acervo.similaridadeMinima;
  // Só o lado TEXTUAL é sanitizado. O embedding vem da pergunta CRUA, gerado
  // na rota antes desta chamada — sanitizar o texto que vai ao modelo mudaria
  // a semântica sem necessidade.
  const pergunta = sanitizarWebsearch(filtro.pergunta ?? "");

  // Literal do vetor — apenas números (validados em vetorParaLiteral).
  const literal = vetorParaLiteral(embedding);

  // Condições de filtro. licitacaoId entra como bind param (seguro). origemTipo
  // é restrito ao enum OrigemAcervo (validado na rota), então montamos um
  // ARRAY[...] via sql.raw com escape de aspas — mesmo padrão de queries.ts.
  const conds = [sql`c.embedding IS NOT NULL`];

  if (filtro.origemTipo && filtro.origemTipo.length > 0) {
    const arr = filtro.origemTipo
      .map((t) => `'${String(t).replace(/'/g, "''")}'`)
      .join(",");
    conds.push(sql`c.origem_tipo = ANY(${sql.raw(`ARRAY[${arr}]`)})`);
  }
  if (filtro.licitacaoId) {
    conds.push(sql`c.licitacao_id = ${filtro.licitacaoId}`);
  }

  // Filtros de metadado via EXISTS, nunca JOIN: as CTEs de candidatos contam
  // posição por linha, e um JOIN que duplica linha corromperia o RRF.
  if (filtro.detentora && filtro.detentora.length > 0) {
    const arr = filtro.detentora
      .map((d) => `'${String(d).replace(/'/g, "''")}'`)
      .join(",");
    conds.push(sql`EXISTS (
      SELECT 1 FROM documentos_habilitacao d2
      LEFT JOIN operacoes o2 ON o2.id = d2.operacao_id
      WHERE d2.id = c.origem_id
        AND coalesce(o2.detentora, d2.detentora) = ANY(${sql.raw(`ARRAY[${arr}]`)}))`);
  }
  if (filtro.tipoDocumento && filtro.tipoDocumento.length > 0) {
    const arr = filtro.tipoDocumento
      .map((d) => `'${String(d).replace(/'/g, "''")}'`)
      .join(",");
    conds.push(sql`EXISTS (
      SELECT 1 FROM documentos_habilitacao d3
      WHERE d3.id = c.origem_id
        AND d3.tipo_documento = ANY(${sql.raw(`ARRAY[${arr}]`)}))`);
  }
  if (filtro.desde) {
    conds.push(sql`EXISTS (
      SELECT 1 FROM documentos_habilitacao d4
      LEFT JOIN operacoes o4 ON o4.id = d4.operacao_id
      WHERE d4.id = c.origem_id
        AND coalesce(o4.periodo_fim, o4.periodo_inicio, d4.emitido_em::date)
            >= make_date(${filtro.desde}, 1, 1))`);
  }

  // 0034/S16 (02-APIS §16-B.3): predicado restrito no cruzamento com
  // documentos_habilitacao — defesa em profundidade (S15 garante que restrito
  // nunca é indexado; se um chunk órfão sobrar de antes da marcação, ele não
  // sai daqui para papel fora de Conformidade). Espelho de acervo_buscar.py.
  conds.push(sql`NOT (c.origem_tipo = 'DOC_HABILITACAO' AND EXISTS (
    SELECT 1 FROM documentos_habilitacao d
    WHERE d.id = c.origem_id
    AND NOT (d.restrito = false OR ${isConformidade(role)})))`);

  let where = conds[0];
  for (let i = 1; i < conds.length; i++) {
    where = sql`${where} AND ${conds[i]}`;
  }

  // O vetor da query entra como literal seguro (só dígitos/sinais) via sql.raw,
  // pois o driver não tem binding nativo para o tipo `vector`.
  // O LEFT JOIN traz a identidade do ARQUIVO. Sem ele a citação sai como
  // "[1] origem=DOC_HABILITACAO id=<uuid>" — correto e inútil: ninguém abre um
  // documento por UUID. Com nome, tipo e operação, a fonte vira algo que a
  // pessoa reconhece e o front consegue transformar em link.
  // TRANSAÇÃO só para poder aplicar `hnsw.ef_search` a esta consulta.
  //
  // O drizzle sobre node-postgres executa cada statement solto num pool: um
  // `SET` fora de transação ou não sobrevive até a consulta, ou — pior — cola
  // na conexão e vaza para a próxima consulta que a reutilizar. Dentro de
  // db.transaction() o `SET LOCAL` morre no COMMIT, que é o que queremos.
  //
  // Espelha bff/app/routers/migrated/acervo_buscar.py, que consegue o mesmo
  // efeito com set_config(..., true) porque a AsyncSession já é transacional.
  const r = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL hnsw.ef_search = ${sql.raw(String(efSearch))}`);
    return tx.execute(sql`
      WITH consulta AS (
        SELECT websearch_to_tsquery('portuguese',
                 f_unaccent(coalesce(${pergunta}, ''))) AS estrita
      ),
      termos AS (
        -- Extrai APENAS os lexemas do tsquery JA PARSEADO. Em tsquery::text todo
        -- lexema sai entre aspas simples e todo operador (& | ! <-> <N>
        -- parenteses) sai FORA delas; pegar so o miolo das aspas descarta
        -- operador POR CONSTRUCAO.
        --
        -- A versao anterior quebrava so em ' & ' e por isso (a) colava o "!" no
        -- lexema, gerando o literal '!refx' que casa 0 chunks, e (b) colapsava
        -- frase inteira num lexema unico com espacos dentro
        -- ('11.222.333 <-> /0001-81'). Medido nas 40 perguntas de referencia: 21
        -- lexemas mortos em 10 perguntas.
        -- O '''' desdobra a aspa que o proprio Postgres escapa quando o lexema
        -- contem aspa simples.
        SELECT replace(m[1], '''''', '''') AS lexema
          FROM consulta,
               regexp_matches(consulta.estrita::text,
                              '''((?:[^'']|'''')*)''', 'g') AS m
      ),
      -- ORCAMENTO DE RARIDADE (migracao 0039). Os termos entram do mais raro
      -- para o mais comum enquanto a soma dos ndoc couber no orcamento.
      --
      -- ndoc = 0 e lexema que NAO existe no acervo (OCR torto, termo de outro
      -- dominio): custa nada, casa nada, entra de graca — e a rede de seguranca
      -- para tabela desatualizada, que assim degrada para "AMPLA mais larga" e
      -- nunca para "AMPLA que perde termo raro".
      --
      -- PISO: o termo mais raro tem a PRIMEIRA reivindicacao do orcamento, entao
      -- K=1 e implicito. Se nem ele cabe (pergunta so de palavra ultracomum),
      -- a AMPLA sai NULA e o braco desliga — mesmo comportamento da 0037.
      termos_df AS (
        -- GROUP BY obrigatorio: sem ele um lexema repetido na pergunta contaria
        -- o custo duas vezes no orcamento.
        SELECT t.lexema, coalesce(max(d.ndoc), 0) AS ndoc
          FROM termos t
          LEFT JOIN acervo_lexemas_df d ON d.lexema = t.lexema
         WHERE t.lexema <> ''
           -- Cinto e suspensorio: residuo de operador que escape da extracao.
           AND t.lexema !~ '[!&|<>()'' ]'
           -- Lexema de 1 caractere nao discrimina: 'r' sozinho casa ~1 em cada 6 chunks.
           AND char_length(t.lexema) > 1
         GROUP BY t.lexema
      ),
      termos_orcados AS (
        -- PARTITION BY (ndoc = 0) isola os inexistentes: nao consomem orcamento
        -- nem empurram os reais para fora.
        SELECT lexema, ndoc,
               sum(ndoc) OVER (PARTITION BY (ndoc = 0)
                               ORDER BY ndoc, lexema
                               ROWS UNBOUNDED PRECEDING) AS custo_acum
          FROM termos_df
      ),
      consulta_ampla AS (
        -- ORDER BY ndoc, lexema na janela E aqui: desempate deterministico, sem
        -- ele duas execucoes da mesma pergunta montam tsqueries diferentes.
        SELECT nullif(string_agg(quote_literal(lexema), ' | '
                                 ORDER BY ndoc, lexema), '')::tsquery AS ampla
          FROM termos_orcados
         WHERE ndoc = 0 OR custo_acum <= ${orcamentoAmpla}
      ),
      vetorial AS (
        SELECT c.id,
               row_number() OVER (
                 ORDER BY c.embedding <=> ${sql.raw(`'${literal}'::vector`)}) AS posicao
          FROM acervo_chunks c
         WHERE ${where}
         ORDER BY c.embedding <=> ${sql.raw(`'${literal}'::vector`)}
         LIMIT ${candidatos}
      ),
      estrita AS (
        SELECT c.id,
               row_number() OVER (
                 ORDER BY ts_rank_cd(c.busca_tsv, q.estrita) DESC, c.id) AS posicao
          FROM acervo_chunks c CROSS JOIN consulta q
         WHERE ${where} AND q.estrita IS NOT NULL AND c.busca_tsv @@ q.estrita
         ORDER BY ts_rank_cd(c.busca_tsv, q.estrita) DESC, c.id
         LIMIT ${candidatos}
      ),
      ampla AS (
        SELECT c.id,
               row_number() OVER (
                 ORDER BY ts_rank_cd(c.busca_tsv, q.ampla) DESC, c.id) AS posicao
          FROM acervo_chunks c CROSS JOIN consulta_ampla q
         WHERE ${where} AND q.ampla IS NOT NULL AND c.busca_tsv @@ q.ampla
         ORDER BY ts_rank_cd(c.busca_tsv, q.ampla) DESC, c.id
         LIMIT ${candidatos}
      ),
      fundido AS (
        SELECT coalesce(v.id, e.id, a.id) AS id,
               CASE WHEN v.posicao IS NULL THEN 0 ELSE 1.0/(${RRF_K} + v.posicao) END
             + CASE WHEN e.posicao IS NULL THEN 0 ELSE 1.0/(${RRF_K} + e.posicao) END
             + CASE WHEN a.posicao IS NULL THEN 0 ELSE 1.0/(${RRF_K} + a.posicao) END
               AS rrf,
               v.posicao AS pos_vetor,
               coalesce(e.posicao, a.posicao) AS pos_texto
          FROM vetorial v
          FULL OUTER JOIN estrita e ON e.id = v.id
          FULL OUTER JOIN ampla   a ON a.id = coalesce(v.id, e.id)
      ),
      ordenado AS (
        SELECT f.*,
               row_number() OVER (PARTITION BY md5(c.texto)
                                  ORDER BY f.rrf DESC, c.id) AS repetido
          FROM fundido f JOIN acervo_chunks c ON c.id = f.id
      )
      SELECT
        c.id,
        c.origem_tipo   AS "origemTipo",
        c.origem_id     AS "origemId",
        c.licitacao_id  AS "licitacaoId",
        c.chunk_index   AS "chunkIndex",
        c.texto,
        c.metadata,
        d.titulo          AS "docTitulo",
        d.nome_arquivo    AS "docArquivo",
        d.tipo_documento  AS "docTipo",
        d.situacao_prova  AS "docSituacao",
        d.detentora       AS "docDetentora",
        o.codigo          AS "opCodigo",
        o.cliente_nome    AS "opCliente",
        d.numero_documento AS "docNumero",
        d.emitido_em       AS "docEmitidoEm",
        o.detentora        AS "opDetentora",
        o.cliente_grupo    AS "opClienteGrupo",
        o.contrato_numero  AS "opContrato",
        o.unidade          AS "opUnidade",
        o.escopo           AS "opEscopo",
        o.periodo_inicio   AS "opInicio",
        o.periodo_fim      AS "opFim",
        a.descricao       AS "anexoDescricao",
        1 - (c.embedding <=> ${sql.raw(`'${literal}'::vector`)}) AS "similaridade",
        r.rrf             AS "rrf",
        r.pos_vetor       AS "posVetor",
        r.pos_texto       AS "posTexto"
      FROM ordenado r
      JOIN acervo_chunks c ON c.id = r.id
      LEFT JOIN documentos_habilitacao d
             ON c.origem_tipo = 'DOC_HABILITACAO' AND d.id = c.origem_id
      LEFT JOIN operacoes o ON o.id = d.operacao_id
      LEFT JOIN anexos a
             ON c.origem_tipo = 'ANEXO_EDITAL' AND a.id = c.origem_id
      WHERE r.repetido = 1
      ORDER BY r.rrf DESC, c.id
      LIMIT ${topK}
    `);
  });

  type Row = {
    id: string;
    origemTipo: OrigemAcervo;
    origemId: string;
    licitacaoId: string | null;
    chunkIndex: number;
    texto: string;
    metadata: Record<string, unknown> | null;
    docTitulo: string | null;
    docArquivo: string | null;
    docTipo: string | null;
    docSituacao: string | null;
    docDetentora: string | null;
    opCodigo: string | null;
    opCliente: string | null;
    docNumero: string | null;
    docEmitidoEm: Date | string | null;
    opDetentora: string | null;
    opClienteGrupo: string | null;
    opContrato: string | null;
    opUnidade: string | null;
    opEscopo: string | null;
    opInicio: Date | string | null;
    opFim: Date | string | null;
    rrf: string | number | null;
    posVetor: string | number | null;
    posTexto: string | number | null;
    anexoDescricao: string | null;
    similaridade: number;
  };

  const rows = r.rows as unknown as Row[];

  return rows
    .map((row) => ({
      id: row.id,
      origemTipo: row.origemTipo,
      origemId: row.origemId,
      licitacaoId: row.licitacaoId,
      chunkIndex: Number(row.chunkIndex) || 0,
      texto: row.texto,
      metadata: row.metadata,
      similaridade: Number(row.similaridade) || 0,
      rrf: Number(row.rrf) || 0,
      posVetor: row.posVetor === null ? null : Number(row.posVetor),
      posTexto: row.posTexto === null ? null : Number(row.posTexto),
      arquivo: identidade(row),
    }))
    // O piso de similaridade é do lado VETORIAL, e só dele. Medido: a amplitude
    // entre a 1ª e a 20ª posição é 0,03–0,07 e o valor absoluto varia por
    // pergunta (a 0,55 "tubulação" não perde nada e "submarina" perde 19 de 20).
    // Resultado achado pelo TEXTO passa direto — casamento lexical com número de
    // contrato não é ruído de vetor, e é o que o híbrido existe para resgatar.
    .filter((c) => c.similaridade >= simMin || c.posTexto !== null);
}

/**
 * Monta o bloco de contexto para o prompt do Claude, numerando as fontes para
 * que o modelo cite por número ([1], [2]...). Devolve o texto e a lista de
 * fontes na MESMA ordem (1-based) para renderizar as citações no resultado.
 */
export interface FonteCitavel {
  numero: number;
  origemTipo: OrigemAcervo;
  origemId: string;
  licitacaoId: string | null;
  chunkIndex: number;
  similaridade: number;
  arquivo?: ArquivoOrigem;
}

export function montarContexto(chunks: ChunkRecuperado[]): {
  contexto: string;
  fontes: FonteCitavel[];
} {
  const fontes: FonteCitavel[] = [];
  const blocos: string[] = [];

  chunks.forEach((c, i) => {
    const numero = i + 1;
    fontes.push({
      numero,
      origemTipo: c.origemTipo,
      origemId: c.origemId,
      licitacaoId: c.licitacaoId,
      chunkIndex: c.chunkIndex,
      similaridade: Math.round(c.similaridade * 1000) / 1000,
      arquivo: c.arquivo,
    });
    // O rótulo nomeia o documento também para o MODELO: citar "[1] ART nº …
    // (operação 12345)" produz resposta verificável; citar um UUID, não.
    const a = c.arquivo;
    const detalhe = a
      ? `${a.nome}${a.operacao ? ` · operação ${a.operacao}` : ""}${a.tipo ? ` · ${a.tipo}` : ""}`
      : `${c.origemTipo} ${c.origemId}`;
    const rotulo = `[${numero}] ${detalhe}`;
    blocos.push(`${rotulo}\n${c.texto}`);
  });

  return { contexto: blocos.join("\n\n---\n\n"), fontes };
}
