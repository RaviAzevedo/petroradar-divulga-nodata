// Paleta local dos gráficos do Painel do Acervo — spec do Painel do Acervo §3.
// Os componentes de gráfico recebem cores por props; esta paleta é a fonte única
// de hex para o consumidor (PainelClient) e para os defaults internos.

export const PALETA = {
  verde: "#16a34a",
  verdeClaro: "#86efac",
  ambar: "#f59e0b",
  cinza: "#e5e7eb",
  laranja: "#F59C00", // laranja Proponente
  vermelho: "#dc2626",
  azul: "#0284c7",
  violeta: "#7c3aed",
} as const;

export type NomeCorPaleta = keyof typeof PALETA;

/**
 * Régua de cor da nota do acervo (mesma régua do conceito — spec §3):
 * ≥85 verde (A) · ≥70 laranja Proponente (B) · ≥55 âmbar (C) · <55 vermelho (D/E).
 * (O verde-claro da paleta foi substituído pelo laranja Proponente na faixa B,
 * conforme a seta "verde-claro→laranja proponente" da spec.)
 */
export function corDaNota(valor: number): string {
  if (valor >= 85) return PALETA.verde;
  if (valor >= 70) return PALETA.laranja;
  if (valor >= 55) return PALETA.ambar;
  return PALETA.vermelho;
}

/** Formata inteiro em pt-BR (uso interno dos gráficos: <title> e aria-label). */
export function inteiroBR(n: number): string {
  return n.toLocaleString("pt-BR");
}
