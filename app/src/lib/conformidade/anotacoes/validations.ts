/**
 * Schemas de Validação — Anotações do acervo (migration 0044)
 *
 * Cobre GET|POST /api/conformidade/anotacoes e PATCH|DELETE
 * /api/conformidade/anotacoes/[id]. Molde: `disciplinas/validations.ts`
 * (onda 4).
 *
 * MENSAGENS em pt-BR porque caem direto na tela: o `detalhes` do 422 é
 * renderizado campo a campo, então cada mensagem daqui é contrato de API.
 *
 * ⚠️ A anotação NÃO mora em `audit_log` (spec ONDA-5 §1d): aquela tabela tem
 * expurgo de 12 meses (0035_audit_restrito.sql:4) e a anotação é conhecimento
 * do acervo, não trilha. O `audit_log` continua registrando QUE houve anotação
 * — nunca o texto.
 *
 * ⚠️ O texto é REDIGIDO (`redigirPii`) pela ROTA antes de gravar, não por um
 * `.transform()` daqui: a regra tem de estar visível em quem lê o handler, que
 * é onde a política do módulo já está escrita para o `ocrTexto` (§4.3).
 */

import { z } from "zod";
import type { AlvoAnotacao } from "@/db/schema";

const uuidSchema = z.string().uuid("ID inválido");

// ── 1. O vocabulário dos alvos ───────────────────────────────────────────────

/**
 * Os três alvos, espelho da tupla TS de `AlvoAnotacao` (schema.ts) e do
 * CHECK `chk_anot_alvo` (0044). Diferente de `disciplinas` (catálogo de linha,
 * onda 4 §1g), aqui o conjunto é FECHADO e o rótulo é do domínio — por isso
 * tupla + CHECK, como detentora/papel.
 *
 * `as const satisfies readonly AlvoAnotacao[]` (e não `: readonly
 * AlvoAnotacao[]`) para a tupla continuar literal: é ela que alimenta o
 * `z.enum`, e o tipo do schema é quem manda — acrescentar alvo no `schema.ts`
 * sem acrescentar aqui quebra a compilação, de propósito.
 */
export const ALVOS_ANOTACAO = ["OPERACAO", "DOCUMENTO", "PROFISSIONAL"] as const satisfies readonly AlvoAnotacao[];

export const ALVO_ANOTACAO_LABELS: Record<AlvoAnotacao, string> = {
  OPERACAO:     "Operação",
  DOCUMENTO:    "Documento",
  PROFISSIONAL: "Profissional",
};

// ── 2. GET /anotacoes — os filtros ───────────────────────────────────────────

/**
 * GET /api/conformidade/anotacoes?alvoTipo=&alvoId= — os DOIS são obrigatórios.
 * Não existe "listar todas as anotações": a anotação só faz sentido ao lado da
 * coisa anotada, e uma lista global viraria um mural que ninguém mantém.
 *
 * `resolvidas` é recorte EXPLÍCITO com default `false` ECOADO na resposta
 * (Q10.3: default é corte, e corte aparece) — a tela mostra as abertas e diz
 * "N resolvidas ocultas", com o link que as traz.
 */
export const FiltrosAnotacaoSchema = z.object({
  alvoTipo: z.enum(ALVOS_ANOTACAO),
  alvoId:   uuidSchema,
  resolvidas: z.boolean().default(false),
});
export type FiltrosAnotacaoInput = z.infer<typeof FiltrosAnotacaoSchema>;

// ── 3. POST /anotacoes — criar ───────────────────────────────────────────────

/**
 * POST /api/conformidade/anotacoes.
 * `texto` é limitado a 4000 (o mesmo teto do CHECK do banco e de
 * `operacoes.escopo`): anotação é frase, não anexo. O `.trim()` do zod mais o
 * `length(btrim(...)) >= 1` do CHECK fecham o caso " " pelos dois lados.
 *
 * ⚠️ `autorId`/`autorNome` NÃO entram no body: vêm da sessão. Um cliente que
 * os mandasse teria o campo descartado pelo strip do `z.object()` — que já é o
 * comportamento certo; a regra escrita é: autoria não é campo de formulário.
 */
export const CriarAnotacaoSchema = z.object({
  alvoTipo: z.enum(ALVOS_ANOTACAO),
  alvoId:   uuidSchema,
  texto:    z.string().trim().min(1, "Escreva a anotação").max(4000, "Anotação muito longa"),
});
export type CriarAnotacaoInput = z.infer<typeof CriarAnotacaoSchema>;

// ── 4. PATCH /anotacoes/[id] — editar e resolver ─────────────────────────────

/**
 * PATCH /api/conformidade/anotacoes/[id] — só o que muda.
 * `resolvida: true` grava `resolvidaEm = now()`; `false` volta para NULL.
 * Body vazio (`{}`) é 422: um PATCH que não muda nada é erro de cliente, e
 * responder 200 esconderia o bug (o mesmo critério do PATCH de operação).
 */
export const EditarAnotacaoSchema = z
  .object({
    texto:     z.string().trim().min(1, "Escreva a anotação").max(4000, "Anotação muito longa").optional(),
    resolvida: z.boolean().optional(),
  })
  .refine((d) => d.texto !== undefined || d.resolvida !== undefined, {
    message: "Informe texto ou resolvida",
    path: ["texto"],
  });
export type EditarAnotacaoInput = z.infer<typeof EditarAnotacaoSchema>;
