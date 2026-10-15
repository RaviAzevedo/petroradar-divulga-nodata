/**
 * Funções PURAS do digest de e-mail (0026) — sem dependência de banco, para
 * serem testáveis em unit (vitest) sem carregar o driver pg. A seleção SQL e o
 * envio vivem em lib/digest/licitacoes.ts, que reexporta este módulo.
 */

export interface CriteriosFiltroEmail {
  keywords_incluir?: string[];
  keywords_excluir?: string[];
  naturezas?:        string[];
  tipos_servico?:    string[];
  segmentos?:        string[];
  estados?:          string[];                    // UFs — ILIKE em licitacoes.regioes
  min_relevancia?:   "ALTA" | "MEDIA" | "TODAS";  // piso de score do sistema (opcional)
  /**
   * Assinatura por PERFIL DE INTERESSE (0029). Quando presente, o casamento é
   * `licitacoes.perfis_match ILIKE '%<perfil>%'` — a MESMA coluna que o motor de
   * classificação preenche e que o filtro `perfil=` do /explorar usa. Assim
   * "o que aparece no Explorar com este perfil" e "o que chega por e-mail" são a
   * mesma coisa por construção, em vez de dois conjuntos de critérios paralelos.
   */
  perfil?:           string;
}

/** Piso de score do sistema por relevância mínima (mesma régua do motor). */
export const SCORE_POR_RELEVANCIA: Record<string, number> = { ALTA: 75, MEDIA: 55, TODAS: 0 };

/** Janela máxima de retroação do digest (evita backlog gigante na 1ª execução). */
export const JANELA_MAX_DIAS = 7;

const soStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "") : [];

/**
 * UF → nome por extenso. licitacoes.regioes grava NOMES COMPLETOS no fluxo
 * petronect ("Rio de Janeiro, Bahia") e "Cidade/UF" no fluxo transparência —
 * um ILIKE por sigla crua nunca casa ('%RJ%'=0 linhas) ou casa errado
 * ('%PA%' pega São PAulo/Paraná/Pará; achado do review 2026-07-08). A seleção
 * usa o nome completo E o sufixo "/UF".
 */
export const UF_PARA_NOME: Record<string, string> = {
  AC: "Acre", AL: "Alagoas", AP: "Amapá", AM: "Amazonas", BA: "Bahia",
  CE: "Ceará", DF: "Distrito Federal", ES: "Espírito Santo", GO: "Goiás",
  MA: "Maranhão", MT: "Mato Grosso", MS: "Mato Grosso do Sul",
  MG: "Minas Gerais", PA: "Pará", PB: "Paraíba", PR: "Paraná",
  PE: "Pernambuco", PI: "Piauí", RJ: "Rio de Janeiro",
  RN: "Rio Grande do Norte", RS: "Rio Grande do Sul", RO: "Rondônia",
  RR: "Roraima", SC: "Santa Catarina", SP: "São Paulo", SE: "Sergipe",
  TO: "Tocantins",
};

/** Parse defensivo do jsonb criterios (pode vir de edição manual). */
export function normalizarCriterios(raw: unknown): CriteriosFiltroEmail {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rel = typeof c.min_relevancia === "string" ? c.min_relevancia.toUpperCase() : "TODAS";
  return {
    keywords_incluir: soStrings(c.keywords_incluir),
    keywords_excluir: soStrings(c.keywords_excluir),
    naturezas:        soStrings(c.naturezas),
    tipos_servico:    soStrings(c.tipos_servico),
    segmentos:        soStrings(c.segmentos),
    perfil:           typeof c.perfil === "string" && c.perfil.trim() ? c.perfil.trim() : undefined,
    // Só UFs VÁLIDAS sobrevivem (mata lixo e curingas %/_ de ILIKE na raiz).
    estados:          soStrings(c.estados)
      .map((uf) => uf.trim().toUpperCase())
      .filter((uf) => uf in UF_PARA_NOME),
    min_relevancia:   rel === "ALTA" || rel === "MEDIA" ? (rel as "ALTA" | "MEDIA") : "TODAS",
  };
}

/** Remove acentos (mesma semântica do f_unaccent do banco, migration 0018). */
function semAcento(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Escapa metacaracteres de regex — o input vem do painel admin. */
function escaparRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Monta a regex de keywords com fronteira de palavra do Postgres (\m/\M),
 * aplicada POR keyword e SÓ quando a borda é alfanumérica — \m antes de "("
 * (ex.: keyword "(EPC)") é insatisfazível e mataria o branch em silêncio
 * (achado do review 2026-07-08). Case é do ~*. Null se a lista for vazia.
 */
export function montarRegexKeywords(keywords: string[]): string | null {
  const branches = keywords
    .map((k) => semAcento(k.trim()))
    .filter(Boolean)
    .map((kw) => {
      const esc = escaparRegex(kw);
      const pre = /^[a-z0-9]/i.test(kw) ? "\\m" : "";
      const suf = /[a-z0-9]$/i.test(kw) ? "\\M" : "";
      return `${pre}${esc}${suf}`;
    });
  if (branches.length === 0) return null;
  return `(?:${branches.join("|")})`;
}

/**
 * A assinatura "venceu" (deve receber nesta rodada)? tempo-real = toda rodada;
 * diario = ≥4h desde o último envio (as duas janelas do dia — ver o comentário
 * longo abaixo); semanal = ≥6,5 dias. Sem envio anterior, qualquer cadência
 * está vencida.
 */
export function cadenciaVencida(frequencia: string, ultimoEnvioEm: Date | null): boolean {
  if (!ultimoEnvioEm) return true;
  if (frequencia === "tempo-real") return true;

  const horas = (Date.now() - ultimoEnvioEm.getTime()) / 3_600_000;

  // "diario" = as JANELAS do dia (07:00 e 13:00 BRT), não uma vez a cada 20h.
  //
  // A regra antiga (20h desde o último envio) ancorava o envio no horário do
  // último disparo: quem recebia às 16:45 só voltava a receber às 16:45 do dia
  // seguinte, e a rodada da manhã era SEMPRE pulada.
  //
  // Quem impede repetição de CONTEÚDO é o ledger, não este relógio: se nada novo
  // apareceu entre 07h e 13h, o digest simplesmente não envia. Então aqui basta
  // uma folga que libere as duas janelas (6h de distância) e barre disparo
  // repetido do mesmo slot — por exemplo, alguém executando o cron na mão.
  if (frequencia === "diario") return horas >= 4;
  if (frequencia === "semanal") return horas >= 156; // 6,5 dias
  return false;
}


/** Janela da busca: desde o último envio, com teto de retroação de 7 dias. */
export function janelaDesde(ultimoEnvioEm: Date | null): Date {
  const teto = new Date(Date.now() - JANELA_MAX_DIAS * 24 * 3_600_000);
  if (!ultimoEnvioEm || ultimoEnvioEm < teto) return teto;
  return ultimoEnvioEm;
}
