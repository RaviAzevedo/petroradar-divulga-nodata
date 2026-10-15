/**
 * Domínio compartilhado — Cofre por operação.
 *
 * O back (rotas /api/conformidade/operacoes e /api/conformidade/cofre/*) e o
 * front (tela "Subir provas da operação") importam daqui os mesmos rótulos, o
 * mesmo cálculo de hash e a MESMA regra de relação entre arquivos. O motivo de
 * existir um módulo só: a decisão "isto é duplicata / versão / irmão / anexo"
 * tem de dar o mesmo resultado na tela (antes de subir) e no servidor (na hora
 * de gravar) — duas implementações divergiriam na primeira manutenção, e é
 * justamente a falta dessa checagem que deixa passar duplicata exata no cofre.
 *
 * De propósito não há zod aqui: os schemas de request vivem em
 * `@/lib/conformidade/operacoes/validations` e devem ser montados a partir das
 * tuplas exportadas abaixo (`z.enum(PAPEIS_DOCUMENTO)`), pra não duplicar lista
 * de valores em dois arquivos.
 */

import { tituloDoNome } from "@/lib/conformidade/inferir-categoria";

// ── Papel do documento na operação ───────────────────────────────────────────

/**
 * Espelha o CHECK de `documentos_habilitacao.papel` (migration 0033).
 * A ORDEM desta tupla é a ordem de exibição do dossiê (provas por papel):
 * o atestado vem primeiro porque é a prova que habilita; o resto é lastro.
 */
export const PAPEIS_DOCUMENTO = [
  "ATESTADO",
  "CAT_ART",
  "CONTRATO",
  "ADITIVO",
  "NOTA_FISCAL",
  "DECLARACAO",
  "OUTRO",
] as const;

export type PapelDocumento = (typeof PAPEIS_DOCUMENTO)[number];

export const PAPEL_DOCUMENTO_LABELS: Record<PapelDocumento, string> = {
  ATESTADO:    "Atestado de capacidade técnica",
  CAT_ART:     "CAT / ART",
  CONTRATO:    "Contrato",
  ADITIVO:     "Aditivo",
  NOTA_FISCAL: "Nota fiscal",
  DECLARACAO:  "Declaração",
  OUTRO:       "Outro",
};

// ── Tipo do documento no dossiê (0034) ───────────────────────────────────────

/**
 * Espelha o CHECK de `documentos_habilitacao.tipo_documento` (migration 0034).
 * É UMA decisão: escolhido o tipo, papel/categoria/subcategoria e a seção da
 * ficha DERIVAM dele (de-para canônico no 00-ARQUITETURA §1.2) — nunca são
 * decididos de novo.
 */
export const TIPOS_DOCUMENTO = [
  "ART", "CAT", "ATESTADO", "CONTRATO", "ADITIVO", "ANEXO_CONTRATO",
  "CREA_PJ", "ISO", "DECLARACAO", "PROPOSTA", "ANEXO_ET", "DOC_PROJETO",
  "PEDIDO", "NF", "CARTA", "RELATORIO", "PESSOAL", "CAPA_OP",
  "COMPACTADO", "OUTRO",
] as const;

export type TipoDocumento = (typeof TIPOS_DOCUMENTO)[number];

export const TIPO_DOCUMENTO_LABELS: Record<TipoDocumento, string> = {
  ART: "ART", CAT: "CAT", ATESTADO: "Atestado de capacidade técnica",
  CONTRATO: "Contrato", ADITIVO: "Aditivo", ANEXO_CONTRATO: "Anexo de contrato",
  CREA_PJ: "CREA Pessoa Jurídica", ISO: "Certificação ISO",
  DECLARACAO: "Declaração", PROPOSTA: "Proposta / orçamento",
  ANEXO_ET: "Anexo técnico (ET)", DOC_PROJETO: "Documento de projeto",
  PEDIDO: "Pedido de compra", NF: "Nota fiscal", CARTA: "Carta",
  RELATORIO: "Relatório", PESSOAL: "Documento de pessoa",
  CAPA_OP: "Capa de operação", COMPACTADO: "Arquivo compactado", OUTRO: "Outro",
};

// ── Situação da prova (0034) ─────────────────────────────────────────────────

/**
 * Espelha o CHECK de `documentos_habilitacao.situacao_prova` (migration 0034).
 * Ciclo de vida de PROVA — não confundir com o `status` do documento, que é
 * ciclo de vida de CERTIDÃO (VIGENTE/VENCIDO/...). NULL = anterior à 0034 ou
 * não avaliada.
 */
export const SITUACOES_PROVA = [
  "RASCUNHO", "ASSINADA_PROPONENTE", "ASSINADA_CLIENTE",
  "SUPERADA", "CANCELADA", "MODELO", "INDEFINIDA",
] as const;

export type SituacaoProva = (typeof SITUACOES_PROVA)[number];

export const SITUACAO_PROVA_LABELS: Record<SituacaoProva, string> = {
  RASCUNHO: "Rascunho", ASSINADA_PROPONENTE: "Assinada (Proponente)",
  ASSINADA_CLIENTE: "Assinada (cliente)", SUPERADA: "Superada",
  CANCELADA: "Cancelada", MODELO: "Modelo", INDEFINIDA: "Indefinida",
};

/** Situações que CONTAM na barra de comprovação (NULL também conta — regra §1.2). */
export const SITUACOES_QUE_CONTAM: readonly SituacaoProva[] = [
  "ASSINADA_PROPONENTE", "ASSINADA_CLIENTE", "INDEFINIDA",
] as const;

// ── Seções da ficha (derivadas — ADR-02: não existe coluna `secao`) ─────────

/** tipo → seção. Espelho: dict homônimo em bff/app/routers/migrated/conf_dossie_secoes.py. */
export const SECAO_POR_TIPO: Record<TipoDocumento, number> = {
  CONTRATO: 1, ADITIVO: 1, ANEXO_CONTRATO: 1,
  ATESTADO: 2,
  ART: 3, CAT: 3,
  CREA_PJ: 4, ISO: 4, DECLARACAO: 4,
  PROPOSTA: 5,
  ANEXO_ET: 6, DOC_PROJETO: 6,
  PEDIDO: 7, NF: 7, CARTA: 7, RELATORIO: 7, PESSOAL: 7, CAPA_OP: 7,
  COMPACTADO: 8,
  OUTRO: 9,
};

/** Fallback para tipo NULL: seção pelo `papel` (legados; mesma regra da barra). */
export const SECAO_POR_PAPEL: Record<PapelDocumento, number> = {
  ATESTADO: 2, CAT_ART: 3, CONTRATO: 1, ADITIVO: 1,
  NOTA_FISCAL: 7, DECLARACAO: 4, OUTRO: 9,
};

/** Nomes canônicos — usados na TELA e na árvore do ZIP (slug). */
export const SECOES_FICHA: Record<number, { nome: string; slug: string }> = {
  1: { nome: "Contrato e aditivos",               slug: "1_Contrato_e_aditivos" },
  2: { nome: "Atestados de capacidade técnica",   slug: "2_Atestados" },
  3: { nome: "ART e CAT",                         slug: "3_ART_e_CAT" },
  4: { nome: "Habilitação técnica da empresa",    slug: "4_Habilitacao_tecnica" },
  5: { nome: "Proposta e orçamento",              slug: "5_Proposta_e_orcamento" },
  6: { nome: "Anexos técnicos do contrato",       slug: "6_Anexos_tecnicos" },
  7: { nome: "Execução e administrativo",         slug: "7_Execucao_e_administrativo" },
  8: { nome: "A inspecionar",                     slug: "8_A_inspecionar" },
  9: { nome: "Sem tipo definido",                 slug: "9_Sem_tipo" },
};

/** Seção de um documento: tipo primeiro, papel como fallback, 9 no fim. */
export function secaoDoDocumento(
  tipo: TipoDocumento | null, papel: PapelDocumento | null
): number {
  if (tipo) return SECAO_POR_TIPO[tipo];
  if (papel) return SECAO_POR_PAPEL[papel];
  return 9;
}

// ── Detentora do acervo ──────────────────────────────────────────────────────

/**
 * Espelha o CHECK de `operacoes.detentora`. Campo de primeira classe porque
 * parte do acervo pode ser de terceiro (COLIGADA/parceiro) e isso muda o que dá
 * pra usar em habilitação — não é detalhe de cadastro.
 */
export const DETENTORAS = ["PROPONENTE", "COLIGADA", "PARCEIRO"] as const;

export type Detentora = (typeof DETENTORAS)[number];

export const DETENTORA_LABELS: Record<Detentora, string> = {
  PROPONENTE: "Proponente",
  COLIGADA:    "COLIGADA",
  PARCEIRO: "Parceiro",
};

// ── Origem da operação ───────────────────────────────────────────────────────

/** Espelha o CHECK de `operacoes.origem`: veio da Relação de Operações ou foi digitada. */
export const ORIGENS_OPERACAO = ["CATALOGO", "MANUAL"] as const;

export type OrigemOperacao = (typeof ORIGENS_OPERACAO)[number];

export const ORIGEM_OPERACAO_LABELS: Record<OrigemOperacao, string> = {
  CATALOGO: "Catálogo de operações",
  MANUAL:   "Cadastro manual",
};

// ── SHA-256 no navegador ─────────────────────────────────────────────────────

/**
 * Devolve o SubtleCrypto ou explica em pt-BR por que ele sumiu. `crypto.subtle`
 * só existe em contexto seguro (HTTPS ou localhost) — em HTTP puro o navegador
 * simplesmente não expõe a API, e sem essa mensagem o erro chegaria na tela como
 * "Cannot read properties of undefined".
 */
function subtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "Cálculo de hash indisponível neste navegador: a página precisa estar em conexão segura (HTTPS)."
    );
  }
  return subtle;
}

/**
 * SHA-256 do arquivo em hexadecimal minúsculo (64 caracteres).
 *
 * É o mesmo formato que o cofre grava e que POST /cofre/documentos/verificar
 * espera, então o hex tem de sair minúsculo e sem separador. Recebe `Blob` (e
 * não `File`) porque `File extends Blob` e assim dá pra testar sem DOM de
 * verdade. Sem dependência externa: `crypto.subtle` já vem no navegador.
 */
export async function sha256Hex(arquivo: Blob): Promise<string> {
  const bytes = await arquivo.arrayBuffer();
  const digest = await subtleCrypto().digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Relação entre os arquivos do lote ────────────────────────────────────────

/** Um arquivo do lote como a tela o conhece ANTES de subir (ainda sem id de banco). */
export interface ArquivoDoLote {
  /** Chave local estável do arquivo na tela (índice, uuid do cliente — o que a tela usar). */
  chave: string;
  nomeArquivo: string;
  /** SHA-256 em hex minúsculo, vindo de `sha256Hex()`. Vazio = ainda não calculado. */
  sha256: string;
  /** Operação apontada pelo usuário. `null` enquanto ele não escolheu. */
  operacaoId: string | null;
  /** "10008/2019", "ACT 123" — é o que separa VERSAO de IRMAO. */
  numeroDocumento: string | null;
  /** Preenchido quando o usuário diz "isto é anexo daquele documento do cofre". */
  anexoDeDocumentoId?: string | null;
  /** Idem, quando o pai é outro arquivo do MESMO lote (que ainda não tem id). */
  anexoDeChave?: string | null;
}

/** Documento que já está no cofre — o que GET /cofre/documentos devolve por operação. */
export interface DocumentoNoCofre {
  id: string;
  titulo: string;
  operacaoId: string | null;
  numeroDocumento: string | null;
}

/** Item do mapa `existentes` de POST /api/conformidade/cofre/documentos/verificar. */
export interface DuplicataNoCofre {
  id: string;
  titulo: string;
  criadoEm: string;
  operacaoCodigo: string | null;
}

export interface EntradaClassificacao {
  arquivos: ArquivoDoLote[];
  /** Resposta de /verificar: sha256 (hex minúsculo) → documento que já existe. */
  existentesPorSha: Record<string, DuplicataNoCofre>;
  /** Provas já guardadas das operações envolvidas. Opcional: sem elas só se compara o lote. */
  documentosNoCofre?: DocumentoNoCofre[];
}

export type TipoRelacao = "DUPLICATA" | "ANEXO" | "VERSAO" | "IRMAO" | "NOVO";

/** De onde veio a contraparte da relação. */
export type OrigemRelacao = "LOTE" | "COFRE";

export interface RelacaoArquivo {
  /** Mesma `chave` do arquivo de entrada — a tela indexa o aviso por ela. */
  chave: string;
  relacao: TipoRelacao;
  /** `null` só em NOVO. */
  origem: OrigemRelacao | null;
  /** Chave do arquivo do lote que é a contraparte (quando `origem === "LOTE"`). */
  chaveRelacionada: string | null;
  /** Id do documento do cofre que é a contraparte (quando `origem === "COFRE"`). */
  documentoRelacionadoId: string | null;
  /** Só em DUPLICATA de cofre: o documento inteiro que /verificar devolveu. */
  duplicataNoCofre: DuplicataNoCofre | null;
  /** Frase pronta pra tela, em pt-BR. */
  motivo: string;
  /** Trava o envio até o usuário remover o arquivo ou marcar "enviar mesmo assim". */
  bloqueia: boolean;
}

/**
 * Normaliza número de documento pra comparação: sem acento, sem pontuação, em
 * maiúsculas — "123/2021", "123-2021" e "123.2021" são o MESMO número. Segue a
 * mesma receita de `normalizarCodigoCrc` em `familias/validations.ts`.
 * String vazia significa "sem número" e nunca casa com nada.
 */
export function normalizarNumeroDocumento(numero: string | null | undefined): string {
  return (numero ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
}

/** Hash comparável: o cofre guarda hex minúsculo, mas o que chega da tela pode variar. */
function normalizarSha(sha: string | null | undefined): string {
  return (sha ?? "").trim().toLowerCase();
}

interface PaiApontado {
  origem: OrigemRelacao;
  chaveRelacionada: string | null;
  documentoRelacionadoId: string | null;
  /** Título/nome do pai pra montar o motivo. `null` quando não dá pra descobrir. */
  rotulo: string | null;
}

/**
 * Resolve o pai que o usuário apontou. Ponteiro quebrado (chave inexistente ou
 * o próprio arquivo) é IGNORADO de propósito: melhor cair nas heurísticas de
 * versão/irmão do que rotular o arquivo como anexo de coisa nenhuma.
 * Se o usuário apontar os dois, o documento do cofre ganha (é o vínculo real).
 */
function resolverPai(
  arquivo: ArquivoDoLote,
  porChave: Map<string, ArquivoDoLote>,
  documentosNoCofre: DocumentoNoCofre[]
): PaiApontado | null {
  const paiId = (arquivo.anexoDeDocumentoId ?? "").trim();
  if (paiId) {
    const doc = documentosNoCofre.find((d) => d.id === paiId);
    return {
      origem: "COFRE",
      chaveRelacionada: null,
      documentoRelacionadoId: paiId,
      rotulo: doc ? doc.titulo : null,
    };
  }

  const paiChave = (arquivo.anexoDeChave ?? "").trim();
  if (paiChave && paiChave !== arquivo.chave) {
    const irmao = porChave.get(paiChave);
    if (irmao) {
      return {
        origem: "LOTE",
        chaveRelacionada: paiChave,
        documentoRelacionadoId: null,
        rotulo: irmao.nomeArquivo,
      };
    }
  }

  return null;
}

/**
 * Classifica cada arquivo do lote. Função PURA: nenhuma chamada de rede, nenhum
 * acesso a `Date.now()` — dá o mesmo resultado pra mesma entrada, e por isso é
 * ela (e não a tela) que carrega o teste.
 *
 * Precedência, nesta ordem:
 *   1. DUPLICATA — bytes idênticos, no cofre ou no próprio lote. Vence tudo:
 *      mesmo que o usuário tenha apontado pai e operação, subir o mesmo arquivo
 *      de novo só gera lixo no MinIO. É a única relação que BLOQUEIA.
 *   2. ANEXO — declaração explícita do usuário ganha de qualquer heurística.
 *   3. VERSAO — mesma operação e mesmo número de documento.
 *   4. IRMAO  — mesma operação, número diferente (ou sem número).
 *   5. NOVO   — nada disso.
 *
 * Assimetria proposital: duplicata precisa de um sobrevivente, então a PRIMEIRA
 * ocorrência do hash no lote fica limpa e as seguintes é que são marcadas. Já
 * VERSAO e IRMAO são relações simétricas — marcam os dois lados, porque os dois
 * lados interessam ao usuário.
 *
 * Devolve na MESMA ordem do array de entrada, um resultado por arquivo.
 */
export function classificarRelacao(entrada: EntradaClassificacao): RelacaoArquivo[] {
  const { arquivos, existentesPorSha, documentosNoCofre = [] } = entrada;

  const porChave = new Map<string, ArquivoDoLote>();
  for (const arquivo of arquivos) porChave.set(arquivo.chave, arquivo);

  // sha → primeira ocorrência no lote. Preenchido conforme se percorre, pra que
  // só as ocorrências SEGUINTES sejam duplicatas.
  const primeiraPorSha = new Map<string, ArquivoDoLote>();

  const resultado: RelacaoArquivo[] = [];

  for (const arquivo of arquivos) {
    const sha = normalizarSha(arquivo.sha256);
    const gemeaNoLote = sha ? primeiraPorSha.get(sha) : undefined;
    if (sha && !primeiraPorSha.has(sha)) primeiraPorSha.set(sha, arquivo);

    // 1. DUPLICATA no cofre (o /verificar já respondeu que esse hash existe).
    const jaNoCofre: DuplicataNoCofre | undefined = sha ? existentesPorSha[sha] : undefined;
    if (jaNoCofre) {
      resultado.push({
        chave: arquivo.chave,
        relacao: "DUPLICATA",
        origem: "COFRE",
        chaveRelacionada: null,
        documentoRelacionadoId: jaNoCofre.id,
        duplicataNoCofre: jaNoCofre,
        motivo: `Arquivo idêntico já está no cofre: "${jaNoCofre.titulo}".`,
        bloqueia: true,
      });
      continue;
    }

    // 1b. DUPLICATA dentro do próprio lote — o caso que hoje passa batido.
    if (gemeaNoLote) {
      resultado.push({
        chave: arquivo.chave,
        relacao: "DUPLICATA",
        origem: "LOTE",
        chaveRelacionada: gemeaNoLote.chave,
        documentoRelacionadoId: null,
        duplicataNoCofre: null,
        motivo: `Arquivo idêntico a "${gemeaNoLote.nomeArquivo}" neste mesmo lote.`,
        bloqueia: true,
      });
      continue;
    }

    // 2. ANEXO — o usuário apontou o pai.
    const pai = resolverPai(arquivo, porChave, documentosNoCofre);
    if (pai) {
      resultado.push({
        chave: arquivo.chave,
        relacao: "ANEXO",
        origem: pai.origem,
        chaveRelacionada: pai.chaveRelacionada,
        documentoRelacionadoId: pai.documentoRelacionadoId,
        duplicataNoCofre: null,
        motivo: pai.rotulo
          ? `Anexo do documento "${pai.rotulo}".`
          : "Anexo de um documento já existente no cofre.",
        bloqueia: false,
      });
      continue;
    }

    // Sem operação escolhida não há como falar em versão nem em prova irmã.
    if (!arquivo.operacaoId) {
      resultado.push({
        chave: arquivo.chave,
        relacao: "NOVO",
        origem: null,
        chaveRelacionada: null,
        documentoRelacionadoId: null,
        duplicataNoCofre: null,
        motivo: "Nenhuma relação: a operação ainda não foi escolhida.",
        bloqueia: false,
      });
      continue;
    }

    const numero = normalizarNumeroDocumento(arquivo.numeroDocumento);
    const numeroExibicao = (arquivo.numeroDocumento ?? "").trim();

    const docsDaOperacao = documentosNoCofre.filter((d) => d.operacaoId === arquivo.operacaoId);
    const outrosDoLote = arquivos.filter(
      (a) => a.chave !== arquivo.chave && a.operacaoId === arquivo.operacaoId
    );

    // 3. VERSAO — mesmo número de documento na mesma operação. O documento já
    //    guardado tem preferência sobre um irmão do lote: é dele que a nova
    //    versão descende.
    if (numero) {
      const versaoNoCofre = docsDaOperacao.find(
        (d) => normalizarNumeroDocumento(d.numeroDocumento) === numero
      );
      if (versaoNoCofre) {
        resultado.push({
          chave: arquivo.chave,
          relacao: "VERSAO",
          origem: "COFRE",
          chaveRelacionada: null,
          documentoRelacionadoId: versaoNoCofre.id,
          duplicataNoCofre: null,
          motivo: `Mesmo número (${numeroExibicao}) do documento "${versaoNoCofre.titulo}" nesta operação — entra como nova versão.`,
          bloqueia: false,
        });
        continue;
      }

      const versaoNoLote = outrosDoLote.find(
        (a) => normalizarNumeroDocumento(a.numeroDocumento) === numero
      );
      if (versaoNoLote) {
        resultado.push({
          chave: arquivo.chave,
          relacao: "VERSAO",
          origem: "LOTE",
          chaveRelacionada: versaoNoLote.chave,
          documentoRelacionadoId: null,
          duplicataNoCofre: null,
          motivo: `Mesmo número (${numeroExibicao}) de "${versaoNoLote.nomeArquivo}" neste lote — são versões do mesmo documento.`,
          bloqueia: false,
        });
        continue;
      }
    }

    // 4. IRMAO — mesma operação, número diferente: as duas provas ficam.
    const irmaoNoCofre = docsDaOperacao[0];
    if (irmaoNoCofre) {
      resultado.push({
        chave: arquivo.chave,
        relacao: "IRMAO",
        origem: "COFRE",
        chaveRelacionada: null,
        documentoRelacionadoId: irmaoNoCofre.id,
        duplicataNoCofre: null,
        motivo: `A operação já tem a prova "${irmaoNoCofre.titulo}" no cofre — esta entra como prova adicional.`,
        bloqueia: false,
      });
      continue;
    }

    const irmaoNoLote = outrosDoLote[0];
    if (irmaoNoLote) {
      resultado.push({
        chave: arquivo.chave,
        relacao: "IRMAO",
        origem: "LOTE",
        chaveRelacionada: irmaoNoLote.chave,
        documentoRelacionadoId: null,
        duplicataNoCofre: null,
        motivo: `Mesma operação de "${irmaoNoLote.nomeArquivo}" neste lote — provas irmãs, as duas são guardadas.`,
        bloqueia: false,
      });
      continue;
    }

    // 5. NOVO.
    resultado.push({
      chave: arquivo.chave,
      relacao: "NOVO",
      origem: null,
      chaveRelacionada: null,
      documentoRelacionadoId: null,
      duplicataNoCofre: null,
      motivo: "Primeira prova desta operação no cofre.",
      bloqueia: false,
    });
  }

  return resultado;
}

// ── Título sugerido ──────────────────────────────────────────────────────────

/** Título do cofre tem no máximo 200 caracteres (CriarDocumentoSchema). */
const TITULO_MAX = 200;

/**
 * Sugere o título do documento a partir do nome do arquivo.
 *
 * Mantém o que era útil no hábito atual (o título legível vindo do nome) e joga
 * fora o que era ruim: o prefixo "10008 - " digitado à mão, que só existia
 * porque a operação não era entidade. Agora a operação é coluna — repetir o
 * código no título só polui a lista e atrapalha a busca.
 *
 * Reaproveita `tituloDoNome` de `inferir-categoria.ts` (tira extensão, troca
 * `_`/`-` por espaço) e só então remove o código da operação do começo.
 */
export function tituloSugerido(nomeArquivo: string, operacaoCodigo?: string | null): string {
  const limpo = tituloDoNome(nomeArquivo);

  let titulo = limpo;
  const codigo = (operacaoCodigo ?? "").trim();
  if (codigo) {
    // Remove o código no início junto com o separador que vier depois dele
    // (" - ", ".", ":", "–"). Repete enquanto casar: há nomes com o código duas
    // vezes ("10008 10008 ACT.pdf").
    const prefixo = new RegExp(`^${escaparRegex(codigo)}(?![0-9A-Za-z])[\\s.:;,\\-–—]*`, "i");
    while (prefixo.test(titulo)) {
      titulo = titulo.replace(prefixo, "");
    }
  }

  titulo = titulo.replace(/\s+/g, " ").trim();

  // Se sobrou coisa nenhuma (arquivo chamado só "10008.pdf"), é melhor devolver
  // o nome legível do que um título vazio, que o schema recusaria.
  if (titulo.length < 2) titulo = limpo.trim();
  if (titulo.length < 2) titulo = nomeArquivo.trim();

  return titulo.length > TITULO_MAX ? titulo.slice(0, TITULO_MAX).trim() : titulo;
}

/** O código da operação vem do banco e pode ter ponto/hífen — não pode virar metacaractere. */
function escaparRegex(valor: string): string {
  return valor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Título padronizado da operação: "CÓDIGO — CLIENTE — OBJETO".
 *
 * Padrão adotado para o acervo tratado: o cliente é o
 * grupo curto (ex.: PETROBRAS) quando existir, e o objeto é a PRIMEIRA
 * linha do escopo — o enriquecimento grava o objeto curto na 1ª linha e o
 * texto integral da cláusula depois de uma linha em branco. Operação ainda
 * não enriquecida (escopo vazio) degrada para "CÓDIGO — CLIENTE", que era o
 * título antigo — nada quebra.
 */
export function tituloOperacao(op: {
  codigo: string;
  clienteNome: string;
  clienteGrupo?: string | null;
  escopo?: string | null;
}): string {
  const cliente = op.clienteGrupo?.trim() || op.clienteNome;
  const objeto = (op.escopo ?? "").split("\n", 1)[0].trim();
  return objeto ? `${op.codigo} — ${cliente} — ${objeto}` : `${op.codigo} — ${cliente}`;
}
