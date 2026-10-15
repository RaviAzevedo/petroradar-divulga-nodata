/**
 * Estado, palpites e envio do lote — tela "Subir provas da operação".
 *
 * Mora fora do componente a parte que dá pra ler sem React: montar a linha de um
 * arquivo, adivinhar subcategoria/papel pelo nome, validar campo a campo, montar
 * o multipart e subir com limite de paralelismo.
 *
 * O que NÃO mora aqui, de propósito:
 *  - a decisão "isto é duplicata / versão / irmão / anexo": é do domínio
 *    compartilhado `@/lib/conformidade/operacoes`, porque o servidor precisa
 *    chegar na MESMA resposta que a tela;
 *  - as listas de categoria/subcategoria: vêm de
 *    `@/lib/conformidade/cofre/validations`, que é a fonte que o zod do POST usa.
 *    A versão anterior desta tela mantinha uma cópia à mão dessas listas e ela já
 *    estava defasada (faltavam subcategorias que o backend aceita).
 */

import type { CategoriaDocHab, SubcategoriaDocHab } from "@/db/schema";
import {
  CATEGORIA_LABELS,
  SUBCATEGORIA_TO_CATEGORIA,
} from "@/lib/conformidade/cofre/validations";
import {
  extrairValidadeDoNome,
  inferirDestino,
} from "@/lib/conformidade/inferir-categoria";
import {
  SITUACOES_QUE_CONTAM,
  tituloSugerido,
  type ArquivoDoLote,
  type Detentora,
  type PapelDocumento,
  type SituacaoProva,
  type TipoDocumento,
} from "@/lib/conformidade/operacoes";

// ── Operação escolhida no topo da tela ───────────────────────────────────────

/** Item de GET /api/conformidade/operacoes (e o que o POST de cadastro devolve). */
export interface OperacaoResumo {
  id: string;
  codigo: string;
  clienteNome: string;
  clienteGrupo: string | null;
  contratoNumero: string | null;
  unidade: string | null;
  detentora: Detentora;
  /** Quantas provas a operação já tem no cofre — o "3 provas já no cofre" do topo. */
  totalDocumentos: number;
  totalAtestados: number;
}

export interface RespostaOperacoes {
  operacoes: OperacaoResumo[];
  total: number;
}

/**
 * Detalhe de GET /api/conformidade/operacoes/{id} (R3) — só o que esta tela
 * usa. Serve à chegada por link (`?operacaoId=…`): o dossiê manda para cá e a
 * operação nasce travada no topo sem o usuário buscar de novo.
 */
export interface DocumentoDoDossie {
  tipoDocumento: TipoDocumento | null;
  papel: PapelDocumento | null;
  situacaoProva: SituacaoProva | null;
}

export interface OperacaoDetalhe {
  id: string;
  codigo: string;
  clienteNome: string;
  clienteGrupo: string | null;
  contratoNumero: string | null;
  unidade: string | null;
  detentora: Detentora;
  documentos: DocumentoDoDossie[];
}

/** A prova conta na barra de comprovação? NULL conta (regra do 00-ARQUITETURA §1.2). */
function contaNaBarra(situacao: SituacaoProva | null): boolean {
  return situacao === null || SITUACOES_QUE_CONTAM.includes(situacao);
}

/**
 * Converte o detalhe (R3) no resumo que o `SeletorOperacao` exibe. O contador
 * de atestados repete a regra do servidor em R1: tipo ATESTADO — ou papel
 * ATESTADO nos legados sem tipo — e só quem conta na barra (rascunho,
 * superada, cancelada e modelo ficam de fora).
 */
export function operacaoResumoDoDetalhe(detalhe: OperacaoDetalhe): OperacaoResumo {
  const totalAtestados = detalhe.documentos.filter(
    (d) =>
      contaNaBarra(d.situacaoProva) &&
      (d.tipoDocumento === "ATESTADO" ||
        (d.tipoDocumento === null && d.papel === "ATESTADO"))
  ).length;

  return {
    id: detalhe.id,
    codigo: detalhe.codigo,
    clienteNome: detalhe.clienteNome,
    clienteGrupo: detalhe.clienteGrupo,
    contratoNumero: detalhe.contratoNumero,
    unidade: detalhe.unidade,
    detentora: detalhe.detentora,
    totalDocumentos: detalhe.documentos.length,
    totalAtestados,
  };
}

/** Item de GET /api/conformidade/cofre/documentos?operacaoId=… (só o que a tela usa). */
export interface DocumentoDaOperacao {
  id: string;
  titulo: string;
  operacaoId: string | null;
  numeroDocumento: string | null;
  papel: PapelDocumento | null;
  criadoEm: string | null;
}

export interface RespostaDocumentos {
  data: DocumentoDaOperacao[];
  total: number;
}

// ── Linha editável (um arquivo) ──────────────────────────────────────────────

export type EstadoEnvio = "PENDENTE" | "ENVIANDO" | "ENVIADO" | "ERRO";

export interface LinhaArquivo {
  /** Chave local estável — é ela que casa a linha com o resultado de `classificarRelacao`. */
  chave: string;
  file: File;

  // Campos editáveis da linha
  titulo: string;
  papel: PapelDocumento;
  subcategoria: SubcategoriaDocHab;
  /**
   * Tipo no dossiê (0034). É UMA decisão: com tipo escolhido, `papel` e
   * `subcategoria` DERIVAM dele (`DERIVACAO_POR_TIPO`) e os selects travam.
   * NULL = "Sem tipo definido" (seção 9 da ficha) — nunca palpitar OUTRO.
   */
  tipoDocumento: TipoDocumento | null;
  /** Ciclo de vida da PROVA (0034); NULL = não avaliada. Palpite pelo nome. */
  situacaoProva: SituacaoProva | null;
  /** Some das listas e do ZIP fora da Conformidade. Nasce sempre `false`. */
  restrito: boolean;
  numeroDocumento: string;
  /** "AAAA-MM-DD" do <input type="date">; vazio = não informado. */
  emitidoEm: string;
  validadeFim: string;
  validadeIndeterminada: boolean;

  /**
   * O usuário já mexeu no campo? Guarda o palpite de atropelar escolha humana:
   * escolher a operação recalcula o título só de quem não foi editado, e trocar
   * o papel só religa o "não vence" de quem não foi editado.
   */
  tituloTocado: boolean;
  validadeTocada: boolean;

  /** SHA-256 em hex minúsculo; vazio enquanto o navegador ainda calcula. */
  sha256: string;
  hashErro: string | null;

  // Envio
  estado: EstadoEnvio;
  /** 0..100 — bytes que já subiram (XHR); 100 = servidor processando. */
  progresso: number;
  erro: string | null;
  /** `detalhes` do 422, campo → mensagem, para grudar o erro no input certo. */
  errosCampo: Record<string, string>;
  documentoId: string | null;
  /** Id do documento que o 409 do servidor apontou como já existente. */
  duplicataDoServidorId: string | null;
  /** "Subir mesmo assim" — vira `permitirDuplicata=true` no multipart. */
  forcarDuplicata: boolean;
}

// ── Listas de opções (derivadas da fonte do backend) ─────────────────────────

export const CATEGORIAS_ORDENADAS = Object.keys(CATEGORIA_LABELS) as CategoriaDocHab[];

/**
 * Subcategorias agrupadas por categoria, para o <optgroup> do seletor.
 * Derivado de `SUBCATEGORIA_TO_CATEGORIA` (o mesmo mapa que o backend usa) —
 * assim uma subcategoria nova aparece na tela sem ninguém lembrar de editá-la
 * aqui, e nunca sobra opção que o zod recusaria.
 */
export const SUBCATEGORIAS_POR_CATEGORIA: Record<CategoriaDocHab, SubcategoriaDocHab[]> =
  (() => {
    const mapa = {} as Record<CategoriaDocHab, SubcategoriaDocHab[]>;
    for (const categoria of CATEGORIAS_ORDENADAS) mapa[categoria] = [];
    for (const [sub, categoria] of Object.entries(SUBCATEGORIA_TO_CATEGORIA)) {
      mapa[categoria].push(sub as SubcategoriaDocHab);
    }
    return mapa;
  })();

/** A categoria não é campo da linha: ela sai da subcategoria, como no backend. */
export function categoriaDaSubcategoria(sub: SubcategoriaDocHab): CategoriaDocHab {
  return SUBCATEGORIA_TO_CATEGORIA[sub];
}

// ── Palpites a partir do nome do arquivo ─────────────────────────────────────

/**
 * Prefixo de pasta usado só para reaproveitar `inferirDestino`.
 *
 * As ~30 regex que reconhecem "CND", "FGTS", "ART", "ISO 9001"… estão dentro de
 * `inferir-categoria.ts` e não são exportadas. Em vez de duplicá-las aqui (duas
 * cópias divergiriam na primeira manutenção), monta-se o path que aquela função
 * espera. A categoria que ela devolve nesse caso é sempre TECNICA e é
 * DESCARTADA — quem manda é a subcategoria, e dela sai a categoria de verdade
 * via `SUBCATEGORIA_TO_CATEGORIA`.
 */
const PASTA_PARA_PALPITE = "02_Habilitacao/04_Tecnica/";

export function palpitarSubcategoria(nomeArquivo: string): SubcategoriaDocHab {
  const destino = inferirDestino(`${PASTA_PARA_PALPITE}${nomeArquivo}`);
  if (destino.tipo !== "DOCUMENTO_HABILITACAO") return "ATESTADO_ACT";
  // OUTROS_TECNICOS é o default DA PASTA, ou seja: nenhuma regex casou. Nessa
  // tela, "não sei o que é" tem um palpite melhor — o que entra aqui é prova de
  // operação, e prova de operação é atestado.
  return destino.subcategoria === "OUTROS_TECNICOS" ? "ATESTADO_ACT" : destino.subcategoria;
}

/** Papel na operação a partir da subcategoria adivinhada (sem regex nova). */
const PAPEL_POR_SUBCATEGORIA: Partial<Record<SubcategoriaDocHab, PapelDocumento>> = {
  ATESTADO_ACT:           "ATESTADO",
  ART_CAT:                "CAT_ART",
  DECL_MENOR_NAO_EMPREGA: "DECLARACAO",
  DECL_IDONEIDADE:        "DECLARACAO",
  DECL_ME_EPP:            "DECLARACAO",
  DECL_OUTRA:             "DECLARACAO",
};

export function palpitarPapel(sub: SubcategoriaDocHab): PapelDocumento {
  return PAPEL_POR_SUBCATEGORIA[sub] ?? "ATESTADO";
}

// ── Tipo no dossiê: derivação e palpites (0034) ──────────────────────────────

/**
 * De-para canônico do 00-ARQUITETURA §1.2: escolhido o tipo, papel, categoria
 * e subcategoria derivam — nunca são decididos de novo. A categoria vem daqui
 * (e não de `SUBCATEGORIA_TO_CATEGORIA`) porque o mapa canônico diverge dele
 * de propósito: contrato/aditivo com subcategoria OUTRO são JURIDICA, não
 * DECLARACAO. Com tipo NULL, vale o caminho antigo via subcategoria.
 */
export interface DerivacaoTipo {
  papel: PapelDocumento;
  categoria: CategoriaDocHab;
  subcategoria: SubcategoriaDocHab;
}

export const DERIVACAO_POR_TIPO: Record<TipoDocumento, DerivacaoTipo> = {
  ART:            { papel: "CAT_ART",     categoria: "QUALIFICACAO_PESSOAL", subcategoria: "ART_CAT" },
  CAT:            { papel: "CAT_ART",     categoria: "QUALIFICACAO_PESSOAL", subcategoria: "ART_CAT" },
  ATESTADO:       { papel: "ATESTADO",    categoria: "TECNICA",              subcategoria: "ATESTADO_ACT" },
  CONTRATO:       { papel: "CONTRATO",    categoria: "JURIDICA",             subcategoria: "OUTRO" },
  ADITIVO:        { papel: "ADITIVO",     categoria: "JURIDICA",             subcategoria: "OUTRO" },
  ANEXO_CONTRATO: { papel: "CONTRATO",    categoria: "JURIDICA",             subcategoria: "OUTRO" },
  CREA_PJ:        { papel: "DECLARACAO",  categoria: "QUALIFICACAO_PESSOAL", subcategoria: "CREA_PJ" },
  ISO:            { papel: "DECLARACAO",  categoria: "TECNICA",              subcategoria: "ISO_9001" }, // 14001/45001 pelo nome
  DECLARACAO:     { papel: "DECLARACAO",  categoria: "DECLARACAO",           subcategoria: "DECL_OUTRA" },
  PROPOSTA:       { papel: "OUTRO",       categoria: "TECNICA",              subcategoria: "OUTROS_TECNICOS" },
  ANEXO_ET:       { papel: "OUTRO",       categoria: "TECNICA",              subcategoria: "OUTROS_TECNICOS" },
  DOC_PROJETO:    { papel: "OUTRO",       categoria: "TECNICA",              subcategoria: "OUTROS_TECNICOS" },
  PEDIDO:         { papel: "CONTRATO",    categoria: "JURIDICA",             subcategoria: "OUTRO" },
  NF:             { papel: "NOTA_FISCAL", categoria: "FISCAL",               subcategoria: "OUTRO" },
  CARTA:          { papel: "OUTRO",       categoria: "JURIDICA",             subcategoria: "OUTRO" },
  RELATORIO:      { papel: "OUTRO",       categoria: "TECNICA",              subcategoria: "OUTROS_TECNICOS" },
  PESSOAL:        { papel: "OUTRO",       categoria: "QUALIFICACAO_PESSOAL", subcategoria: "FORMACAO" },
  CAPA_OP:        { papel: "OUTRO",       categoria: "JURIDICA",             subcategoria: "OUTRO" },
  COMPACTADO:     { papel: "OUTRO",       categoria: "TECNICA",              subcategoria: "OUTROS_TECNICOS" },
  OUTRO:          { papel: "OUTRO",       categoria: "TECNICA",              subcategoria: "OUTROS_TECNICOS" },
};

/** Exceção ISO: a norma sai do nome do arquivo (9001 é o default do tipo). */
export function derivarSubcategoriaISO(nomeArquivo: string): SubcategoriaDocHab {
  if (/14001/.test(nomeArquivo)) return "ISO_14001";
  if (/45001/.test(nomeArquivo)) return "ISO_45001";
  return "ISO_9001";
}

/** Papel + subcategoria derivados do tipo, já com a exceção ISO aplicada. */
function derivarDoTipo(
  tipo: TipoDocumento,
  nomeArquivo: string
): { papel: PapelDocumento; subcategoria: SubcategoriaDocHab } {
  const base = DERIVACAO_POR_TIPO[tipo];
  return {
    papel: base.papel,
    subcategoria: tipo === "ISO" ? derivarSubcategoriaISO(nomeArquivo) : base.subcategoria,
  };
}

/**
 * Mudança de linha ao trocar o tipo no select (e no "aplicar a todos"): tipo
 * novo reescreve papel/subcategoria pela derivação; voltar a "— sem tipo" só
 * destrava os selects, sem desfazer o que a derivação escreveu. Título e
 * validade nunca entram aqui — quem preserva campo tocado é `aplicarMudanca`.
 */
export function mudancaDeTipo(
  tipo: TipoDocumento | null,
  nomeArquivo: string
): Partial<LinhaArquivo> {
  if (tipo === null) return { tipoDocumento: null };
  return { tipoDocumento: tipo, ...derivarDoTipo(tipo, nomeArquivo) };
}

/**
 * Categoria que vai no POST (e no cabeçalho do cartão): com tipo, a do mapa
 * canônico; sem tipo, a da subcategoria — exatamente como o backend enxerga.
 */
export function categoriaDaLinha(
  linha: Pick<LinhaArquivo, "tipoDocumento" | "subcategoria">
): CategoriaDocHab {
  return linha.tipoDocumento
    ? DERIVACAO_POR_TIPO[linha.tipoDocumento].categoria
    : categoriaDaSubcategoria(linha.subcategoria);
}

/**
 * Palpite de tipo pelo nome do arquivo — primeira regra que casa vence (a
 * ordem é contrato do plano: CAT antes de ATESTADO, ATESTADO antes de
 * CONTRATO…). Sem regra casando devolve NULL, nunca OUTRO: OUTRO é decisão
 * humana, NULL é ausência (seção 9 da ficha).
 */
const REGRAS_TIPO: ReadonlyArray<readonly [RegExp, TipoDocumento]> = [
  [/\.(zip|rar|7z)$/i,                            "COMPACTADO"],
  [/\bCAT\b(?!ÁLOGO|ALOGO)/i,                     "CAT"],
  [/\bART\b|^AP_ART|BA20\d{6,}/i,                 "ART"],
  [/ATESTADO|CAPACIDADE T[EÉ]CNICA|\bACT\b/i,     "ATESTADO"],
  [/ADITIVO/i,                                    "ADITIVO"],
  [/PROPOSTA/i,                                   "PROPOSTA"],
  [/CONTRATO|\bICJ\b/i,                           "CONTRATO"],
  [/NOTA FISCAL|\bNFS?E?\b|\bDANFE\b/i,           "NF"],
  [/PEDIDO|ORDEM DE (COMPRA|SERVI[ÇC]O)|\bPO\b[ _-]?\d/i, "PEDIDO"],
  [/\bCREA\b/i,                                   "CREA_PJ"],
  [/\bISO[ _-]?(9001|14001|45001)\b/i,            "ISO"],
  [/DECLARA[ÇC][ÃA]O/i,                           "DECLARACAO"],
  [/CARTA/i,                                      "CARTA"],
  [/RELAT[OÓ]RIO/i,                               "RELATORIO"],
];

export function palpitarTipoDocumento(nomeArquivo: string): TipoDocumento | null {
  for (const [regex, tipo] of REGRAS_TIPO) {
    if (regex.test(nomeArquivo)) return tipo;
  }
  return null;
}

/**
 * Palpite da situação da prova pelo nome. "ASSINAD" vira ASSINADA_PROPONENTE —
 * o nome raramente diz que foi o cliente; promover a ASSINADA_CLIENTE é
 * decisão humana. Palpite nunca trava campo: é valor inicial editável.
 */
export function palpitarSituacaoProva(nomeArquivo: string): SituacaoProva | null {
  if (/RASCUNHO|MINUTA|DRAFT/i.test(nomeArquivo)) return "RASCUNHO";
  if (/SUPERAD/i.test(nomeArquivo))               return "SUPERADA";
  if (/CANCELAD/i.test(nomeArquivo))              return "CANCELADA";
  if (/MODELO|TEMPLATE/i.test(nomeArquivo))       return "MODELO";
  if (/ASSINAD/i.test(nomeArquivo))               return "ASSINADA_PROPONENTE";
  return null;
}

/**
 * Papéis que NÃO vencem — premissa travada da spec: atestado não vence, se soma.
 * Declaração e "outro" ficam de fora porque costumam ter prazo, e marcar
 * "indeterminada" por conta própria nesses casos apagaria alerta de vencimento.
 */
const PAPEIS_QUE_NAO_VENCEM: ReadonlySet<PapelDocumento> = new Set<PapelDocumento>([
  "ATESTADO",
  "CAT_ART",
  "CONTRATO",
  "ADITIVO",
  "NOTA_FISCAL",
]);

export function papelNaoVence(papel: PapelDocumento): boolean {
  return PAPEIS_QUE_NAO_VENCEM.has(papel);
}

// ── Criação da linha ─────────────────────────────────────────────────────────

/**
 * Contador de chaves locais. É um contador e não o índice do array porque o
 * usuário remove arquivos no meio do lote — índice reaproveitado faria o React
 * (e o mapa de relações) confundir uma linha com outra.
 */
let sequenciaChave = 0;

/**
 * `palpites` chega do link de entrada (`?papel=…&tipo=…` — o botão "Subir
 * prova" da ficha manda os dois): tipo do link vence o palpite pelo nome; com
 * tipo definido, papel e subcategoria DERIVAM dele (o papel do link fica
 * redundante de propósito); sem tipo, o papel do link vence `palpitarPapel`.
 * Chamada antiga sem o 3º parâmetro continua valendo (retrocompatível).
 */
export function criarLinha(
  file: File,
  operacaoCodigo: string | null,
  palpites?: { papel?: PapelDocumento; tipo?: TipoDocumento }
): LinhaArquivo {
  const tipoDocumento = palpites?.tipo ?? palpitarTipoDocumento(file.name);

  let papel: PapelDocumento;
  let subcategoria: SubcategoriaDocHab;
  if (tipoDocumento !== null) {
    ({ papel, subcategoria } = derivarDoTipo(tipoDocumento, file.name));
  } else {
    // O palpite antigo (subcategoria pelas regex de `inferirDestino`) só roda
    // quando não há tipo — com tipo, decidir de novo contradiria a derivação.
    subcategoria = palpitarSubcategoria(file.name);
    papel = palpites?.papel ?? palpitarPapel(subcategoria);
  }

  // Validade no nome (convenção `_AAAA-MM-DD.pdf`) vale mais que o palpite pelo
  // papel: se o arquivo diz quando vence, ele vence.
  const validadeNoNome = extrairValidadeDoNome(file.name);
  const validadeFim = validadeNoNome ? validadeNoNome.toISOString().slice(0, 10) : "";

  sequenciaChave += 1;

  return {
    chave: `arq-${sequenciaChave}`,
    file,
    titulo: tituloSugerido(file.name, operacaoCodigo),
    papel,
    subcategoria,
    tipoDocumento,
    situacaoProva: palpitarSituacaoProva(file.name),
    restrito: false,
    numeroDocumento: "",
    emitidoEm: "",
    validadeFim,
    validadeIndeterminada: validadeFim === "" && papelNaoVence(papel),
    tituloTocado: false,
    validadeTocada: false,
    sha256: "",
    hashErro: null,
    estado: "PENDENTE",
    progresso: 0,
    erro: null,
    errosCampo: {},
    documentoId: null,
    duplicataDoServidorId: null,
    forcarDuplicata: false,
  };
}

/** A linha como o classificador do domínio a enxerga (sem File, sem estado de tela). */
export function paraArquivoDoLote(linha: LinhaArquivo, operacaoId: string | null): ArquivoDoLote {
  return {
    chave: linha.chave,
    nomeArquivo: linha.file.name,
    sha256: linha.sha256,
    operacaoId,
    numeroDocumento: linha.numeroDocumento.trim() || null,
  };
}

// ── Validação (a mesma regra do zod do POST, antecipada na tela) ─────────────

/**
 * Mesmos limites de `CriarDocumentoSchema`: título 2..200, número até 100.
 * A regra da validade é da tela e vem da versão anterior: ou tem data, ou o
 * usuário afirma que não vence — nunca silêncio, porque documento sem validade e
 * sem "não vence" é o que some do radar de vencimento.
 */
export function validarLinha(linha: LinhaArquivo): Record<string, string> {
  const erros: Record<string, string> = {};

  const titulo = linha.titulo.trim();
  if (titulo.length < 2) erros.titulo = "Mínimo 2 caracteres";
  else if (titulo.length > 200) erros.titulo = "Máximo 200 caracteres";

  if (linha.numeroDocumento.trim().length > 100) {
    erros.numeroDocumento = "Máximo 100 caracteres";
  }

  if (!linha.validadeIndeterminada && !linha.validadeFim) {
    erros.validadeFim = 'Informe a validade ou marque "não vence"';
  }

  return erros;
}

// ── Multipart ────────────────────────────────────────────────────────────────

export interface CamposComuns {
  descricao: string;
  tags: string[];
  /** "" = herdar da operação (R7 resolve no servidor); só vai no POST se escolhida. */
  detentora: Detentora | "";
}

/**
 * Monta o corpo do POST /api/conformidade/cofre/documentos.
 *
 * Só manda campo que tem valor: string vazia em `numeroDocumento`/`descricao`
 * gravaria "" no banco em vez de NULL. `status` não vai — o schema já usa
 * VIGENTE como default, que é o que a tela sempre mandou.
 *
 * `papel` só acompanha quando há operação: papel é o que a prova prova NAQUELA
 * obra. Mandar "ATESTADO" numa CND avulsa seria dado errado nascendo.
 *
 * A flag `ocr` continua ausente de propósito (custa dinheiro por documento e a
 * suíte E2E do cofre conta com isso).
 */
export function montarFormData(
  linha: LinhaArquivo,
  operacaoId: string | null,
  comuns: CamposComuns
): FormData {
  const fd = new FormData();
  fd.append("file", linha.file);
  // Com tipo, a categoria vem do mapa canônico (contrato = JURIDICA mesmo com
  // subcategoria OUTRO); sem tipo, da subcategoria — ver `categoriaDaLinha`.
  fd.append("categoria", categoriaDaLinha(linha));
  fd.append("subcategoria", linha.subcategoria);
  fd.append("titulo", linha.titulo.trim());

  // Campos 0034 — todos opcionais no schema (R7): campo ausente = NULL no
  // banco (nunca mandar string vazia). `restrito` é flag de multipart lida no
  // handler, fora do zod — só vai quando true, como `permitirDuplicata`.
  if (linha.tipoDocumento) fd.append("tipoDocumento", linha.tipoDocumento);
  if (linha.situacaoProva) fd.append("situacaoProva", linha.situacaoProva);
  if (linha.restrito)      fd.append("restrito", "true");
  if (comuns.detentora)    fd.append("detentora", comuns.detentora);

  if (comuns.descricao.trim()) fd.append("descricao", comuns.descricao.trim());
  if (linha.numeroDocumento.trim()) fd.append("numeroDocumento", linha.numeroDocumento.trim());

  // O backend espera ISO 8601 completo (z.string().datetime()); o input date dá
  // só "AAAA-MM-DD". `new Date("AAAA-MM-DD")` é meia-noite UTC — mesma conversão
  // da versão anterior da tela.
  if (linha.emitidoEm) fd.append("emitidoEm", new Date(linha.emitidoEm).toISOString());
  if (linha.validadeFim && !linha.validadeIndeterminada) {
    fd.append("validadeFim", new Date(linha.validadeFim).toISOString());
  }
  fd.append("validadeIndeterminada", String(linha.validadeIndeterminada));

  if (comuns.tags.length > 0) fd.append("tags", JSON.stringify(comuns.tags));

  if (operacaoId) {
    fd.append("operacaoId", operacaoId);
    fd.append("papel", linha.papel);
  }

  if (linha.forcarDuplicata) fd.append("permitirDuplicata", "true");

  return fd;
}

/** Tags digitadas separadas por vírgula (comportamento preservado da tela antiga). */
export function separarTags(texto: string): string[] {
  return texto
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

const ROTA_UPLOAD = "/api/conformidade/cofre/documentos";

/** Corpo de resposta do cofre, no que a tela consome. */
export interface CorpoResposta {
  id?: string;
  error?: string;
  detalhes?: Record<string, string>;
  /** 409 de duplicata exata: o documento que já guarda esses bytes. */
  documentoId?: string;
  titulo?: string;
}

export interface RespostaHttp {
  status: number;
  corpo: CorpoResposta | null;
}

/**
 * Sobe um arquivo com progresso real de bytes.
 *
 * XHR e não `fetch` por um motivo só: `fetch` não expõe progresso de UPLOAD (o
 * ReadableStream de request ainda não é utilizável aqui), e barra por arquivo é
 * requisito da tela. Todo o resto da tela usa `fetch`.
 */
export function subirDocumento(
  formData: FormData,
  aoProgredir: (porcentagem: number) => void
): Promise<RespostaHttp> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", ROTA_UPLOAD);

    xhr.upload.addEventListener("progress", (ev) => {
      if (ev.lengthComputable && ev.total > 0) {
        aoProgredir(Math.min(100, Math.round((ev.loaded / ev.total) * 100)));
      }
    });

    xhr.addEventListener("load", () => {
      let corpo: CorpoResposta | null = null;
      try {
        corpo = JSON.parse(xhr.responseText) as CorpoResposta;
      } catch {
        // Resposta sem JSON (proxy, 413 do NGINX): `mensagemDoErro` cobre.
        corpo = null;
      }
      resolve({ status: xhr.status, corpo });
    });

    xhr.addEventListener("error", () =>
      reject(new Error("Falha de rede ao enviar o arquivo."))
    );
    xhr.addEventListener("timeout", () =>
      reject(new Error("O servidor demorou demais para responder."))
    );
    xhr.addEventListener("abort", () => reject(new Error("Envio cancelado.")));

    xhr.send(formData);
  });
}

/**
 * Mensagem que vai para a linha do arquivo.
 *
 * Sempre a frase REAL do backend quando ela existe — a tela nunca troca o motivo
 * por um genérico. Em 5xx o `{"error":"Erro interno"}` vem sem contexto nenhum,
 * então o status entra junto para o suporte ter o que procurar no log.
 */
export function mensagemDoErro({ status, corpo }: RespostaHttp): string {
  const doServidor = corpo?.error?.trim();
  if (doServidor) return status >= 500 ? `${doServidor} (HTTP ${status})` : doServidor;
  if (status === 413) return "Arquivo grande demais para o servidor (HTTP 413)";
  if (status === 0) return "Sem resposta do servidor";
  return `O servidor recusou o envio (HTTP ${status})`;
}

// ── Paralelismo ──────────────────────────────────────────────────────────────

/**
 * Roda `tarefa` sobre os itens com no máximo `limite` em voo.
 *
 * Três, e não todos de uma vez: cada upload carrega o arquivo inteiro na
 * memória do servidor (multipart do Next) e ainda dispara hash + storage. Uma
 * fila de 40 atestados em paralelo derruba o container antes de terminar.
 *
 * O `indice++` é seguro sem lock porque JS é single-threaded: só um worker roda
 * entre dois `await`.
 */
export async function executarComLimite<T>(
  itens: readonly T[],
  limite: number,
  tarefa: (item: T) => Promise<void>
): Promise<void> {
  let indice = 0;
  const trabalhadores = Array.from(
    { length: Math.min(limite, itens.length) },
    async () => {
      while (indice < itens.length) {
        const item = itens[indice];
        indice += 1;
        await tarefa(item);
      }
    }
  );
  await Promise.all(trabalhadores);
}

/** Quebra a lista em blocos — /verificar aceita no máximo 50 hashes por chamada. */
export function emBlocos<T>(itens: readonly T[], tamanho: number): T[][] {
  const blocos: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) {
    blocos.push(itens.slice(i, i + tamanho));
  }
  return blocos;
}

// ── Formatação ───────────────────────────────────────────────────────────────

export function formatarTamanho(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
