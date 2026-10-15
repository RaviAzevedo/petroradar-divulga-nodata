/**
 * Constantes de apresentação do painel de E-mails (digest 0026) — fora da page
 * porque o App Router restringe os exports de page.tsx (padrão roles-ui).
 */

export const FORMATO_LABELS: Record<string, string> = {
  resumido: "Resumido",
  completo: "Completo",
};

export const FREQUENCIA_LABELS: Record<string, string> = {
  "tempo-real": "Tempo real",
  diario:       "Diário",
  semanal:      "Semanal",
};

export const FREQUENCIA_DESC: Record<string, string> = {
  "tempo-real": "A cada rodada do sistema (3x/dia, após as coletas)",
  diario:       "No máximo 1 e-mail por dia",
  semanal:      "No máximo 1 e-mail por semana",
};

export const RELEVANCIA_OPCOES: { value: string; label: string; desc: string }[] = [
  { value: "TODAS", label: "Todas",        desc: "Qualquer licitação que case com o filtro" },
  { value: "MEDIA", label: "Média ou alta", desc: "Score do sistema ≥ 55" },
  { value: "ALTA",  label: "Só alta",       desc: "Score do sistema ≥ 75" },
];

/** Resumo curto dos critérios de um filtro p/ exibir em badges na lista. */
export function resumirCriterios(c: Record<string, unknown> | null | undefined): string[] {
  if (!c) return ["Todas as licitações"];
  const partes: string[] = [];
  const arr = (k: string) => (Array.isArray(c[k]) ? (c[k] as string[]) : []);
  if (arr("keywords_incluir").length) partes.push(`${arr("keywords_incluir").length} palavra(s)-chave`);
  if (arr("keywords_excluir").length) partes.push(`${arr("keywords_excluir").length} exclusão(ões)`);
  if (arr("naturezas").length)        partes.push(`natureza: ${arr("naturezas").join(", ")}`);
  if (arr("tipos_servico").length)    partes.push(`tipo: ${arr("tipos_servico").slice(0, 2).join(", ")}${arr("tipos_servico").length > 2 ? "…" : ""}`);
  if (arr("segmentos").length)        partes.push(`segmento: ${arr("segmentos").slice(0, 2).join(", ")}${arr("segmentos").length > 2 ? "…" : ""}`);
  if (arr("estados").length)          partes.push(`UF: ${arr("estados").join(", ")}`);
  if (typeof c.min_relevancia === "string" && c.min_relevancia !== "TODAS") partes.push(`relevância ${c.min_relevancia}`);
  return partes.length ? partes : ["Todas as licitações"];
}

/** "a, b; c" → ["a","b","c"] (entrada de keywords/UFs no form). */
export function parseLista(texto: string): string[] {
  return texto
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
