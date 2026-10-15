/**
 * MAPA DE FAMÍLIAS — cruza o nosso cadastro com o mercado observado.
 *
 * POR QUE ESTE ARQUIVO EXISTE
 * ───────────────────────────
 * A tela de famílias mostra aquelas em que a Proponente está CADASTRADA. Isso
 * responde "estamos cadastrados na família X?" e mais nada — e deixa invisíveis
 * as duas perguntas que decidem dinheiro:
 *
 *   1. Em que família o mercado exige e nós NÃO estamos cadastrados?
 *   2. Em que família estamos cadastrados e NÃO temos como provar?
 *
 * Uma família pode ser exigida repetidamente nas licitações da base e NÃO estar
 * no cadastro. Uma tela que só lista o cadastro é incapaz de mostrar justamente
 * a família que mais custa oportunidades.
 *
 * OS QUATRO QUADRANTES
 * ────────────────────
 *                      │ temos prova      │ não temos prova
 *   ───────────────────┼──────────────────┼─────────────────────────────
 *   cadastrados no CRC │ NUCLEO           │ RISCO (disputa e perde)
 *   não cadastrados    │ OPORTUNIDADE     │ FORA_DE_ALCANCE
 *
 * ⚠️ INDÍCIO NÃO É PROVA. `familias_classificacoes` guarda os indícios apontados
 * pela máquina; `documentos_familias` guarda a prova confirmada por uma pessoa.
 * Enquanto não houver vínculo confirmado, o que o mapa mostra em NUCLEO e
 * OPORTUNIDADE é indício. Só a revisão humana
 * (`/api/conformidade/familias/classificacoes/[id]`) move uma linha de um estado
 * para o outro.
 *
 * E "sem indício" só pode ser dito de família AVALIADA: só parte do catálogo
 * entrou no vocabulário da classificação, o restante é desconhecimento, não
 * negativa. Uma tela que dissesse "não comprovada" para essas seria ativamente
 * enganosa — por isso são quatro estados de prova, e não dois.
 */

import { db } from "@/db";
import { sql } from "drizzle-orm";

/**
 * Estado de prova, em quatro graus. A distinção que importa é a última:
 *
 *   COM_PROVA      documento vinculado em `documentos_familias` — uma PESSOA
 *                  confirmou. É o único grau que sustenta um NO-GO.
 *   COM_INDICIO    a classificação da máquina aponta documento de prova
 *                  (`familias_classificacoes`), mas ninguém revisou ainda.
 *   SEM_INDICIO    a família ESTAVA no vocabulário da classificação e nenhum
 *                  documento a sustentou. É um "não" com lastro.
 *   INDETERMINADO  a família nunca foi avaliada — não sabemos. Se a extração
 *                  usou só o cadastro da Proponente como vocabulário, as demais
 *                  famílias de serviço do catálogo caem aqui, e chamá-las de
 *                  "sem prova" seria mentira.
 */
export type EstadoProva = "COM_PROVA" | "COM_INDICIO" | "SEM_INDICIO" | "INDETERMINADO";

export type Quadrante =
  | "NUCLEO"          // cadastrada + prova ou indício → o que dá para disputar
  | "RISCO"           // cadastrada + sem indício → disputa e perde na habilitação
  | "OPORTUNIDADE"    // não cadastrada + prova ou indício → pedir o CRC
  | "FORA_DE_ALCANCE" // não cadastrada + sem indício, com lastro
  | "A_APURAR";       // nunca avaliada — não sabemos

export interface FamiliaNoMapa {
  codigo: string;
  nome: string | null;
  segmento: "MATERIAL" | "SERVICO" | "OUTRO";
  /** Escopo canônico da Petrobras — o gabarito contra o qual um atestado é lido. */
  escopo: string | null;
  /** Grupo do catálogo, ex.: "S-01 - Estudos e Projetos". */
  grupo: string | null;
  /** Crítica | Operacional | Estratégica | Página Amarela. */
  segmentoPetrobras: string | null;
  /** Demanda OBSERVADA: licitações da nossa base que exigiram esta família. */
  licitacoes: number;
  ultimaVezEm: Date | null;
  /** Do nosso cadastro, quando existe. */
  familiaId: string | null;
  cadastrada: boolean;
  statusFluxoCrc: string | null;
  validadeFim: Date | null;
  /** Documentos com vínculo CONFIRMADO por uma pessoa (documentos_familias). */
  documentosVinculados: number;
  /** Documentos de prova que a máquina apontou. */
  documentosComIndicio: number;
  /** Destes, quantos uma PESSOA já confirmou. Ainda não é prova enquanto não há
   *  vínculo (família não cadastrada não tem a que vincular) — mas é trabalho
   *  humano feito, e sumir com ele desmotiva a fila. */
  indiciosConfirmados: number;
  /** Quantos seguem sem nenhuma decisão humana — a fila de trabalho de hoje. */
  indiciosPendentes: number;
  /** Maior confiança entre os indícios — ajuda a priorizar a fila de revisão. */
  maiorConfianca: number | null;
  /**
   * MELHOR veredito entre os indícios: PROVA > PARCIAL > ABSTEM.
   *
   * O estado de prova (`prova`) colapsa PROVA e PARCIAL em COM_INDICIO, porque
   * para o quadrante os dois sustentam. Mas a tela PRECISA da diferença: uma
   * família que o acervo prova por inteiro e outra que ele só tangencia não são
   * a mesma decisão de cadastro.
   */
  melhorVeredito: string | null;
  /** A justificativa do melhor indício — o argumento, não o número. */
  justificativa: string | null;
  /** True se a família esteve no vocabulário da classificação (senão: não sabemos). */
  avaliada: boolean;
  prova: EstadoProva;
  quadrante: Quadrante;
}

export interface FiltrosMapa {
  /** Default SERVICO: boa parte do catálogo é material, fora do foco de serviços. */
  segmento?: ("MATERIAL" | "SERVICO" | "OUTRO")[];
  quadrante?: Quadrante[];
  /** Só famílias com demanda observada >= n. */
  demandaMinima?: number;
  /** Só famílias exigidas a partir deste ano — recência importa numa fila de decisão. */
  desde?: number;
  /** Esconde as sem nome: são código puro e não se julga uma família por código. */
  somenteComNome?: boolean;
  /**
   * Estado da revisão humana dos indícios — a fila de trabalho.
   *   PENDENTE   tem indício que ninguém decidiu ainda. É o que fazer hoje.
   *   REVISADA   tem pelo menos uma confirmação humana.
   * Sem este filtro, achar "o que falta revisar" exigia abrir família por
   * família: nenhuma tela dizia quais já passaram por gente.
   */
  revisao?: "PENDENTE" | "REVISADA";
  busca?: string;
  limite?: number;
}

/**
 * O mapa completo: FULL OUTER JOIN entre cadastro e catálogo.
 *
 * O FULL OUTER é o ponto todo. Um LEFT do cadastro perderia as oportunidades
 * (família exigida em que não estamos); um LEFT do catálogo perderia as
 * famílias nossas que o mercado nunca exigiu na nossa base. Os dois lados
 * importam, e cada ausência significa uma coisa diferente.
 */
export async function mapaFamilias(f: FiltrosMapa = {}): Promise<FamiliaNoMapa[]> {
  const segmentos = f.segmento?.length ? f.segmento : ["SERVICO"];
  const arrSeg = sql.raw(
    `ARRAY[${segmentos.map((s) => `'${String(s).replace(/'/g, "''")}'`).join(",")}]`,
  );
  // 1000 e nao 500: o catalogo oficial tem mais de 500 familias e o ORDER BY
  // poe `licitacoes DESC` na frente, entao um teto de 500 cortava justamente as
  // de demanda ZERO — onde tambem ha oportunidades. Teto que corta em silencio e
  // pior que teto nenhum.
  const limite = Math.max(1, Math.min(2000, f.limite ?? 1000));

  const cond = [sql`true`];
  // Segmento vem do catálogo; família nossa sem catálogo herda SERVICO, porque
  // o cadastro é de serviço (99*). Sem esse coalesce elas sumiriam do filtro padrão.
  cond.push(sql`coalesce(c.segmento, 'SERVICO') = ANY(${arrSeg})`);
  if (f.demandaMinima) cond.push(sql`coalesce(c.licitacoes, 0) >= ${f.demandaMinima}`);
  if (f.desde) cond.push(sql`c.ultima_vez_em >= make_date(${f.desde}, 1, 1)`);
  if (f.somenteComNome) cond.push(sql`coalesce(fam.nome, c.nome) IS NOT NULL`);
  if (f.revisao === "PENDENTE") cond.push(sql`coalesce(i.pendentes, 0) > 0`);
  if (f.revisao === "REVISADA") cond.push(sql`coalesce(i.confirmados, 0) > 0`);
  if (f.busca?.trim()) {
    const q = `%${f.busca.trim()}%`;
    cond.push(sql`(coalesce(fam.nome, c.nome) ILIKE ${q}
                   OR coalesce(fam.codigo_crc, c.codigo) ILIKE ${q})`);
  }
  let where = cond[0];
  for (let i = 1; i < cond.length; i++) where = sql`${where} AND ${cond[i]}`;

  const r = await db.execute(sql`
    WITH cadastro AS (
      -- f_codigo_crc (migração 0040) poda o zero à esquerda do padding do SAP;
      -- codigo_normalizado NÃO faz isso e não pode passar a fazer — é a chave
      -- única do cadastro.
      SELECT f.*, f_codigo_crc(f.codigo_crc) AS chave
        FROM familias f
       WHERE f.deletado_em IS NULL
    ),
    provas AS (
      -- PROVA CONFIRMADA: alguem revisou e vinculou. E o unico grau que sustenta
      -- um NO-GO. 0034/S15: restrito nunca conta numa visao de mercado.
      SELECT df.familia_id, count(*)::int AS n
        FROM documentos_familias df
        JOIN documentos_habilitacao d ON d.id = df.documento_id
       WHERE d.restrito = false
       GROUP BY df.familia_id
    ),
    indicios AS (
      -- INDICIO: a maquina apontou, ninguem revisou. Chaveia por CODIGO, nao por
      -- familia_id, porque o indicio pode apontar familia nao cadastrada — que e
      -- justamente o caso "oportunidade".
      --
      -- REJEITADA fica de fora: se a pessoa ja disse que nao vale, ressuscitar o
      -- indicio faz a revisao virar Sisifo.
      SELECT fc.familia_codigo AS cod,
             count(DISTINCT fc.documento_id)::int AS n,
             -- Quantos JA PASSARAM por uma pessoa. Sem isto, quem revisa
             -- indicios nao ve diferenca nenhuma no mapa no dia seguinte: a
             -- revisao so aparece no dossie de cada familia, uma por uma.
             count(*) FILTER (WHERE fc.revisao = 'CONFIRMADA')::int AS confirmados,
             count(*) FILTER (WHERE fc.revisao IS NULL)::int AS pendentes,
             max(fc.confianca) AS conf,
             -- Ordem de forca do veredito, nao ordem alfabetica: PROVA ganha de
             -- PARCIAL, que ganha de ABSTEM. Um max() sobre o rotulo daria
             -- 'PARCIAL' > 'ABSTEM' por acaso e 'PROVA' por acaso tambem — o
             -- CASE deixa a regra explicita em vez de depender do alfabeto.
             (array_agg(fc.veredito ORDER BY CASE fc.veredito
                WHEN 'PROVA' THEN 1 WHEN 'PARCIAL' THEN 2 ELSE 3 END,
                fc.confianca DESC NULLS LAST))[1] AS melhor,
             (array_agg(fc.justificativa ORDER BY CASE fc.veredito
                WHEN 'PROVA' THEN 1 WHEN 'PARCIAL' THEN 2 ELSE 3 END,
                fc.confianca DESC NULLS LAST))[1] AS razao
        FROM familias_classificacoes fc
        JOIN documentos_habilitacao d ON d.id = fc.documento_id
       WHERE d.restrito = false
         AND fc.revisao IS DISTINCT FROM 'REJEITADA'
         -- NAO e um veredito NEGATIVO: a familia foi lida contra o documento e
         -- ele nao a sustenta. Conta-la como indicio inverteria o significado.
         -- ABSTEM entra: e candidato levantado pela extracao, sem veredito.
         AND fc.veredito <> 'NAO'
       GROUP BY fc.familia_codigo
    ),
    avaliadas AS (
      -- O que a classificacao chegou a PROCURAR (migracao 0042), nao o que
      -- encontrou. Derivar do encontrado colapsaria dois estados opostos:
      -- familia que estava no vocabulario e nao casou nada ficaria sem linha e
      -- passaria por "ninguem perguntou" — justamente o caso da familia
      -- cadastrada que o acervo NAO sustenta, o achado que mais importa.
      SELECT DISTINCT familia_codigo AS cod FROM familias_classificacao_escopo
    )
    SELECT
      coalesce(fam.codigo_crc, c.codigo)          AS "codigo",
      coalesce(fam.nome, c.nome)                  AS "nome",
      coalesce(c.segmento, 'SERVICO')             AS "segmento",
      c.escopo                                    AS "escopo",
      c.grupo                                     AS "grupo",
      c.segmento_petrobras                        AS "segmentoPetrobras",
      coalesce(c.licitacoes, 0)                   AS "licitacoes",
      c.ultima_vez_em                             AS "ultimaVezEm",
      fam.id                                      AS "familiaId",
      (fam.id IS NOT NULL)                        AS "cadastrada",
      fam.status_fluxo_crc                        AS "statusFluxoCrc",
      fam.validade_fim                            AS "validadeFim",
      coalesce(p.n, 0)                            AS "documentosVinculados",
      coalesce(i.n, 0)                            AS "documentosComIndicio",
      coalesce(i.confirmados, 0)                  AS "indiciosConfirmados",
      coalesce(i.pendentes, 0)                    AS "indiciosPendentes",
      i.conf                                      AS "maiorConfianca",
      i.melhor                                    AS "melhorVeredito",
      i.razao                                     AS "justificativa",
      (av.cod IS NOT NULL)                        AS "avaliada"
      FROM cadastro fam
      FULL OUTER JOIN familias_catalogo c ON c.codigo = fam.chave
      LEFT JOIN provas p ON p.familia_id = fam.id
      LEFT JOIN indicios i ON i.cod = coalesce(fam.chave, c.codigo)
      LEFT JOIN avaliadas av ON av.cod = coalesce(fam.chave, c.codigo)
     WHERE ${where}
     ORDER BY coalesce(c.licitacoes, 0) DESC,
              coalesce(fam.nome, c.nome) NULLS LAST,
              coalesce(fam.codigo_crc, c.codigo)
     LIMIT ${limite}
  `);

  const linhas = (r as unknown as { rows: Record<string, unknown>[] }).rows ?? [];
  const mapeadas = linhas.map((row) => {
    const documentosVinculados = Number(row.documentosVinculados ?? 0);
    const documentosComIndicio = Number(row.documentosComIndicio ?? 0);
    const indiciosConfirmados = Number(row.indiciosConfirmados ?? 0);
    const indiciosPendentes = Number(row.indiciosPendentes ?? 0);
    const cadastrada = Boolean(row.cadastrada);
    const avaliada = Boolean(row.avaliada);
    const prova = estadoProva(documentosVinculados, documentosComIndicio, avaliada);
    return {
      codigo: String(row.codigo),
      nome: (row.nome as string | null) ?? null,
      segmento: row.segmento as FamiliaNoMapa["segmento"],
      escopo: (row.escopo as string | null) ?? null,
      grupo: (row.grupo as string | null) ?? null,
      segmentoPetrobras: (row.segmentoPetrobras as string | null) ?? null,
      licitacoes: Number(row.licitacoes ?? 0),
      ultimaVezEm: (row.ultimaVezEm as Date | null) ?? null,
      familiaId: (row.familiaId as string | null) ?? null,
      cadastrada,
      statusFluxoCrc: (row.statusFluxoCrc as string | null) ?? null,
      validadeFim: (row.validadeFim as Date | null) ?? null,
      documentosVinculados,
      documentosComIndicio,
      indiciosConfirmados,
      indiciosPendentes,
      maiorConfianca: row.maiorConfianca == null ? null : Number(row.maiorConfianca),
      melhorVeredito: (row.melhorVeredito as string | null) ?? null,
      justificativa: (row.justificativa as string | null) ?? null,
      avaliada,
      prova,
      quadrante: quadranteDe(cadastrada, prova),
    } satisfies FamiliaNoMapa;
  });

  return f.quadrante?.length
    ? mapeadas.filter((m) => f.quadrante!.includes(m.quadrante))
    : mapeadas;
}

/**
 * Grau de prova. Isolada para ser testada sem banco.
 *
 * A ordem importa: vínculo confirmado ganha de indício, e indício ganha de
 * ausência. E ausência só vira "não" quando a família FOI avaliada — senão é
 * desconhecimento, e dizer "não" seria inventar.
 */
export function estadoProva(
  vinculados: number,
  indicios: number,
  avaliada: boolean,
): EstadoProva {
  if (vinculados > 0) return "COM_PROVA";
  if (indicios > 0) return "COM_INDICIO";
  return avaliada ? "SEM_INDICIO" : "INDETERMINADO";
}

/** Regra dos quadrantes, isolada para poder ser testada sem banco. */
export function quadranteDe(cadastrada: boolean, prova: EstadoProva): Quadrante {
  if (prova === "INDETERMINADO") return "A_APURAR";
  const sustenta = prova === "COM_PROVA" || prova === "COM_INDICIO";
  if (cadastrada) return sustenta ? "NUCLEO" : "RISCO";
  return sustenta ? "OPORTUNIDADE" : "FORA_DE_ALCANCE";
}

/** Resumo por quadrante, para o cabeçalho da tela. */
export function resumirMapa(linhas: FamiliaNoMapa[]) {
  const porQuadrante = {} as Record<Quadrante, { familias: number; licitacoes: number }>;
  for (const l of linhas) {
    const q = (porQuadrante[l.quadrante] ??= { familias: 0, licitacoes: 0 });
    q.familias += 1;
    q.licitacoes += l.licitacoes;
  }
  return {
    porQuadrante,
    total: linhas.length,
    cadastradas: linhas.filter((l) => l.cadastrada).length,
    // Cadastro que o mercado nunca exigiu na nossa base. NÃO é "cadastro inútil":
    // pode ser cobertura de raspagem. É pergunta, não veredito.
    cadastradasSemDemanda: linhas.filter((l) => l.cadastrada && l.licitacoes === 0).length,
    demandaTotal: linhas.reduce((s, l) => s + l.licitacoes, 0),
  };
}
