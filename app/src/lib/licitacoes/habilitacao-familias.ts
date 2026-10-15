/**
 * TEMOS CONDIÇÃO DE PARTICIPAR? — por família CRC, cruzando com o acervo.
 *
 * POR QUE ESTE ARQUIVO EXISTE
 * ───────────────────────────
 * O briefing respondia o que o EDITAL exige e nunca o que a Proponente TEM. A §5
 * ("Critérios de Habilitação") é transcrição do edital; nenhum dos arquivos que
 * produzem briefing consultava o cadastro de famílias nem o acervo.
 *
 * Isso deixava de fora a pergunta que decide ir ou não ir: *estamos cadastrados
 * na família que esta licitação exige, e temos documento que sustente?* É a
 * pergunta que, sem resposta antecipada, só aparece como NO-GO depois que a
 * proposta já foi estudada.
 *
 * CUSTO ZERO DE TOKEN. Tudo aqui é junção determinística por código de família:
 * itens da licitação × catálogo oficial × nosso cadastro × provas × indícios.
 * Nenhuma chamada de modelo. A resposta não depende de a IA estar ligada.
 *
 * DE ONDE VÊM AS FAMÍLIAS EXIGIDAS
 * ────────────────────────────────
 * Das DUAS fontes, unidas — as mesmas da migração 0040:
 *   `itens`               (ligado à licitação por id)
 *   `petronect_lic_items` (raspão cru, ligado por número)
 * Usar só a primeira perderia licitação que o raspão viu e o app não normalizou.
 *
 * O QUE ESTA TELA NÃO PODE FAZER
 * ──────────────────────────────
 * Dizer "temos atestado" com base em INDÍCIO. `documentos_familias` — a prova
 * confirmada por uma pessoa — pode estar vazia. Enquanto estiver, tudo que o acervo
 * aponta é apontamento de máquina, sem revisão. Por isso o veredito distingue PODE de
 * PODE_COM_RESSALVA, e a ressalva vai impressa: um briefing que dissesse
 * "habilitados" sobre indício seria pior que um briefing omisso.
 */

import { db } from "@/db";
import { sql } from "drizzle-orm";
import {
  estadoProva,
  quadranteDe,
  type EstadoProva,
  type Quadrante,
} from "@/lib/conformidade/familias/mapa";

/**
 * O veredito por família. Cinco estados, e a diferença entre eles é a diferença
 * entre ir, ir torcendo, e não ir.
 */
export type VeredictoFamilia =
  | "PODE"               // cadastrado, CRC válido e prova confirmada
  | "PODE_COM_RESSALVA"  // cadastrado e válido, mas o lastro é INDÍCIO, não prova
  | "RISCO"              // cadastrado e válido, e o acervo NÃO sustenta o escopo
  | "NAO_PODE"           // sem cadastro, ou CRC vencido na data da licitação
  | "A_APURAR";          // ninguém perguntou ao acervo por esta família ainda

export interface CondicaoFamilia {
  codigo: string;
  nome: string | null;
  /** Escopo canônico da Petrobras — o gabarito contra o qual o atestado é lido. */
  escopo: string | null;
  grupo: string | null;
  /** Quantos itens desta licitação caem nesta família. */
  itens: number;

  cadastrada: boolean;
  familiaId: string | null;
  statusCadastro: string | null;
  statusFluxoCrc: string | null;
  validadeFim: Date | null;
  /** Dias entre a validade do CRC e a data de referência da licitação. */
  diasDeFolga: number | null;
  /** True quando o CRC vence ANTES da data de referência — o pior caso silencioso. */
  venceAntes: boolean;

  provasConfirmadas: number;
  indicios: number;
  melhorVeredito: string | null;
  justificativa: string | null;
  avaliada: boolean;
  prova: EstadoProva;
  quadrante: Quadrante;

  veredito: VeredictoFamilia;
  /** A frase que explica o veredito. É ela que vai para o PDF. */
  porque: string;
}

export interface CondicaoDeParticipar {
  licitacaoId: string;
  numero: string;
  /** Data contra a qual a validade do CRC é medida (abertura/disputa/fim). */
  dataReferencia: Date | null;
  familias: CondicaoFamilia[];
  /** PIOR caso entre as famílias — habilitação não é média, é elo mais fraco. */
  vereditoGeral: VeredictoFamilia | "SEM_FAMILIA";
  resumo: string;
  /** True quando NENHUMA prova confirmada existe no sistema inteiro. */
  semProvaConfirmadaNoSistema: boolean;
}

/** Ordem de gravidade. Habilitação é elo mais fraco: o pior manda. */
const GRAVIDADE: Record<VeredictoFamilia, number> = {
  NAO_PODE: 0,
  RISCO: 1,
  A_APURAR: 2,
  PODE_COM_RESSALVA: 3,
  PODE: 4,
};

/**
 * O veredito de UMA família. Função pura — testável sem banco, e é onde mora a
 * regra que decide ir ou não ir.
 */
export function vereditoDaFamilia(e: {
  cadastrada: boolean;
  statusCadastro: string | null;
  venceAntes: boolean;
  prova: EstadoProva;
}): { veredito: VeredictoFamilia; porque: string } {
  // 1. Sem cadastro não há habilitação naquela família, ponto. Mas o motivo
  //    muda o que se faz a seguir: com lastro no acervo, é pedido de cadastro;
  //    sem lastro, é parceria ou desistir.
  if (!e.cadastrada) {
    if (e.prova === "COM_PROVA" || e.prova === "COM_INDICIO") {
      return {
        veredito: "NAO_PODE",
        porque:
          "Não estamos cadastrados nesta família — e o acervo sustenta o escopo. " +
          "É candidata a pedido de CRC, não a disputa nesta licitação.",
      };
    }
    return {
      veredito: "NAO_PODE",
      porque:
        e.prova === "SEM_INDICIO"
          ? "Não estamos cadastrados e o acervo foi lido sem encontrar nada que sustente o escopo."
          : "Não estamos cadastrados nesta família e o acervo nunca foi consultado sobre ela.",
    };
  }

  // 2. CRC que vence antes da data manda no resto: estar cadastrado hoje não
  //    habilita numa sessão que acontece depois do vencimento.
  if (e.venceAntes) {
    return {
      veredito: "NAO_PODE",
      porque:
        "Estamos cadastrados, mas o CRC vence ANTES da data de referência desta " +
        "licitação. Sem renovar, a habilitação cai na conferência.",
    };
  }

  if (e.statusCadastro && e.statusCadastro !== "ATIVA") {
    return {
      veredito: "RISCO",
      porque: `Cadastro nesta família está como ${e.statusCadastro}, não ATIVA — confirme no Petronect antes de decidir.`,
    };
  }

  // 3. Cadastrado e válido. O que separa "pode" de "pode torcendo" é o GRAU do
  //    lastro — e hoje o grau máximo disponível é indício.
  switch (e.prova) {
    case "COM_PROVA":
      return {
        veredito: "PODE",
        porque: "Cadastrados, CRC válido na data e com documento do acervo vinculado por uma pessoa.",
      };
    case "COM_INDICIO":
      return {
        veredito: "PODE_COM_RESSALVA",
        porque:
          "Cadastrados e com CRC válido. O acervo aponta documento que sustenta o " +
          "escopo, mas o apontamento é da máquina e NÃO foi revisado — confirme o " +
          "atestado antes de usá-lo como prova na habilitação.",
      };
    case "SEM_INDICIO":
      return {
        veredito: "RISCO",
        porque:
          "Cadastrados, mas o acervo foi lido contra esta família e NADA a sustenta. " +
          "É o cenário de disputar, orçar e cair na habilitação técnica.",
      };
    default:
      return {
        veredito: "A_APURAR",
        porque:
          "Cadastrados, e o acervo nunca foi consultado sobre esta família. Não " +
          "sabemos se temos atestado — o que é diferente de saber que não temos.",
      };
  }
}

/** Data contra a qual a validade do CRC é medida. Espelha resolverDataReferencia. */
function parseData(valor: string | null | undefined): Date | null {
  if (!valor) return null;
  const iso = valor.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`);
    return isNaN(d.getTime()) ? null : d;
  }
  const br = valor.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) {
    const d = new Date(`${br[3]}-${br[2]}-${br[1]}T00:00:00Z`);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

const DIA_MS = 86_400_000;

export async function condicaoDeParticipar(
  licitacaoId: string,
): Promise<CondicaoDeParticipar | null> {
  const cab = (
    (await db.execute(sql`
      SELECT id, numero, data_abertura, data_disputa, data_fim
        FROM licitacoes WHERE id = ${licitacaoId}::uuid LIMIT 1
    `)) as unknown as { rows: Record<string, unknown>[] }
  ).rows?.[0];
  if (!cab) return null;

  const numero = String(cab.numero ?? "");
  const dataReferencia =
    parseData(cab.data_abertura as string) ??
    parseData(cab.data_disputa as string) ??
    parseData(cab.data_fim as string);

  const r = (await db.execute(sql`
    WITH exigidas AS (
      -- As DUAS fontes, unidas: a tabela de itens liga por id e o raspao cru
      -- liga por numero — ha licitacao que so uma das duas enxerga.
      SELECT f_codigo_crc(i.familia) AS cod, count(*)::int AS n
        FROM itens i
       WHERE i.licitacao_id = ${licitacaoId}::uuid
         AND f_codigo_crc(i.familia) IS NOT NULL
       GROUP BY 1
      UNION ALL
      SELECT f_codigo_crc(p.family), count(*)::int
        FROM petronect_lic_items p
       WHERE p.numero = ${numero}
         AND f_codigo_crc(p.family) IS NOT NULL
       GROUP BY 1
    ),
    fam AS (SELECT cod, sum(n)::int AS itens FROM exigidas GROUP BY cod),
    cadastro AS (
      SELECT f.*, f_codigo_crc(f.codigo_crc) AS chave
        FROM familias f WHERE f.deletado_em IS NULL
    ),
    provas AS (
      -- Só vínculo confirmado por PESSOA conta como prova. 0034/S15: documento
      -- restrito não entra numa visão que pode virar anexo de proposta.
      SELECT df.familia_id, count(*)::int AS n
        FROM documentos_familias df
        JOIN documentos_habilitacao d ON d.id = df.documento_id
       WHERE d.restrito = false
       GROUP BY 1
    ),
    indicios AS (
      SELECT fc.familia_codigo AS cod,
             count(DISTINCT fc.documento_id)::int AS n,
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
         AND fc.veredito <> 'NAO'
       GROUP BY 1
    ),
    avaliadas AS (SELECT DISTINCT familia_codigo AS cod FROM familias_classificacao_escopo)
    SELECT fam.cod                       AS "codigo",
           fam.itens                     AS "itens",
           coalesce(cad.nome, c.nome)    AS "nome",
           c.escopo                      AS "escopo",
           c.grupo                       AS "grupo",
           cad.id                        AS "familiaId",
           (cad.id IS NOT NULL)          AS "cadastrada",
           cad.status                    AS "statusCadastro",
           cad.status_fluxo_crc          AS "statusFluxoCrc",
           cad.validade_fim              AS "validadeFim",
           coalesce(p.n, 0)              AS "provasConfirmadas",
           coalesce(i.n, 0)              AS "indicios",
           i.melhor                      AS "melhorVeredito",
           i.razao                       AS "justificativa",
           (av.cod IS NOT NULL)          AS "avaliada"
      FROM fam
      LEFT JOIN familias_catalogo c ON c.codigo = fam.cod
      LEFT JOIN cadastro cad        ON cad.chave = fam.cod
      LEFT JOIN provas p            ON p.familia_id = cad.id
      LEFT JOIN indicios i          ON i.cod = fam.cod
      LEFT JOIN avaliadas av        ON av.cod = fam.cod
     ORDER BY fam.itens DESC, fam.cod
  `)) as unknown as { rows: Record<string, unknown>[] };

  const familias: CondicaoFamilia[] = (r.rows ?? []).map((row) => {
    const provasConfirmadas = Number(row.provasConfirmadas ?? 0);
    const indicios = Number(row.indicios ?? 0);
    const avaliada = Boolean(row.avaliada);
    const cadastrada = Boolean(row.cadastrada);
    const validadeFim = row.validadeFim ? new Date(row.validadeFim as string) : null;

    // Folga medida contra a DATA DA LICITAÇÃO, não contra hoje: um CRC válido
    // hoje e vencido na sessão não habilita ninguém, e é o erro que passa
    // despercebido justamente porque a tela de cadastro diz "ATIVA".
    const diasDeFolga =
      validadeFim && dataReferencia
        ? Math.floor((validadeFim.getTime() - dataReferencia.getTime()) / DIA_MS)
        : null;
    const venceAntes = diasDeFolga != null && diasDeFolga < 0;

    const prova = estadoProva(provasConfirmadas, indicios, avaliada);
    const { veredito, porque } = vereditoDaFamilia({
      cadastrada,
      statusCadastro: (row.statusCadastro as string | null) ?? null,
      venceAntes,
      prova,
    });

    return {
      codigo: String(row.codigo),
      nome: (row.nome as string | null) ?? null,
      escopo: (row.escopo as string | null) ?? null,
      grupo: (row.grupo as string | null) ?? null,
      itens: Number(row.itens ?? 0),
      cadastrada,
      familiaId: (row.familiaId as string | null) ?? null,
      statusCadastro: (row.statusCadastro as string | null) ?? null,
      statusFluxoCrc: (row.statusFluxoCrc as string | null) ?? null,
      validadeFim,
      diasDeFolga,
      venceAntes,
      provasConfirmadas,
      indicios,
      melhorVeredito: (row.melhorVeredito as string | null) ?? null,
      justificativa: (row.justificativa as string | null) ?? null,
      avaliada,
      prova,
      quadrante: quadranteDe(cadastrada, prova),
      veredito,
      porque,
    };
  });

  const totalProvas = (
    (await db.execute(sql`SELECT count(*)::int AS n FROM documentos_familias`)) as unknown as {
      rows: { n: number }[];
    }
  ).rows?.[0]?.n;

  return {
    licitacaoId,
    numero,
    dataReferencia,
    familias,
    vereditoGeral: resumirVeredito(familias),
    resumo: montarResumo(familias),
    semProvaConfirmadaNoSistema: Number(totalProvas ?? 0) === 0,
  };
}

/** O pior veredito entre as famílias. Pura, testável sem banco. */
export function resumirVeredito(
  familias: Pick<CondicaoFamilia, "veredito">[],
): VeredictoFamilia | "SEM_FAMILIA" {
  if (familias.length === 0) return "SEM_FAMILIA";
  return familias.reduce<VeredictoFamilia>(
    (pior, f) => (GRAVIDADE[f.veredito] < GRAVIDADE[pior] ? f.veredito : pior),
    "PODE",
  );
}

/** A frase de abertura da seção. Pura. */
export function montarResumo(familias: Pick<CondicaoFamilia, "veredito" | "codigo">[]): string {
  if (familias.length === 0) {
    return (
      "Nenhuma família CRC identificada para esta licitação. Sem família não há " +
      "como afirmar nem negar habilitação — confirme no edital qual família o " +
      "cliente exige."
    );
  }
  const conta = (v: VeredictoFamilia) => familias.filter((f) => f.veredito === v).length;
  const partes: string[] = [];
  // [singular, plural] — o resumo vai num documento que gente lê, e "1
  // sustentadas por indício" é o tipo de descuido que faz o leitor duvidar do
  // resto do número.
  const rotulos: [VeredictoFamilia, string, string][] = [
    ["PODE",              "com prova confirmada",           "com prova confirmada"],
    ["PODE_COM_RESSALVA", "sustentada por indício",         "sustentadas por indício"],
    ["RISCO",             "sem lastro no acervo",           "sem lastro no acervo"],
    ["NAO_PODE",          "sem cadastro ou com CRC vencido", "sem cadastro ou com CRC vencido"],
    ["A_APURAR",          "nunca avaliada",                 "nunca avaliadas"],
  ];
  for (const [v, singular, plural] of rotulos) {
    const n = conta(v);
    if (n > 0) partes.push(`${n} ${n === 1 ? singular : plural}`);
  }
  const n = familias.length;
  return `${n} família${n !== 1 ? "s" : ""} CRC exigida${n !== 1 ? "s" : ""} por esta licitação: ${partes.join(" · ")}.`;
}
