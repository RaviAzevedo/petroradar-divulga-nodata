/**
 * Adoção em lote — lógica pura do fluxo "Vincular a uma operação" (WP-12).
 *
 * O modal (ModalVincularOperacao) e a gaveta da ficha falam com a MESMA rota
 * R11 (`POST /cofre/documentos/vincular-operacao`), que aceita no máximo 200
 * ids por chamada. Fatiamento, soma de resultados e a frase de resumo vivem
 * aqui — fora do componente — porque são as partes com regra de negócio e,
 * portanto, as que carregam teste (padrão do módulo: lote.ts / operacoes.ts).
 */

/** Teto de `ids` do `VincularOperacaoEmLoteSchema` (02-APIS §10.2). */
export const LIMITE_IDS_POR_CHAMADA = 200;

/** Um documento pulado por R11, com o motivo cru do servidor. */
export interface PuladoVinculo {
  id: string;
  motivo: string;
}

/** Resposta somada das K chamadas sequenciais a R11. */
export interface ResultadoVinculacao {
  vinculados: number;
  pulados: PuladoVinculo[];
}

/**
 * Fatia os ids em blocos de até `tamanho` (default: o teto de R11).
 * O modal envia os blocos EM SÉRIE e soma os resultados — transparente para o
 * usuário (03-FRONTEND §6.3-5, sem mensagem especial).
 */
export function fatiarIds(ids: readonly string[], tamanho: number = LIMITE_IDS_POR_CHAMADA): string[][] {
  if (tamanho < 1) throw new Error("tamanho do bloco precisa ser >= 1");
  const blocos: string[][] = [];
  for (let i = 0; i < ids.length; i += tamanho) {
    blocos.push(ids.slice(i, i + tamanho));
  }
  return blocos;
}

/**
 * Tradução dos motivos de R11 para o resumo do modal (03-FRONTEND §6.3-4).
 * Ordem fixa: é a ordem em que os motivos aparecem dentro do parêntese.
 * Motivo desconhecido (rota evoluiu antes da tela) cai no rótulo cru em
 * minúsculas — nunca some da contagem.
 */
const MOTIVOS_ORDENADOS = ["JA_VINCULADO", "RESTRITO", "NAO_ENCONTRADO"] as const;

function rotuloDoMotivo(motivo: string, quantidade: number): string {
  const plural = quantidade !== 1;
  switch (motivo) {
    case "JA_VINCULADO":  return `${quantidade} já vinculada${plural ? "s" : ""}`;
    case "RESTRITO":      return `${quantidade} restrita${plural ? "s" : ""}`;
    case "NAO_ENCONTRADO": return `${quantidade} não encontrada${plural ? "s" : ""}`;
    default:              return `${quantidade} ${motivo.toLowerCase().replace(/_/g, " ")}`;
  }
}

/**
 * Frase de resumo do modal, no formato exato do plano:
 *   "218 vinculadas · 3 puladas (2 já vinculadas, 1 restrita)"
 *   "3 vinculadas."
 * Zero vinculadas com pulados também é resultado (não é erro):
 *   "0 vinculadas · 2 puladas (2 já vinculadas)".
 */
export function resumoVinculacao(vinculados: number, pulados: readonly PuladoVinculo[]): string {
  const parteVinculadas = `${vinculados} vinculada${vinculados !== 1 ? "s" : ""}`;
  if (pulados.length === 0) return `${parteVinculadas}.`;

  const porMotivo = new Map<string, number>();
  for (const p of pulados) {
    porMotivo.set(p.motivo, (porMotivo.get(p.motivo) ?? 0) + 1);
  }

  // Motivos conhecidos primeiro, na ordem fixa; desconhecidos depois, na ordem
  // de chegada (a Map preserva inserção).
  const partes: string[] = [];
  for (const motivo of MOTIVOS_ORDENADOS) {
    const n = porMotivo.get(motivo);
    if (n) { partes.push(rotuloDoMotivo(motivo, n)); porMotivo.delete(motivo); }
  }
  for (const [motivo, n] of porMotivo) {
    partes.push(rotuloDoMotivo(motivo, n));
  }

  const totalPulados = pulados.length;
  return `${parteVinculadas} · ${totalPulados} pulada${totalPulados !== 1 ? "s" : ""} (${partes.join(", ")})`;
}
