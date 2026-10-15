/**
 * Checklist de proposta (XLSX) pré-preenchido com os dados da análise IA.
 *
 * Adaptador entre o par (meta, análise) usado pelo dossiê e o gerador de
 * planilha de checklist.ts. Para usar um template próprio da sua empresa,
 * troque a implementação aqui (ex.: carregar um .xlsx e escrever nas células).
 */

import { gerarChecklistXlsx } from "./checklist";
import type { AnaliseRow, BriefingMeta } from "./briefing";

export async function preencherChecklistOficial(meta: BriefingMeta, a: AnaliseRow): Promise<Buffer> {
  return gerarChecklistXlsx({
    numero:  meta.numero,
    objeto:  meta.objeto ?? undefined,
    empresa: meta.empresa ?? undefined,
    analise: {
      resumo:               a.resumo ?? undefined,
      objetoDetalhado:      a.objetoDetalhado ?? undefined,
      checklist:            (a.checklist as Record<string, unknown>) ?? undefined,
      requisitos:           (a.requisitos as string[]) ?? undefined,
      criteriosHabilitacao: (a.criteriosHabilitacao as string[]) ?? undefined,
      criteriosJulgamento:  a.criteriosJulgamento ?? undefined,
      valorEstimado:        a.valorEstimado ?? undefined,
      prazos:               (a.prazos as string[]) ?? undefined,
      riscos:               (a.riscos as Array<{ descricao: string; classificacao: string }>) ?? undefined,
      recomendacao:         a.recomendacao ?? undefined,
    },
  });
}
