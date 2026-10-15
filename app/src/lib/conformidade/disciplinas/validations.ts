/**
 * Schemas de Validação — Disciplinas do acervo (migration 0043)
 *
 * Cobre GET /api/conformidade/disciplinas (o catálogo), PUT
 * /api/conformidade/operacoes/[id]/disciplinas (o conjunto da obra) e
 * GET /api/conformidade/disciplinas/cobertura (C3).
 *
 * SEM tupla de códigos e SEM `Record` de rótulos, de propósito (spec ONDA-4
 * §1g): detentora, papel, tipo de documento e natureza são conjuntos FECHADOS
 * do domínio e por isso viram tupla TS + CHECK no banco; disciplina não é — o
 * catálogo nasce com 16 linhas e cresce com o uso, e "Pintura e isolamento" é
 * dado de tela. Quem precisa do rótulo lê o catálogo pelo GET; acrescentar
 * disciplina é acrescentar uma tupla no seed da 0043, nada mais.
 *
 * MENSAGENS em pt-BR porque caem direto na tela: o `detalhes` do 422 é
 * renderizado campo a campo (mesma regra de `operacoes/validations.ts`).
 */

import { z } from "zod";
import { ehDataIso } from "@/lib/conformidade/operacoes/validations";

const uuidSchema = z.string().uuid("ID inválido");

// ── 1. PUT /operacoes/[id]/disciplinas — o conjunto da obra ──────────────────

/**
 * PUT /api/conformidade/operacoes/[id]/disciplinas — o conjunto INTEIRO de
 * disciplinas da operação (não um delta): a rota apaga e regrava em transação,
 * e é assim que o `{antes, depois}` do audit fica legível. Lista vazia é
 * válida e significa "nenhuma disciplina" — omitir o campo é que é erro.
 *
 * `max(20)` porque o catálogo tem 16 linhas e ninguém marca todas; o teto
 * existe para o body não virar vetor de abuso, não para expressar regra.
 * Duplicata no array não é erro: a query deduplica antes do INSERT (o PK
 * composto recusaria a segunda linha e um 500 aqui seria erro de UX, não de
 * dado).
 */
export const DisciplinasOperacaoSchema = z.object({
  disciplinaIds: z.array(uuidSchema).max(20, "No máximo 20 disciplinas"),
});
export type DisciplinasOperacaoInput = z.infer<typeof DisciplinasOperacaoSchema>;

// ── 2. GET /disciplinas — o catálogo ─────────────────────────────────────────

/**
 * GET /api/conformidade/disciplinas — o catálogo. `ativas` é filtro EXPLÍCITO,
 * com default `true` ECOADO na resposta (Q10.3: default é corte, e corte
 * aparece). A tela usa o default; a auditoria pede `?ativas=0` e vê tudo.
 */
export const FiltrosDisciplinaSchema = z.object({
  ativas: z.boolean().default(true),
});
export type FiltrosDisciplinaInput = z.infer<typeof FiltrosDisciplinaSchema>;

// ── 3. GET /disciplinas/cobertura — C3 ───────────────────────────────────────

/**
 * GET /api/conformidade/disciplinas/cobertura — C3. Todo recorte é explícito e
 * volta ecoado no `filtros` da resposta: nenhum corte escondido (Q10.3) — nada
 * de data de corte literal embutida na consulta.
 *
 * `de`/`ate` usam `ehDataIso` (formato E calendário — "2020-13-01" passa em
 * regex e o Postgres recusa com 22008, virando 500 em vez de 422); a janela
 * incide sobre o PERÍODO DA OPERAÇÃO, e operação sem período informado fica de
 * fora e é CONTADA à parte (`semPeriodo`), nunca some calada.
 */
export const CoberturaQuerySchema = z
  .object({
    cliente: z.string().trim().min(1).max(200, "Cliente muito longo").optional(),
    de:  z.string().refine(ehDataIso, "Data no formato AAAA-MM-DD").optional(),
    ate: z.string().refine(ehDataIso, "Data no formato AAAA-MM-DD").optional(),
    incluirInativas: z.boolean().default(false),
  })
  .superRefine((d, ctx) => {
    // Comparação de STRING: vale porque o formato é AAAA-MM-DD já validado
    // acima (mesmo argumento do `AtendimentoQuerySchema`, onda 2 §4.1) — a
    // ordem lexicográfica e a cronológica coincidem nesse formato.
    if (d.de && d.ate && d.de > d.ate) {
      ctx.addIssue({ code: "custom", message: "Data inicial maior que a final", path: ["ate"] });
    }
  });
export type CoberturaQueryInput = z.infer<typeof CoberturaQuerySchema>;
