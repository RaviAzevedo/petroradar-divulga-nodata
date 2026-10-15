/**
 * DOSSIÊ DE UMA FAMÍLIA CRC — tudo que decide o cadastro, numa página.
 *
 * POR QUE ESTE ARQUIVO EXISTE
 * ───────────────────────────
 * A tela de detalhe da família mostrava só o que NÓS digitamos: nome, descrição,
 * tags, critérios, validade. Não mostrava nenhuma das três coisas que decidem:
 *
 *   1. O ESCOPO OFICIAL da Petrobras — o gabarito contra o qual um atestado é
 *      lido. Estava no banco (migração 0040) e invisível na tela.
 *   2. Os INDÍCIOS do acervo — apontamentos por família, cada um com
 *      justificativa. Produzidos, gravados e sem nenhuma tela que os mostrasse.
 *   3. A DEMANDA OBSERVADA — quantas licitações exigiram esta família e quando.
 *
 * E a página só existia para as famílias cadastradas. As candidatas a
 * cadastro — o resultado inteiro da classificação — não tinham página nenhuma:
 * no mapa elas aparecem como linha sem link. Justamente as que exigem decisão.
 *
 * Por isso o dossiê é chaveado por CÓDIGO, não por uuid do cadastro: todas as do
 * catálogo têm dossiê, cadastradas ou não. O bloco `cadastro` vem null quando a
 * família ainda não é nossa, e é exatamente essa ausência que a tela mostra.
 *
 * RESTRITO (0034/S15)
 * ───────────────────
 * O mapa conta só documento não-restrito, porque é visão de mercado. Aqui vale a
 * regra do cofre: `restricaoVisivel(role)` — quem é de Conformidade vê a prova
 * restrita que sustenta a família; os demais não. Por isso o dossiê pode contar
 * mais provas que o mapa para o mesmo código, e `restritosOcultos` diz quantas
 * ficaram de fora, para que a diferença nunca seja silenciosa.
 */

import { db } from "@/db";
import { sql } from "drizzle-orm";
import { isConformidade } from "@/lib/permissions";
import { redigirPii } from "@/lib/seguranca/pii";
import { estadoProva, quadranteDe, type EstadoProva, type Quadrante } from "./mapa";

export interface ProvaConfirmada {
  vinculoId: string;
  documentoId: string;
  titulo: string;
  categoria: string;
  subcategoria: string;
  status: string;
  validadeFim: Date | null;
  observacao: string | null;
  vinculadoEm: Date | null;
  restrito: boolean;
}

export interface IndicioDaFamilia {
  id: string;
  documentoId: string;
  titulo: string;
  categoria: string;
  subcategoria: string;
  restrito: boolean;
  /** PROVA | PARCIAL | ABSTEM | NAO — a força do apontamento. */
  veredito: string;
  confianca: number | null;
  /** O argumento. NÃO é citação literal garantida — ver comentário da 0041. */
  justificativa: string | null;
  procedencia: string;
  modelo: string | null;
  revisao: string | null;
  revisadoEm: Date | null;
  revisadoPorNome: string | null;
  criadoEm: Date;
}

export interface LicitacaoQueExigiu {
  numero: string;
  vistoEm: Date | null;
  /** id da licitação no app, quando ela existe lá (o raspão cru não tem). */
  licitacaoId: string | null;
  objeto: string | null;
}

export interface DossieFamilia {
  codigo: string;
  nome: string | null;

  /** O catálogo oficial da Petrobras. null = código que só apareceu no raspão. */
  catalogo: {
    nome: string | null;
    escopo: string | null;
    grupo: string | null;
    segmentoPetrobras: string | null;
    segmento: string;
    /** true = veio da relação oficial; false = só observado em licitação. */
    oficial: boolean;
  } | null;

  /** O nosso cadastro. null = família NÃO cadastrada (candidata). */
  cadastro: {
    familiaId: string;
    nome: string;
    descricao: string | null;
    status: string;
    statusFluxoCrc: string | null;
    validadeFim: Date | null;
    cadastroCorporativo: boolean;
  } | null;

  demanda: {
    licitacoes: number;
    itens: number;
    primeiraVezEm: Date | null;
    ultimaVezEm: Date | null;
    recentes: LicitacaoQueExigiu[];
  };

  provas: ProvaConfirmada[];
  indicios: IndicioDaFamilia[];
  /** Documentos LIDOS contra esta família que NÃO a sustentam — o lastro do "não". */
  refutacoes: IndicioDaFamilia[];
  /** Provas/indícios escondidos do papel atual por serem restritos. */
  restritosOcultos: number;

  avaliada: boolean;
  prova: EstadoProva;
  quadrante: Quadrante;
}

/**
 * Um indício é NEGATIVO — isto é, cai no bloco "lidos e não sustentam"?
 *
 * Espelha a regra do mapa, com as duas fontes de negativa que existem:
 *
 *   veredito NAO       a família foi lida contra o documento e ele não a
 *                      sustenta. É um "não" da máquina, com lastro.
 *   revisao REJEITADA  uma PESSOA disse que não vale. Precisa persistir e
 *                      precisa pesar mais que o veredito: um indício com
 *                      veredito PROVA e revisão REJEITADA é negativo, senão a
 *                      decisão humana não teria efeito nenhum na tela.
 *
 * ABSTEM NÃO é negativo: é candidato levantado pela extração e ainda sem
 * julgamento. Tratá-lo como "não sustenta" transformaria pendências em
 * negativas — inverteria o significado de boa parte da base.
 */
export function indicioNegativo(veredito: string, revisao: string | null): boolean {
  return veredito === "NAO" || revisao === "REJEITADA";
}

/** Ordem de força do veredito — a mesma do mapa, explícita e não alfabética. */
const ORDEM_VEREDITO = sql`CASE fc.veredito
  WHEN 'PROVA' THEN 1 WHEN 'PARCIAL' THEN 2 WHEN 'ABSTEM' THEN 3 ELSE 4 END`;

type Linha = Record<string, unknown>;
const linhasDe = (r: unknown) => ((r as { rows?: Linha[] }).rows ?? []);

const texto = (v: unknown) => (v == null ? null : String(v));
const data = (v: unknown) => (v == null ? null : new Date(v as string));

/** Um indício cru → o tipo da tela, com a justificativa já redigida. */
function mapearIndicio(row: Linha): IndicioDaFamilia {
  return {
    id: String(row.id),
    documentoId: String(row.documentoId),
    titulo: String(row.titulo ?? ""),
    categoria: String(row.categoria ?? ""),
    subcategoria: String(row.subcategoria ?? ""),
    restrito: Boolean(row.restrito),
    veredito: String(row.veredito),
    confianca: row.confianca == null ? null : Number(row.confianca),
    // A justificativa é trecho de OCR de atestado: pode carregar CPF do
    // responsável técnico. Redigir aqui e não na gravação — o texto original
    // continua auditável no banco (mesma escolha do caminho de busca).
    justificativa: redigirPii(texto(row.justificativa)),
    procedencia: String(row.procedencia ?? ""),
    modelo: texto(row.modelo),
    revisao: texto(row.revisao),
    revisadoEm: data(row.revisadoEm),
    revisadoPorNome: texto(row.revisadoPorNome),
    criadoEm: new Date(row.criadoEm as string),
  };
}

/**
 * O dossiê completo de um código de família.
 *
 * Devolve null só quando o código não existe em lugar nenhum — nem no catálogo,
 * nem no cadastro, nem como indício. Um código que existe só no catálogo TEM
 * dossiê: é o caso das não cadastradas, e é o caso interessante.
 */
export async function dossieFamilia(
  codigoBruto: string,
  role: string,
): Promise<DossieFamilia | null> {
  const codigo = codigoBruto.trim();
  if (!codigo) return null;

  // Conformidade vê o restrito (mesma regra do cofre); os demais, não.
  const vePrivado = isConformidade(role);
  const filtroRestrito = vePrivado ? sql`true` : sql`d.restrito = false`;

  const cabecalho = linhasDe(
    await db.execute(sql`
      WITH alvo AS (SELECT f_codigo_crc(${codigo}) AS cod),
      cad AS (
        SELECT f.*, f_codigo_crc(f.codigo_crc) AS chave
          FROM familias f, alvo
         WHERE f.deletado_em IS NULL
           AND f_codigo_crc(f.codigo_crc) = alvo.cod
      )
      SELECT
        alvo.cod                                  AS "codigo",
        coalesce(cad.nome, c.nome)                AS "nome",
        (c.codigo IS NOT NULL)                    AS "temCatalogo",
        c.nome                                    AS "catalogoNome",
        c.escopo                                  AS "escopo",
        c.grupo                                   AS "grupo",
        c.segmento_petrobras                      AS "segmentoPetrobras",
        coalesce(c.segmento, 'SERVICO')           AS "segmento",
        coalesce(c.oficial, false)                AS "oficial",
        coalesce(c.licitacoes, 0)                 AS "licitacoes",
        coalesce(c.itens, 0)                      AS "itens",
        c.primeira_vez_em                         AS "primeiraVezEm",
        c.ultima_vez_em                           AS "ultimaVezEm",
        cad.id                                    AS "familiaId",
        cad.nome                                  AS "cadastroNome",
        cad.descricao                             AS "descricao",
        cad.status                                AS "status",
        cad.status_fluxo_crc                      AS "statusFluxoCrc",
        cad.validade_fim                          AS "validadeFim",
        coalesce(cad.cadastro_corporativo, false) AS "cadastroCorporativo",
        EXISTS (SELECT 1 FROM familias_classificacao_escopo e
                 WHERE e.familia_codigo = alvo.cod)        AS "avaliada",
        EXISTS (SELECT 1 FROM familias_classificacoes fc
                 WHERE fc.familia_codigo = alvo.cod)       AS "temIndicio"
        FROM alvo
        LEFT JOIN familias_catalogo c ON c.codigo = alvo.cod
        LEFT JOIN cad ON true
       LIMIT 1
    `),
  )[0];

  if (!cabecalho) return null;
  const existe =
    Boolean(cabecalho.temCatalogo) ||
    cabecalho.familiaId != null ||
    Boolean(cabecalho.temIndicio);
  if (!existe) return null;

  const cod = String(cabecalho.codigo);
  const familiaId = texto(cabecalho.familiaId);

  const [provasR, indiciosR, demandaR, ocultosR] = await Promise.all([
    // PROVA CONFIRMADA — vínculo criado pela mão de uma pessoa.
    familiaId
      ? db.execute(sql`
          SELECT df.id           AS "vinculoId",
                 d.id            AS "documentoId",
                 d.titulo        AS "titulo",
                 d.categoria     AS "categoria",
                 d.subcategoria  AS "subcategoria",
                 d.status        AS "status",
                 d.validade_fim  AS "validadeFim",
                 d.restrito      AS "restrito",
                 df.observacao   AS "observacao",
                 df.criado_em    AS "vinculadoEm"
            FROM documentos_familias df
            JOIN documentos_habilitacao d ON d.id = df.documento_id
           WHERE df.familia_id = ${familiaId}::uuid
             AND ${filtroRestrito}
           ORDER BY d.titulo
        `)
      : Promise.resolve({ rows: [] }),

    // INDÍCIOS — todos os vereditos; a separação positivo/negativo é abaixo, em
    // TypeScript, para que a regra fique visível e testável sem banco.
    db.execute(sql`
      SELECT fc.id             AS "id",
             fc.documento_id   AS "documentoId",
             d.titulo          AS "titulo",
             d.categoria       AS "categoria",
             d.subcategoria    AS "subcategoria",
             d.restrito        AS "restrito",
             fc.veredito       AS "veredito",
             fc.confianca      AS "confianca",
             fc.justificativa  AS "justificativa",
             fc.procedencia    AS "procedencia",
             fc.modelo         AS "modelo",
             fc.revisao        AS "revisao",
             fc.revisado_em    AS "revisadoEm",
             u.nome            AS "revisadoPorNome",
             fc.criado_em      AS "criadoEm"
        FROM familias_classificacoes fc
        JOIN documentos_habilitacao d ON d.id = fc.documento_id
        LEFT JOIN users u ON u.id = fc.revisado_por
       WHERE fc.familia_codigo = ${cod}
         AND ${filtroRestrito}
       ORDER BY ${ORDEM_VEREDITO}, fc.confianca DESC NULLS LAST, d.titulo
    `),

    // AS LICITAÇÕES QUE EXIGIRAM — as duas fontes da migração 0040, unidas por
    // NÚMERO (não por uuid: contar uuid de um lado e número do outro faria a
    // mesma licitação contar duas vezes).
    db.execute(sql`
      WITH exigencias AS (
        SELECT p.numero AS numero, max(p.captured_at) AS visto_em
          FROM petronect_lic_items p
         WHERE f_codigo_crc(p.family) = ${cod}
         GROUP BY p.numero
        UNION ALL
        SELECT l.numero, max(i.criado_em)
          FROM itens i
          JOIN licitacoes l ON l.id = i.licitacao_id
         WHERE f_codigo_crc(i.familia) = ${cod}
         GROUP BY l.numero
      )
      SELECT e.numero               AS "numero",
             max(e.visto_em)        AS "vistoEm",
             max(l.id::text)        AS "licitacaoId",
             max(l.objeto)          AS "objeto"
        FROM exigencias e
        LEFT JOIN licitacoes l ON l.numero = e.numero
       GROUP BY e.numero
       ORDER BY max(e.visto_em) DESC NULLS LAST, e.numero DESC
       LIMIT 12
    `),

    // Quantas linhas o papel atual NÃO está vendo. Zero para Conformidade.
    vePrivado
      ? Promise.resolve({ rows: [{ n: 0 }] })
      : db.execute(sql`
          SELECT (
            (SELECT count(*) FROM familias_classificacoes fc
               JOIN documentos_habilitacao d ON d.id = fc.documento_id
              WHERE fc.familia_codigo = ${cod} AND d.restrito = true)
            + coalesce((SELECT count(*) FROM documentos_familias df
               JOIN documentos_habilitacao d ON d.id = df.documento_id
              WHERE ${familiaId ? sql`df.familia_id = ${familiaId}::uuid` : sql`false`}
                AND d.restrito = true), 0)
          )::int AS n
        `),
  ]);

  const provas: ProvaConfirmada[] = linhasDe(provasR).map((row) => ({
    vinculoId: String(row.vinculoId),
    documentoId: String(row.documentoId),
    titulo: String(row.titulo ?? ""),
    categoria: String(row.categoria ?? ""),
    subcategoria: String(row.subcategoria ?? ""),
    status: String(row.status ?? ""),
    validadeFim: data(row.validadeFim),
    observacao: texto(row.observacao),
    vinculadoEm: data(row.vinculadoEm),
    restrito: Boolean(row.restrito),
  }));

  const todos = linhasDe(indiciosR).map(mapearIndicio);
  const indicios = todos.filter((i) => !indicioNegativo(i.veredito, i.revisao));
  const refutacoes = todos.filter((i) => indicioNegativo(i.veredito, i.revisao));

  const avaliada = Boolean(cabecalho.avaliada);
  const prova = estadoProva(provas.length, indicios.length, avaliada);
  const cadastrada = familiaId != null;

  return {
    codigo: cod,
    nome: texto(cabecalho.nome),
    catalogo: cabecalho.temCatalogo
      ? {
          nome: texto(cabecalho.catalogoNome),
          escopo: texto(cabecalho.escopo),
          grupo: texto(cabecalho.grupo),
          segmentoPetrobras: texto(cabecalho.segmentoPetrobras),
          segmento: String(cabecalho.segmento),
          oficial: Boolean(cabecalho.oficial),
        }
      : null,
    cadastro: familiaId
      ? {
          familiaId,
          nome: String(cabecalho.cadastroNome ?? ""),
          descricao: texto(cabecalho.descricao),
          status: String(cabecalho.status ?? ""),
          statusFluxoCrc: texto(cabecalho.statusFluxoCrc),
          validadeFim: data(cabecalho.validadeFim),
          cadastroCorporativo: Boolean(cabecalho.cadastroCorporativo),
        }
      : null,
    demanda: {
      licitacoes: Number(cabecalho.licitacoes ?? 0),
      itens: Number(cabecalho.itens ?? 0),
      primeiraVezEm: data(cabecalho.primeiraVezEm),
      ultimaVezEm: data(cabecalho.ultimaVezEm),
      recentes: linhasDe(demandaR).map((row) => ({
        numero: String(row.numero),
        vistoEm: data(row.vistoEm),
        licitacaoId: texto(row.licitacaoId),
        objeto: texto(row.objeto),
      })),
    },
    provas,
    indicios,
    refutacoes,
    restritosOcultos: Number(linhasDe(ocultosR)[0]?.n ?? 0),
    avaliada,
    prova,
    quadrante: quadranteDe(cadastrada, prova),
  };
}
