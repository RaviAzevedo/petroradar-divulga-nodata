/**
 * Chave geral da geração de briefing/dossiê por IA.
 *
 * Desligada por decisão de produto, enquanto um problema da geração não
 * é resolvido. Cobre os DOIS caminhos que produzem briefing:
 *   - `GET  /api/licitacoes/[id]/briefing` — renderiza o briefing (PDF/MD/JSON)
 *   - `POST /api/licitacoes/[id]/dossie`   — gera com o Claude e devolve o ZIP
 *     que CONTÉM o briefing em PDF (deixar este ligado manteria o briefing
 *     saindo por outra porta).
 *
 * Fica FORA de `NEXT_PUBLIC_*` de propósito: é lida em runtime pelo servidor, e a
 * página passa o resultado para o componente. Assim religar é editar o
 * `.env.onprem` e reiniciar o container — sem rebuild da imagem.
 *
 * Default DESLIGADO: só liga com `FEATURE_BRIEFING_IA=1` explícito. A intenção é
 * um interruptor deliberado, então a ausência da variável não deve reativar a
 * feature por acidente num deploy novo.
 *
 * Análise de edital, Go/No-Go e GAP de habilitação NÃO são afetados.
 */
export function briefingIaHabilitado(): boolean {
  return process.env.FEATURE_BRIEFING_IA === "1";
}

/** Corpo 503 padrão das rotas desligadas (mesmo shape de erro do produto). */
export const BRIEFING_DESABILITADO = {
  error: "Geração de briefing por IA temporariamente desabilitada",
  code: "FEATURE_DESABILITADA",
} as const;
