/**
 * Editor estendido do documento (WP-13, 03-FRONTEND secao 8.3) — a parte pura.
 *
 * A regra "PATCH manda so o que mudou" e contrato: o audit de R8 registra
 * antes/depois so dos campos presentes no body, entao mandar campo intacto
 * sujaria o rastro. O diff e funcao pura para carregar teste (padrao do
 * modulo) e para o modal ficar so com estado e rede.
 */

import type {
  Detentora,
  PapelDocumento,
  SituacaoProva,
  TipoDocumento,
} from "@/lib/conformidade/operacoes";

/** O que o detalhe (R17) fornece e o diff compara. */
export interface DocumentoEditavel {
  titulo: string;
  descricao: string | null;
  categoria: string;
  subcategoria: string;
  numeroDocumento: string | null;
  /**
   * 0044 (B6) — revisao de ENGENHARIA, como carimbada no documento ("R0",
   * "02A", "Rev. C"). NAO e `versao` (o versionamento de certidao do cofre).
   *
   * OPCIONAL de proposito (spec ONDA-5 §1i): `DetalheDocumento` da
   * GavetaDocumento estende este tipo, e a gaveta e arquivo PROIBIDO nesta
   * onda (§6.4) — opcional e o que a faz compilar e funcionar sem ser tocada.
   * Ausente e `null` valem a mesma coisa, e o diff compara com `?? null`.
   */
  revisao?: string | null;
  status: string;
  /** ISO ou null, como R17 devolve. */
  emitidoEm: string | null;
  validadeFim: string | null;
  validadeIndeterminada: boolean;
  tags: string[] | null;
  operacaoId: string | null;
  papel: PapelDocumento | null;
  tipoDocumento: TipoDocumento | null;
  situacaoProva: SituacaoProva | null;
  detentora: Detentora | null;
  restrito: boolean;
  /**
   * 0043 — disciplina do documento. OPCIONAL de proposito (spec ONDA-4 §1f): a
   * fixture `docBase` do teste preenche campo a campo, e campo obrigatorio novo
   * aqui quebraria a compilacao dela. Ausente e `null` valem a mesma coisa —
   * "sem disciplina" — e o diff compara com `?? null`.
   */
  disciplinaId?: string | null;
}

/** Estado do formulario do modal (strings de input; "" = vazio/sem valor). */
export interface FormularioDocumento {
  titulo: string;
  descricao: string;
  categoria: string;
  subcategoria: string;
  numeroDocumento: string;
  /** "" = sem revisao. So e construido por `formularioInicial`, entao pode ser
   *  obrigatorio aqui (ao contrario do `DocumentoEditavel`). */
  revisao: string;
  status: string;
  /** "yyyy-mm-dd" ou "". */
  emitidoEm: string;
  validadeFim: string;
  validadeIndeterminada: boolean;
  /** Texto separado por virgula, como no modal atual. */
  tagsTexto: string;
  /** Vinculo escolhido no formulario; null = desvinculado/sem operacao. */
  operacaoId: string | null;
  /** So tem efeito quando o PATCH desvincula (operacao existente -> null). */
  limparPapelAoDesvincular: boolean;
  papel: PapelDocumento | "";
  tipoDocumento: TipoDocumento | "";
  situacaoProva: SituacaoProva | "";
  detentora: Detentora | "";
  restrito: boolean;
  /** "" = sem disciplina. So e construido por `formularioInicial`, entao pode
   *  ser obrigatorio aqui (ao contrario do `DocumentoEditavel`). */
  disciplinaId: string;
}

/** Preenche o formulario a partir do documento carregado (estado inicial do modal). */
export function formularioInicial(doc: DocumentoEditavel): FormularioDocumento {
  return {
    titulo: doc.titulo,
    descricao: doc.descricao ?? "",
    categoria: doc.categoria,
    subcategoria: doc.subcategoria,
    numeroDocumento: doc.numeroDocumento ?? "",
    revisao: doc.revisao ?? "",
    status: doc.status,
    emitidoEm: doc.emitidoEm ? doc.emitidoEm.slice(0, 10) : "",
    validadeFim: doc.validadeFim ? doc.validadeFim.slice(0, 10) : "",
    validadeIndeterminada: doc.validadeIndeterminada,
    tagsTexto: (doc.tags ?? []).join(", "),
    operacaoId: doc.operacaoId,
    limparPapelAoDesvincular: true,
    papel: doc.papel ?? "",
    tipoDocumento: doc.tipoDocumento ?? "",
    situacaoProva: doc.situacaoProva ?? "",
    detentora: doc.detentora ?? "",
    restrito: doc.restrito,
    disciplinaId: doc.disciplinaId ?? "",
  };
}

/** Data "yyyy-mm-dd" do input -> ISO (convencao do modal atual) ou null. */
function dataParaIso(valor: string): string | null {
  return valor ? new Date(valor).toISOString() : null;
}

/** Fatia "yyyy-mm-dd" de um ISO/null para comparar com o valor do input date. */
function fatiaData(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

/** Texto de tags -> array normalizado (mesma regra do modal atual). */
export function parseTags(texto: string): string[] {
  return texto.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Monta o body do PATCH SO com o que mudou em relacao ao documento original.
 * Regras de R8 respeitadas:
 *  - `operacaoId: null` desvincula e NAO limpa `papel` sozinho — a limpeza e o
 *    checkbox `limparPapelAoDesvincular`, que manda `papel: null` junto;
 *  - `papel`/`tipoDocumento`/`situacaoProva`/`detentora`: `null` limpa, valor
 *    troca, AUSENTE nao mexe;
 *  - `restrito` so entra quando alterado (o 403 de campo e para quem mexeu).
 * Devolve objeto vazio quando nada mudou (o modal fecha sem PATCH).
 */
export function montarPatchDocumento(
  original: DocumentoEditavel,
  form: FormularioDocumento
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  const titulo = form.titulo.trim();
  if (titulo !== original.titulo) body.titulo = titulo;

  const descricao = form.descricao.trim() || null;
  if (descricao !== (original.descricao ?? null)) body.descricao = descricao;

  if (form.categoria !== original.categoria) body.categoria = form.categoria;
  if (form.subcategoria !== original.subcategoria) body.subcategoria = form.subcategoria;

  const numero = form.numeroDocumento.trim() || null;
  if (numero !== (original.numeroDocumento ?? null)) body.numeroDocumento = numero;

  // 0044 (B6) — mesma regra dos demais: null limpa, valor troca, ausente nao
  // mexe. O `?? null` do original cobre o documento carregado por uma API
  // anterior a esta onda (a chave simplesmente nao vem).
  const rev = form.revisao.trim() || null;
  if (rev !== (original.revisao ?? null)) body.revisao = rev;

  if (form.status !== original.status) body.status = form.status;

  if (form.emitidoEm !== fatiaData(original.emitidoEm)) {
    body.emitidoEm = dataParaIso(form.emitidoEm);
  }

  // Validade: indeterminada zera a data (mesma regra do modal atual).
  const validadeFimForm = form.validadeIndeterminada ? "" : form.validadeFim;
  if (validadeFimForm !== fatiaData(original.validadeFim)) {
    body.validadeFim = dataParaIso(validadeFimForm);
  }
  if (form.validadeIndeterminada !== original.validadeIndeterminada) {
    body.validadeIndeterminada = form.validadeIndeterminada;
  }

  const tags = parseTags(form.tagsTexto);
  const tagsOriginais = original.tags ?? [];
  const tagsIguais =
    tags.length === tagsOriginais.length && tags.every((t, i) => t === tagsOriginais[i]);
  if (!tagsIguais) body.tags = tags;

  // ── Vinculo com a operacao ──────────────────────────────────────────────
  const desvinculou = original.operacaoId !== null && form.operacaoId === null;
  if (form.operacaoId !== original.operacaoId) body.operacaoId = form.operacaoId;

  const papelForm: PapelDocumento | null = form.papel === "" ? null : form.papel;
  if (desvinculou && form.limparPapelAoDesvincular) {
    body.papel = null;
  } else if (papelForm !== original.papel) {
    body.papel = papelForm;
  }

  const tipoForm: TipoDocumento | null = form.tipoDocumento === "" ? null : form.tipoDocumento;
  if (tipoForm !== original.tipoDocumento) body.tipoDocumento = tipoForm;

  const situacaoForm: SituacaoProva | null =
    form.situacaoProva === "" ? null : form.situacaoProva;
  if (situacaoForm !== original.situacaoProva) body.situacaoProva = situacaoForm;

  const detentoraForm: Detentora | null = form.detentora === "" ? null : form.detentora;
  if (detentoraForm !== original.detentora) body.detentora = detentoraForm;

  // 0043 — mesma regra dos campos acima: null limpa, valor troca, ausente nao
  // mexe. O `?? null` do original cobre o documento carregado por uma API
  // anterior a esta onda (a chave simplesmente nao vem).
  const disciplinaForm: string | null = form.disciplinaId === "" ? null : form.disciplinaId;
  if (disciplinaForm !== (original.disciplinaId ?? null)) body.disciplinaId = disciplinaForm;

  if (form.restrito !== original.restrito) body.restrito = form.restrito;

  return body;
}

// ── Aviso informativo de divergencia tipo x subcategoria (secao 8.3-3) ──────

/**
 * Subcategoria canonica por tipo (tabela 00-ARQUITETURA secao 1.2).
 * NOTA DE DIVIDA: quando `DERIVACAO_POR_TIPO` (adicao A1 do plano) aterrissar
 * em `@/lib/conformidade/operacoes`, este mapa deve ser trocado pelo import —
 * e a mesma tabela, aqui so o recorte da subcategoria.
 */
const SUBCATEGORIA_CANONICA_POR_TIPO: Record<TipoDocumento, string> = {
  ART: "ART_CAT", CAT: "ART_CAT", ATESTADO: "ATESTADO_ACT",
  CONTRATO: "OUTRO", ADITIVO: "OUTRO", ANEXO_CONTRATO: "OUTRO",
  CREA_PJ: "CREA_PJ", ISO: "ISO_9001", DECLARACAO: "DECL_OUTRA",
  PROPOSTA: "OUTROS_TECNICOS", ANEXO_ET: "OUTROS_TECNICOS",
  DOC_PROJETO: "OUTROS_TECNICOS", PEDIDO: "OUTRO", NF: "OUTRO",
  CARTA: "OUTRO", RELATORIO: "OUTROS_TECNICOS", PESSOAL: "FORMACAO",
  CAPA_OP: "OUTRO", COMPACTADO: "OUTROS_TECNICOS", OUTRO: "OUTROS_TECNICOS",
};

/**
 * Edicao corrige, nao re-deriva: trocar o tipo NAO reescreve a subcategoria ja
 * gravada — este predicado so acende o aviso "tipo e subcategoria divergem da
 * tabela canonica" (informativo, nunca bloqueia). Excecao ISO: qualquer
 * ISO_9001/14001/45001 e canonica (a variante vem do nome do arquivo).
 */
export function tipoESubcategoriaDivergem(
  tipo: TipoDocumento | "",
  subcategoria: string
): boolean {
  if (tipo === "") return false;
  if (tipo === "ISO") return !/^ISO_(9001|14001|45001)$/.test(subcategoria);
  return SUBCATEGORIA_CANONICA_POR_TIPO[tipo] !== subcategoria;
}
