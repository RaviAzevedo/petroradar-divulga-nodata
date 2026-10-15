/**
 * Inferência de categoria/subcategoria a partir do path do arquivo na rede SGI.
 *
 * Convenção esperada (relativa à raiz da importação):
 *   01_Familias/<codigo>_<nome>/<arquivo>.pdf
 *   02_Habilitacao/01_Juridica/<arquivo>.pdf
 *   02_Habilitacao/02_Fiscal/<arquivo>.pdf
 *   02_Habilitacao/03_Economica/<arquivo>.pdf
 *   02_Habilitacao/04_Tecnica/<arquivo>.pdf
 *   02_Habilitacao/05_Pessoal/<arquivo>.pdf
 *   02_Habilitacao/06_Declaracoes/<arquivo>.pdf
 *   03_Atestados_ACT/<arquivo>.pdf
 *   04_Contratos/<numero>_<descricao>/<arquivo>.pdf
 *
 * O parser também tenta extrair validade do nome via regex `_(\d{4}-\d{2}-\d{2})`.
 */

import type { CategoriaDocHab, SubcategoriaDocHab } from "@/db/schema";

export type Destino =
  | { tipo: "FAMILIA_ANEXO"; codigoFamilia: string }
  | { tipo: "DOCUMENTO_HABILITACAO"; categoria: CategoriaDocHab; subcategoria: SubcategoriaDocHab }
  | { tipo: "ACT"; categoria: "TECNICA"; subcategoria: "ATESTADO_ACT" }
  | { tipo: "CONTRATO_ANEXO"; numeroContrato: string }
  | { tipo: "DESCONHECIDO"; motivo: string };

const NOME_TO_CATEGORIA: Record<string, { categoria: CategoriaDocHab; defaultSub: SubcategoriaDocHab }> = {
  "01_juridica":     { categoria: "JURIDICA",             defaultSub: "CONTRATO_SOCIAL" },
  "02_fiscal":       { categoria: "FISCAL",               defaultSub: "CND_FEDERAL" },
  "03_economica":    { categoria: "ECONOMICA",            defaultSub: "BALANCO" },
  "04_tecnica":      { categoria: "TECNICA",              defaultSub: "OUTROS_TECNICOS" },
  "05_pessoal":      { categoria: "QUALIFICACAO_PESSOAL", defaultSub: "CREA_PJ" },
  "06_declaracoes":  { categoria: "DECLARACAO",           defaultSub: "DECL_OUTRA" },
};

// Mapeamento de palavras-chave no nome do arquivo → subcategoria específica
const KEYWORDS_SUBCATEGORIA: Array<{ regex: RegExp; sub: SubcategoriaDocHab }> = [
  { regex: /cnd[_-]?federal|pgfn|receita/i, sub: "CND_FEDERAL" },
  { regex: /fgts|crf/i,                     sub: "FGTS" },
  { regex: /cndt/i,                          sub: "CNDT" },
  { regex: /cnd[_-]?estadual|sefaz/i,        sub: "CND_ESTADUAL" },
  { regex: /cnd[_-]?municipal/i,             sub: "CND_MUNICIPAL" },
  { regex: /falencia|concordata/i,           sub: "FALENCIA" },
  { regex: /balanco|dre|dfc/i,               sub: "BALANCO" },
  { regex: /indices|liquidez/i,              sub: "INDICES_FINANCEIROS" },
  { regex: /contrato[_-]?social/i,           sub: "CONTRATO_SOCIAL" },
  { regex: /cartao[_-]?cnpj|cnpj/i,          sub: "CNPJ" },
  { regex: /ato[_-]?constitutivo/i,          sub: "ATO_CONSTITUTIVO" },
  { regex: /procuracao/i,                    sub: "PROCURACAO" },
  { regex: /act|atestado/i,                  sub: "ATESTADO_ACT" },
  { regex: /iso[_-]?9001/i,                  sub: "ISO_9001" },
  { regex: /iso[_-]?14001/i,                 sub: "ISO_14001" },
  { regex: /iso[_-]?45001/i,                 sub: "ISO_45001" },
  { regex: /nr[_-]?10/i,                     sub: "NR_10" },
  { regex: /nr[_-]?13/i,                     sub: "NR_13" },
  { regex: /nr[_-]?35/i,                     sub: "NR_35" },
  { regex: /asme/i,                          sub: "ASME" },
  { regex: /api[_-]?q1/i,                    sub: "API_Q1" },
  { regex: /api[_-]?6d/i,                    sub: "API_6D" },
  { regex: /\bped\b/i,                       sub: "PED" },
  { regex: /crea[_-]?pj/i,                   sub: "CREA_PJ" },
  { regex: /crea[_-]?pf/i,                   sub: "CREA_PF" },
  { regex: /\bart\b|\bcat\b/i,               sub: "ART_CAT" },
  { regex: /ctps/i,                          sub: "CTPS" },
  { regex: /formacao|diploma/i,              sub: "FORMACAO" },
  { regex: /menor[_-]?nao[_-]?emprega/i,     sub: "DECL_MENOR_NAO_EMPREGA" },
  { regex: /idoneidade/i,                    sub: "DECL_IDONEIDADE" },
  { regex: /me[_-]?epp/i,                    sub: "DECL_ME_EPP" },
];

function normalizarSegmento(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function inferirDestino(pathRelativo: string): Destino {
  // Normaliza separadores e tira leading slashes
  const partes = pathRelativo.replace(/\\/g, "/").replace(/^\/+/, "").split("/");
  if (partes.length < 2) {
    return { tipo: "DESCONHECIDO", motivo: "Path muito curto pra inferir" };
  }

  const top = normalizarSegmento(partes[0]);
  const arquivo = partes[partes.length - 1];

  // 01_Familias/<codigo>_<nome>/<arquivo>.pdf
  if (top.startsWith("01_familias") || top === "familias") {
    const familiaSeg = partes[1] ?? "";
    // Extrai código (até o primeiro _ ou espaço)
    const codigoMatch = familiaSeg.match(/^([A-Za-z0-9.\-]+)/);
    const codigo = codigoMatch ? codigoMatch[1] : familiaSeg;
    return { tipo: "FAMILIA_ANEXO", codigoFamilia: codigo };
  }

  // 02_Habilitacao/<categoria>/<arquivo>.pdf
  if (top.startsWith("02_habilitacao") || top === "habilitacao") {
    const catSeg = normalizarSegmento(partes[1] ?? "");
    const meta = NOME_TO_CATEGORIA[catSeg];
    if (!meta) {
      return { tipo: "DESCONHECIDO", motivo: `Categoria desconhecida: ${catSeg}` };
    }
    // Tenta extrair subcategoria do nome do arquivo
    let sub: SubcategoriaDocHab = meta.defaultSub;
    for (const kw of KEYWORDS_SUBCATEGORIA) {
      if (kw.regex.test(arquivo)) {
        sub = kw.sub;
        break;
      }
    }
    return { tipo: "DOCUMENTO_HABILITACAO", categoria: meta.categoria, subcategoria: sub };
  }

  // 03_Atestados_ACT/<arquivo>.pdf
  if (top.startsWith("03_atestados") || top === "atestados_act" || top === "act") {
    return { tipo: "ACT", categoria: "TECNICA", subcategoria: "ATESTADO_ACT" };
  }

  // 04_Contratos/<numero>_<descricao>/<arquivo>.pdf
  if (top.startsWith("04_contratos") || top === "contratos") {
    const contratoSeg = partes[1] ?? "";
    const numMatch = contratoSeg.match(/^([0-9A-Za-z\-]+)/);
    const numero = numMatch ? numMatch[1] : contratoSeg;
    return { tipo: "CONTRATO_ANEXO", numeroContrato: numero };
  }

  return { tipo: "DESCONHECIDO", motivo: `Top-level "${top}" não reconhecido` };
}

/** Extrai validadeFim do nome do arquivo via convenção `_YYYY-MM-DD.pdf` */
export function extrairValidadeDoNome(nomeArquivo: string): Date | null {
  const m = nomeArquivo.match(/[_\-](\d{4}-\d{2}-\d{2})(?:\.[a-z]+)?$/i);
  if (!m) return null;
  const d = new Date(`${m[1]}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

/** Extrai título limpo do nome do arquivo (remove timestamp e extensão) */
export function tituloDoNome(nomeArquivo: string): string {
  return nomeArquivo
    .replace(/\.[a-z]+$/i, "")
    .replace(/^\d+_/, "")
    .replace(/[_\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
