/**
 * Funções puras da ficha da operação (WP-11 — 03-FRONTEND §5.3).
 *
 * Tudo o que a ficha calcula sobre o payload de R3 mora aqui, sem React e sem
 * rede, porque a mesma aritmética tem contrato com o servidor em dois pontos:
 *  - `contadoresBarra` reproduz os agregados de R1 (queries.ts, CONTA_NA_BARRA)
 *    — a barra da ficha e a coluna do índice NÃO podem divergir;
 *  - `fatiarParaDownload` respeita os tetos de R12 (bulk-download) — um bloco
 *    errado aqui vira 422 no servidor.
 * As tuplas de domínio (seções, situações, fallback por papel) vêm de
 * `@/lib/conformidade/operacoes` — aqui só se DERIVA, nunca se redeclara.
 */

import {
  SECOES_FICHA,
  SITUACOES_QUE_CONTAM,
  secaoDoDocumento,
  type Detentora,
  type PapelDocumento,
  type SituacaoProva,
  type TipoDocumento,
} from "@/lib/conformidade/operacoes";
import type { StatusDocHab } from "@/components/conformidade/cofre/StatusDocumentoBadge";

// ── Tipos consumidos (item de `documentos` em R3 — 03-FRONTEND §5.1) ─────────

export interface DocDossie {
  id: string;
  titulo: string;
  /** NULL nos legados pré-backfill: a seção sai do fallback por papel. */
  papel: PapelDocumento | null;
  tipoDocumento: TipoDocumento | null;
  situacaoProva: SituacaoProva | null;
  /** Detentora do DOCUMENTO — pode divergir da operação (marca anti-falso-positivo). */
  detentora: Detentora | null;
  restrito: boolean;
  subcategoria: string;
  nomeArquivo: string;
  tamanhoBytes: number | null;
  contentType: string | null;
  versao: number;
  /**
   * 0044 (B6): a revisão carimbada pela engenharia ("R0", "R1", "02A").
   * OPCIONAL — a fábrica `doc()` de `ficha-secoes.test.ts` preenche todos os
   * obrigatórios à mão, e um campo novo obrigatório aqui quebraria a
   * compilação do teste (spec ONDA-5 §1i). Lido com `?? null`. Não é `versao`:
   * aquela é o versionamento de certidão do cofre (§1h).
   */
  revisao?: string | null;
  numeroDocumento: string | null;
  /** Coluna `date`: "AAAA-MM-DD" — é a chave das ordenações por emissão. */
  emitidoEm: string | null;
  validadeFim: string | null;
  status: StatusDocHab;
  sha256: string;
  origemPath: string | null;
  familias: Array<{ id: string; codigo: string }>;
  criadoEm: string;
  /**
   * 0043 — a disciplina que o documento prova. OPCIONAIS: a fábrica `doc()` de
   * `ficha-secoes.test.ts` preenche todos os campos obrigatórios à mão, e um
   * campo novo obrigatório aqui quebraria a compilação do teste (spec ONDA-4
   * §1f). Lidos com `?? null`. Nenhuma função deste arquivo os usa — a
   * disciplina do documento aparece na gaveta, não na montagem das seções.
   */
  disciplinaId?: string | null;
  disciplina?: { id: string; codigo: string; nome: string } | null;
}

// ── Barra de comprovação (§2.5 — espelho client do CONTA_NA_BARRA de R1) ─────

export interface DocParaBarra {
  tipoDocumento: TipoDocumento | null;
  papel: PapelDocumento | null;
  situacaoProva: SituacaoProva | null;
}

/**
 * NULL conta (legado/não avaliada); RASCUNHO/SUPERADA/CANCELADA/MODELO não.
 * Derivado de SITUACOES_QUE_CONTAM (lib) — a MESMA lista do SQL de R1.
 */
export function contaNaBarra(d: DocParaBarra): boolean {
  return d.situacaoProva === null || SITUACOES_QUE_CONTAM.includes(d.situacaoProva);
}

export interface ContadoresBarra {
  atestados: number;
  artCat: number;
  contratos: number;
  total: number;
  /** Documentos fora da barra — o "(5 rascunhos/superadas não contam)" do cabeçalho. */
  naoContam: number;
}

/**
 * Reproduz exatamente os FILTER de `contagensPorOperacao` (R1): tipo quando
 * existe, papel como fallback dos legados com tipo NULL. Se a fixture divergir
 * do que R1 devolve, o teste de unidade quebra — é contrato, não conveniência.
 */
export function contadoresBarra(docs: readonly DocParaBarra[]): ContadoresBarra {
  let atestados = 0;
  let artCat = 0;
  let contratos = 0;
  let naoContam = 0;

  for (const d of docs) {
    if (!contaNaBarra(d)) {
      naoContam++;
      continue;
    }
    const t = d.tipoDocumento;
    if (t === "ATESTADO" || (t === null && d.papel === "ATESTADO")) atestados++;
    if (t === "ART" || t === "CAT" || (t === null && d.papel === "CAT_ART")) artCat++;
    if (
      t === "CONTRATO" || t === "ADITIVO" || t === "ANEXO_CONTRATO" ||
      (t === null && (d.papel === "CONTRATO" || d.papel === "ADITIVO"))
    ) {
      contratos++;
    }
  }

  return { atestados, artCat, contratos, total: docs.length, naoContam };
}

// ── Normalização de busca (índice §4.4 e filtro local da ficha §5.9) ─────────

/** Sem acento, sem caixa — "Acme" casa "ACME SIDERURGIA". */
export function normalizarBusca(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// ── Datas e período ──────────────────────────────────────────────────────────

/**
 * O catálogo só tem ANO de início/fim, e em muitas operações nem isso —
 * por isso as quatro combinações têm texto próprio em vez de um "—" mudo.
 * (Movida da page antiga; o índice também a consome — §4.5.)
 */
export function formatarPeriodo(inicio: string | null, fim: string | null): string | null {
  if (inicio && fim) return `${formatarDataCurta(inicio)} → ${formatarDataCurta(fim)}`;
  if (inicio) return `desde ${formatarDataCurta(inicio)}`;
  if (fim) return `até ${formatarDataCurta(fim)}`;
  return null;
}

/**
 * "AAAA-MM-DD" → "DD/MM/AAAA" sem passar por `Date` (que aplicaria fuso e
 * empurraria 01/01 para 31/12 do ano anterior em GMT-3).
 */
function formatarDataCurta(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

// ── Ano da prova (fitas da seção 3) ──────────────────────────────────────────

const ANO_REGEX = /(?:19|20)\d{2}/;

/**
 * year(emitidoEm) ?? primeiro ano em numeroDocumento ?? em titulo ?? "sem ano".
 * O número de ART carrega o ano embutido ("BA20250000001" → 2025), então a
 * fita certa sai mesmo quando `emitidoEm` está vazio.
 */
export function anoDaProva(d: Pick<DocDossie, "emitidoEm" | "numeroDocumento" | "titulo">): string {
  if (d.emitidoEm) {
    const m = /^(\d{4})/.exec(d.emitidoEm);
    if (m) return m[1];
  }
  const doNumero = d.numeroDocumento ? ANO_REGEX.exec(d.numeroDocumento) : null;
  if (doNumero) return doNumero[0];
  const doTitulo = ANO_REGEX.exec(d.titulo);
  if (doTitulo) return doTitulo[0];
  return "sem ano";
}

// ── Número do aditivo (ordem da seção 1) ─────────────────────────────────────

/**
 * Ordinais por extenso, do maior para o menor comprimento: "DECIMO SETIMO" tem
 * de casar antes de "DECIMO", senão todo aditivo composto viraria o 10º.
 * Tabela fechada em 20 — contrato com mais de vinte aditivos é caso raro.
 */
const ORDINAIS: ReadonlyArray<readonly [string, number]> = [
  ["DECIMO PRIMEIRO", 11], ["DECIMO SEGUNDO", 12], ["DECIMO TERCEIRO", 13],
  ["DECIMO QUARTO", 14], ["DECIMO QUINTO", 15], ["DECIMO SEXTO", 16],
  ["DECIMO SETIMO", 17], ["DECIMO OITAVO", 18], ["DECIMO NONO", 19],
  ["VIGESIMO", 20], ["PRIMEIRO", 1], ["SEGUNDO", 2], ["TERCEIRO", 3],
  ["QUARTO", 4], ["QUINTO", 5], ["SEXTO", 6], ["SETIMO", 7],
  ["OITAVO", 8], ["NONO", 9], ["DECIMO", 10],
];

/**
 * "3º ADITIVO" → 3; "DÉCIMO SÉTIMO ADITIVO" → 17; sem menção → null.
 * `null` também é informação: é o que separa o contrato-raiz dos aditivos na
 * ordenação da seção 1.
 */
export function numeroAditivo(titulo: string): number | null {
  const norm = titulo
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();

  const numerico = /(\d+)\s*[ºO°]?\s*ADITIVO/.exec(norm);
  if (numerico) return parseInt(numerico[1], 10);

  for (const [extenso, valor] of ORDINAIS) {
    if (new RegExp(`\\b${extenso}\\s+ADITIVO`).test(norm)) return valor;
  }
  return null;
}

// ── Montagem das seções ──────────────────────────────────────────────────────

export interface FitaSub {
  chave: string;
  rotulo: string;
  docs: DocDossie[];
}

export interface SecaoMontada {
  numero: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  nome: string;
  slug: string;
  /** Ordem final da seção (fitas achatadas, quando houver). */
  docs: DocDossie[];
  /** Só seções 3 (por ano) e 7 (por tipo). */
  fitas: FitaSub[] | null;
  naoContam: number;
  /** Seção 1 com ≥2 docs e nenhum `emitidoEm`: a ordem exibida é palpite. */
  ordemProvisoria: boolean;
}

/** Seção de UM documento — açúcar sobre o de-para canônico da lib. */
export function secaoDaFicha(d: Pick<DocDossie, "tipoDocumento" | "papel">): number {
  return secaoDoDocumento(d.tipoDocumento, d.papel);
}

/** Comparadores auxiliares: ISO ("AAAA-MM-DD"/timestamptz) compara léxico. */
function ascNulosAoFim(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}
function descNulosAoFim(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a > b ? -1 : a < b ? 1 : 0;
}
function porTitulo(a: DocDossie, b: DocDossie): number {
  return a.titulo.localeCompare(b.titulo, "pt-BR", { numeric: true });
}

/** Ordem das fitas da seção 7 e seus rótulos (§5.3, linha 7 da tabela). */
const FITAS_SECAO_7: ReadonlyArray<readonly [TipoDocumento, string]> = [
  ["PEDIDO", "Pedidos de compra"], ["NF", "Notas fiscais"], ["CARTA", "Cartas"],
  ["RELATORIO", "Relatórios"], ["PESSOAL", "RH"], ["CAPA_OP", "Capas de operação"],
];

/**
 * Baldeia o dossiê inteiro nas 9 seções, cada uma com o comparator da tabela
 * §5.3, e devolve SÓ as não vazias (vazio esperado/opcional é decisão da tela,
 * não deste módulo). É função pura: mesmo payload, mesmas seções — é ela que
 * carrega o teste.
 */
export function montarSecoes(docs: readonly DocDossie[]): SecaoMontada[] {
  const baldes = new Map<number, DocDossie[]>();
  for (const d of docs) {
    const n = secaoDaFicha(d);
    const balde = baldes.get(n);
    if (balde) balde.push(d);
    else baldes.set(n, [d]);
  }

  const secoes: SecaoMontada[] = [];

  for (let numero = 1; numero <= 9; numero++) {
    const doBalde = baldes.get(numero);
    if (!doBalde || doBalde.length === 0) continue;

    let ordenados: DocDossie[] = [...doBalde];
    let fitas: FitaSub[] | null = null;

    switch (numero) {
      case 1: {
        // Contrato-raiz primeiro (tipo CONTRATO sem nº de aditivo no título);
        // depois emissão ASC, aditivo ASC, criação ASC.
        ordenados.sort((a, b) => {
          const raizA = a.tipoDocumento === "CONTRATO" && numeroAditivo(a.titulo) === null ? 0 : 1;
          const raizB = b.tipoDocumento === "CONTRATO" && numeroAditivo(b.titulo) === null ? 0 : 1;
          if (raizA !== raizB) return raizA - raizB;
          const porEmissao = ascNulosAoFim(a.emitidoEm, b.emitidoEm);
          if (porEmissao !== 0) return porEmissao;
          const adA = numeroAditivo(a.titulo) ?? Number.POSITIVE_INFINITY;
          const adB = numeroAditivo(b.titulo) ?? Number.POSITIVE_INFINITY;
          if (adA !== adB) return adA < adB ? -1 : 1;
          return ascNulosAoFim(a.criadoEm, b.criadoEm);
        });
        break;
      }
      case 2: {
        ordenados.sort((a, b) => descNulosAoFim(a.emitidoEm, b.emitidoEm) || porTitulo(a, b));
        break;
      }
      case 3: {
        // Fitas por ano DESC ("sem ano" por último); dentro, nº DESC, título.
        const porAno = new Map<string, DocDossie[]>();
        for (const d of ordenados) {
          const ano = anoDaProva(d);
          const fita = porAno.get(ano);
          if (fita) fita.push(d);
          else porAno.set(ano, [d]);
        }
        fitas = Array.from(porAno.entries())
          .sort(([a], [b]) => {
            if (a === "sem ano") return 1;
            if (b === "sem ano") return -1;
            return b.localeCompare(a);
          })
          .map(([ano, docsDoAno]) => ({
            chave: ano,
            rotulo: ano === "sem ano" ? "Sem ano identificado" : ano,
            docs: docsDoAno.sort(
              (a, b) =>
                descNulosAoFim(a.numeroDocumento, b.numeroDocumento) || porTitulo(a, b)
            ),
          }));
        ordenados = fitas.flatMap((f) => f.docs);
        break;
      }
      case 4: {
        ordenados.sort((a, b) => ascNulosAoFim(a.validadeFim, b.validadeFim) || porTitulo(a, b));
        break;
      }
      case 5: {
        ordenados.sort((a, b) => descNulosAoFim(a.emitidoEm, b.emitidoEm) || porTitulo(a, b));
        break;
      }
      case 6: {
        ordenados.sort(porTitulo);
        break;
      }
      case 7: {
        // Fitas na ordem fixa PEDIDO→CAPA_OP; tipo NULL aqui é sempre o legado
        // com papel NOTA_FISCAL (único caminho do fallback para a 7) → fita NF.
        fitas = [];
        for (const [tipo, rotulo] of FITAS_SECAO_7) {
          const docsDaFita = ordenados
            .filter((d) => d.tipoDocumento === tipo || (d.tipoDocumento === null && tipo === "NF"))
            .sort((a, b) => descNulosAoFim(a.emitidoEm, b.emitidoEm) || porTitulo(a, b));
          if (docsDaFita.length > 0) fitas.push({ chave: tipo, rotulo, docs: docsDaFita });
        }
        ordenados = fitas.flatMap((f) => f.docs);
        break;
      }
      case 8: {
        ordenados.sort((a, b) => (b.tamanhoBytes ?? 0) - (a.tamanhoBytes ?? 0) || porTitulo(a, b));
        break;
      }
      default: {
        ordenados.sort((a, b) => descNulosAoFim(a.criadoEm, b.criadoEm) || porTitulo(a, b));
      }
    }

    secoes.push({
      numero: numero as SecaoMontada["numero"],
      nome: SECOES_FICHA[numero].nome,
      slug: SECOES_FICHA[numero].slug,
      docs: ordenados,
      fitas,
      naoContam: ordenados.filter((d) => !contaNaBarra(d)).length,
      ordemProvisoria:
        numero === 1 && ordenados.length >= 2 && ordenados.every((d) => d.emitidoEm === null),
    });
  }

  return secoes;
}

// ── Linha do tempo da operação (D9 — spec ONDA-5 §4.4) ──────────────────────

/** Um marco da linha do tempo. `documentoId` null só nos dois marcos de período. */
export interface EventoTimeline {
  /** id estável para `key` do React: `doc:<uuid>` ou `periodo:inicio` / `periodo:fim`. */
  chave: string;
  /** "AAAA-MM-DD" — NUNCA null aqui: evento sem data não entra em `eventos`. */
  data: string;
  tipo: "PERIODO_INICIO" | "PERIODO_FIM" | "CONTRATO" | "ADITIVO" | "ATESTADO" | "CAT_ART";
  rotulo: string;
  documentoId: string | null;
  /** Só em ADITIVO: 3 para "3º ADITIVO" (de `numeroAditivo`); null quando o título não diz. */
  numeroAditivo: number | null;
  /** `contaNaBarra(d) === false` — o marco aparece vazado, e a legenda conta. */
  naoConta: boolean;
}

export interface TimelineOperacao {
  /** Em ordem: data ASC, depois a ordem canônica do tipo, depois id. */
  eventos: EventoTimeline[];
  /** Extremos do eixo — null quando não há nenhum evento datado. */
  inicio: string | null;
  fim: string | null;
  /** Peças das seções 1/2/3 SEM data utilizável: contadas e rotuladas, nunca posicionadas. */
  semData: Array<{ documentoId: string; titulo: string; ano: string; tipo: EventoTimeline["tipo"] }>;
  /** Peças fora do recorte (seções 4..9): só o número, para a legenda fechar. */
  foraDaLinha: number;
}

/**
 * Ordem canônica dos marcos DENTRO do mesmo dia: o período abre, o contrato
 * vem antes dos aditivos que o alteram, o atestado prova o que foi feito e a
 * CAT/ART registra a prova; o fim do período fecha. É só desempate — a ordem
 * do eixo é sempre a data (spec ONDA-5 §4.4, regra 6).
 */
const RANK_TIPO_TIMELINE: Record<EventoTimeline["tipo"], number> = {
  PERIODO_INICIO: 0,
  CONTRATO: 1,
  ADITIVO: 2,
  ATESTADO: 3,
  CAT_ART: 4,
  PERIODO_FIM: 5,
};

const DATA_DO_EIXO_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * "AAAA-MM-DD" quando a data POSICIONA, senão null. `emitidoEm` é coluna
 * `date` e chega "2019-05-02" na ficha, mas o mesmo campo trafega como ISO com
 * hora ("2019-05-02T00:00:00.000Z") por outros caminhos: cortar em 10 é o que
 * faz as duas formas caírem no MESMO eixo. Formato de gente ("02/05/2019") não
 * vira palpite — o documento cai em `semData` (regra 3).
 */
function dataDoEixo(valor: string | null): string | null {
  if (!valor) return null;
  const cortada = valor.slice(0, 10);
  return DATA_DO_EIXO_REGEX.test(cortada) ? cortada : null;
}

/**
 * O tipo do marco DERIVA da seção, que já é o de-para canônico (tipo primeiro,
 * papel como fallback dos legados) — nenhuma tupla nova e nenhum `Record` de
 * tipo novo. Seção 2 é atestado, seção 3 é CAT/ART, e dentro da seção 1 só o
 * aditivo se separa: ANEXO_CONTRATO é lastro do contrato e entra como ele,
 * porque a história que a linha conta é "contrato → aditivos".
 */
function tipoDoMarco(
  d: Pick<DocDossie, "tipoDocumento" | "papel">,
  secao: number
): EventoTimeline["tipo"] {
  if (secao === 2) return "ATESTADO";
  if (secao === 3) return "CAT_ART";
  if (d.tipoDocumento === "ADITIVO" || (d.tipoDocumento === null && d.papel === "ADITIVO")) {
    return "ADITIVO";
  }
  return "CONTRATO";
}

/**
 * D9 — "contrato → aditivos → atestado → CAT", que é a história que a ficha
 * conta hoje espalhada por três seções.
 *
 * Três decisões que o teste trava (spec ONDA-5 §4.4):
 *  - o recorte são as seções 1/2/3; o resto NÃO some — vira `foraDaLinha`, um
 *    número, porque toda peça contada tem de aparecer em algum lugar da
 *    legenda (Q4);
 *  - `anoDaProva()` NÃO posiciona nada. Ela adivinha o ano pelo número da ART
 *    ("BA20250000001" → 2025) e pelo título: ótimo para ROTULAR uma fita,
 *    mentira se virasse coordenada no eixo. Documento sem `emitidoEm`
 *    utilizável vai para `semData`, com o ano só como rótulo da lista;
 *  - RASCUNHO/SUPERADA/CANCELADA/MODELO APARECEM (é história), vazados por
 *    `naoConta` — escondê-los faria a linha contar uma história diferente da
 *    barra de comprovação logo acima dela.
 */
export function montarTimeline(
  docs: readonly DocDossie[],
  periodoInicio: string | null,
  periodoFim: string | null
): TimelineOperacao {
  const eventos: EventoTimeline[] = [];
  const semData: TimelineOperacao["semData"] = [];
  let foraDaLinha = 0;

  for (const d of docs) {
    const secao = secaoDaFicha(d);
    if (secao !== 1 && secao !== 2 && secao !== 3) {
      foraDaLinha++;
      continue;
    }

    const tipo = tipoDoMarco(d, secao);
    const data = dataDoEixo(d.emitidoEm);

    if (data === null) {
      semData.push({ documentoId: d.id, titulo: d.titulo, ano: anoDaProva(d), tipo });
      continue;
    }

    eventos.push({
      chave: `doc:${d.id}`,
      data,
      tipo,
      rotulo: d.titulo,
      documentoId: d.id,
      numeroAditivo: tipo === "ADITIVO" ? numeroAditivo(d.titulo) : null,
      naoConta: !contaNaBarra(d),
    });
  }

  // Os dois marcos do período são o eixo em que os documentos se penduram —
  // sem eles a linha é só o intervalo entre a primeira e a última emissão.
  const inicioPeriodo = dataDoEixo(periodoInicio);
  if (inicioPeriodo !== null) {
    eventos.push({
      chave: "periodo:inicio",
      data: inicioPeriodo,
      tipo: "PERIODO_INICIO",
      rotulo: "Início do período",
      documentoId: null,
      numeroAditivo: null,
      naoConta: false,
    });
  }
  const fimPeriodo = dataDoEixo(periodoFim);
  if (fimPeriodo !== null) {
    eventos.push({
      chave: "periodo:fim",
      data: fimPeriodo,
      tipo: "PERIODO_FIM",
      rotulo: "Fim do período",
      documentoId: null,
      numeroAditivo: null,
      naoConta: false,
    });
  }

  // Determinística até o último desempate: três peças do mesmo dia saem sempre
  // na mesma ordem, e rodar a função duas vezes devolve o mesmo array.
  eventos.sort((a, b) => {
    if (a.data !== b.data) return a.data < b.data ? -1 : 1;
    const rank = RANK_TIPO_TIMELINE[a.tipo] - RANK_TIPO_TIMELINE[b.tipo];
    if (rank !== 0) return rank;
    const adA = a.numeroAditivo ?? Number.POSITIVE_INFINITY;
    const adB = b.numeroAditivo ?? Number.POSITIVE_INFINITY;
    if (adA !== adB) return adA < adB ? -1 : 1;
    const idA = a.documentoId ?? "";
    const idB = b.documentoId ?? "";
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  });

  return {
    eventos,
    inicio: eventos.length > 0 ? eventos[0].data : null,
    fim: eventos.length > 0 ? eventos[eventos.length - 1].data : null,
    semData,
    foraDaLinha,
  };
}

// ── Tetos de download e fatiamento (§5.6 — contrato com R12) ─────────────────

/** Tetos REAIS do servidor (bulk-download/route.ts): pré-checagem é conforto. */
export const LIMITE_ZIP_DOCS = 100;
export const LIMITE_ZIP_BYTES = 200 * 1024 * 1024;
/** Margem de 10% sob o teto de bytes ao fatiar — nulos contam 0 e o ZIP comprime. */
export const MARGEM_ZIP_BYTES = 180 * 1024 * 1024;

export function somaBytes(docs: ReadonlyArray<Pick<DocDossie, "tamanhoBytes">>): number {
  return docs.reduce((acc, d) => acc + (d.tamanhoBytes ?? 0), 0);
}

/** O conjunto estoura ALGUM teto de R12? (dossiê inteiro ou uma seção) */
export function estouraTetoZip(
  docs: ReadonlyArray<Pick<DocDossie, "tamanhoBytes">>
): boolean {
  return docs.length > LIMITE_ZIP_DOCS || somaBytes(docs) > LIMITE_ZIP_BYTES;
}

/**
 * Fatia uma seção que estoura teto em blocos de ids para K chamadas de R12 com
 * recorte `{operacaoId, secao, ids}`. A ordem é a ESTÁVEL de R12
 * (`criado_em ASC, id ASC`) — não a ordem de exibição da ficha — para que cada
 * parte corresponda a uma faixa contígua do que o servidor enumeraria.
 * Guloso: fecha o bloco ao bater 100 docs OU 180 MB; documento sozinho maior
 * que a margem ganha bloco próprio (o servidor decide se aceita).
 */
export function fatiarParaDownload(
  docs: ReadonlyArray<Pick<DocDossie, "id" | "criadoEm" | "tamanhoBytes">>,
  maxDocs: number = LIMITE_ZIP_DOCS,
  maxBytes: number = MARGEM_ZIP_BYTES
): string[][] {
  const ordenados = [...docs].sort((a, b) => {
    if (a.criadoEm !== b.criadoEm) return a.criadoEm < b.criadoEm ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const blocos: string[][] = [];
  let bloco: string[] = [];
  let bytes = 0;

  for (const d of ordenados) {
    const tamanho = d.tamanhoBytes ?? 0;
    if (bloco.length > 0 && (bloco.length >= maxDocs || bytes + tamanho > maxBytes)) {
      blocos.push(bloco);
      bloco = [];
      bytes = 0;
    }
    bloco.push(d.id);
    bytes += tamanho;
  }
  if (bloco.length > 0) blocos.push(bloco);

  return blocos;
}

// ── Filtro pré-preenchido da gaveta de adoção (§5.10) ────────────────────────

/** Palavras que não identificam cliente nenhum — razão social é cheia delas. */
const STOPLIST_CLIENTE = new Set([
  "S.A.", "S/A", "SA", "LTDA", "EIRELI", "DO", "DA", "DE", "DOS", "DAS",
  "E", "THE", "BRASIL", "COMPANY",
]);

/**
 * Primeiro token significativo do nome do cliente ("ZYX BRASIL" → "ZYX",
 * "ACME SIDERURGIA" → "ACME"). Preferência por token com ≥4 letras (regra da
 * spec); sem nenhum, aceita ≥2 fora da stoplist — sem esse relaxamento, "ZYX"
 * (3 letras, o exemplo canônico da própria spec) sairia vazio.
 */
export function tokenSignificativo(clienteNome: string): string {
  const tokens = clienteNome
    .split(/\s+/)
    .map((t) => t.replace(/[(),;]/g, ""))
    .filter((t) => t.length > 0 && !STOPLIST_CLIENTE.has(t.toUpperCase()));

  const longo = tokens.find((t) => t.length >= 4);
  if (longo) return longo;
  return tokens.find((t) => t.length >= 2) ?? "";
}

// ── Formatação de tamanho (linha do documento) ───────────────────────────────

export function formatarTamanhoBytes(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1).replace(".", ",")} MB`;
}
