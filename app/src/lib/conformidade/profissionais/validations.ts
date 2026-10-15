/**
 * Schemas de Validação — Profissionais, vínculos e atividades de ART (0043)
 *
 * Cobre as rotas /api/conformidade/profissionais*, as duas satélites
 * /api/conformidade/cofre/documentos/[id]/{profissionais,atividades} e o
 * parâmetro do relatório `curriculo-rt` (C1).
 *
 * MENSAGENS: todas em pt-BR porque caem direto na tela — o `detalhes` do 422 é
 * renderizado campo a campo, então cada mensagem daqui é contrato de API.
 *
 * ⚠️ SEM CPF, em nenhum schema deste arquivo (spec ONDA-4 §1d / LGPD).
 * `lib/seguranca/pii.ts` redige CPF do `ocrTexto` antes de gravar e o BFF
 * espelha; guardar CPF do profissional contrariaria a política do próprio
 * módulo. O CREA é o que identifica para efeito de habilitação — é o que o
 * edital pede e o que a CAT traz.
 */

import { z } from "zod";
import type { PapelProfissional } from "@/db/schema";

const uuidSchema = z.string().uuid("ID inválido");

// ── Papel do profissional no documento (espelho do CHECK da 0043) ───────────

/**
 * Espelha `chk_profdoc_papel`. A ORDEM da tupla é a de exibição (RT primeiro:
 * é o profissional que a habilitação exige) e é dela que sai o CASE de
 * ordenação em `queries.ts` — molde de `PAPEIS_DOCUMENTO`.
 *
 * `as const satisfies readonly PapelProfissional[]` (e não `: readonly
 * PapelProfissional[]`) para a tupla continuar literal: é ela que alimenta o
 * `z.enum`, e o tipo do schema é quem manda — acrescentar papel lá sem
 * acrescentar aqui quebra a compilação, de propósito.
 *
 * ⚠️ Não confundir com `documentosHabilitacao.papel` (ATESTADO, CONTRATO…):
 * lá é o papel do DOCUMENTO no dossiê; aqui é o da PESSOA no documento.
 */
export const PAPEIS_PROFISSIONAL = ["RT", "CORRESPONSAVEL", "EQUIPE"] as const satisfies readonly PapelProfissional[];

export const PAPEL_PROFISSIONAL_LABELS: Record<PapelProfissional, string> = {
  RT:             "Responsável técnico",
  CORRESPONSAVEL: "Corresponsável",
  EQUIPE:         "Equipe técnica",
};

/** UF do CREA: duas maiúsculas — o mesmo CHECK do banco (`chk_prof_crea_uf`),
 *  repetido aqui para a recusa sair no CAMPO (422) em vez de virar erro de
 *  banco (500) na hora do INSERT. */
const CREA_UF_REGEX = /^[A-Z]{2}$/;

// ── 1. Cadastro do profissional (POST /profissionais) ───────────────────────

/**
 * ⚠️ SEM CPF (spec §1d / LGPD). Se alguém tentar acrescentar `cpf` no body, o
 * `z.object()` faz strip e o campo some em silêncio — que já é o comportamento
 * certo; a regra escrita é: não existe coluna, não existe campo.
 *
 * `crea` com `min(3)` e não `min(1)`: string de um ou dois caracteres é resto
 * de digitação, e o CHECK `chk_prof_crea` do banco recusa string vazia (é o que
 * impede dois "sem registro" colidirem no índice único parcial).
 */
export const CriarProfissionalSchema = z.object({
  nome:     z.string().trim().min(2, "Nome muito curto").max(200, "Nome muito longo"),
  crea:     z.string().trim().min(3, "Registro muito curto").max(50, "Registro muito longo").optional().nullable(),
  creaUf:   z.string().trim().regex(CREA_UF_REGEX, "UF com duas letras maiúsculas").optional().nullable(),
  // Título profissional ("Engenheiro Mecânico"), não histórico escolar.
  formacao: z.string().trim().max(200, "Formação muito longa").optional().nullable(),
});

export type CriarProfissionalInput = z.infer<typeof CriarProfissionalSchema>;

// ── 2. Edição (PATCH /profissionais/[id]) ───────────────────────────────────

/**
 * Tudo opcional; manda-se só o que muda (e `{}` é PATCH válido que não muda
 * nada). `ativo` é o "excluir" desta entidade: apagar o profissional levaria
 * junto os vínculos (`ON DELETE CASCADE`) — isto é, o rastro de quem assinou
 * o quê —, então não existe DELETE.
 */
export const EditarProfissionalSchema = CriarProfissionalSchema.partial().extend({
  ativo: z.boolean().optional(),
});

export type EditarProfissionalInput = z.infer<typeof EditarProfissionalSchema>;

// ── 3. Filtros da lista (GET /profissionais) ────────────────────────────────

/**
 * Nenhum default que corte: sem `ativo` na query a lista traz ativos E
 * inativos, e a resposta ecoa o que foi aplicado (Q10.3 / D11 — "histórico é
 * parâmetro explícito, nunca default por papel"). `ativo` e `comDocumento`
 * chegam da rota já convertidos para boolean (lidos fora do zod, como o
 * `semOperacao` do cofre), por isso são `z.boolean()` e não `z.coerce`.
 */
export const FiltrosProfissionalSchema = z.object({
  /** nome ou CREA — casa `lower(nome)` OU `crea`, com escape de LIKE (queries.ts) */
  busca:        z.string().trim().max(200, "Busca muito longa").optional(),
  ativo:        z.boolean().optional(),
  /** só quem tem ao menos 1 vínculo VISÍVEL para o papel (nunca o total cru) */
  comDocumento: z.boolean().optional(),
  limit:  z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type FiltrosProfissionalInput = z.infer<typeof FiltrosProfissionalSchema>;

// ── 4. Vínculo profissional × documento (POST das satélites) ────────────────

/**
 * POST /cofre/documentos/[id]/profissionais — vincular.
 *
 * `papel` tem default "RT" porque é o gesto de 9 em cada 10 vínculos (e o que
 * o backfill da 0043 gravou); `numeroArt` mora no VÍNCULO (e não só em
 * `documentosProjetos`) porque a ART é do PAR: dois corresponsáveis do mesmo
 * atestado têm números diferentes.
 */
export const VincularProfissionalSchema = z.object({
  profissionalId: uuidSchema,
  papel:     z.enum(PAPEIS_PROFISSIONAL).default("RT"),
  numeroArt: z.string().trim().max(50, "Número de ART muito longo").optional().nullable(),
});

export type VincularProfissionalInput = z.infer<typeof VincularProfissionalSchema>;

// ── 5. Atividade da ART (POST /cofre/documentos/[id]/atividades) ────────────

/**
 * ⚠️ `quantidadeTexto` é STRING de propósito (spec §1c / Q10.6) — é a
 * evidência LITERAL da ART ("3.600,00 HH", "12.000 m"), exibida como texto e
 * nunca somada, por ninguém.
 *
 * `ordem` é opcional: ausente, a query calcula `max(ordem) + 1` do documento
 * no BANCO (duas abas abertas não podem gerar a mesma ordem por cálculo no
 * cliente).
 */
export const CriarAtividadeSchema = z.object({
  atividade:       z.string().trim().min(2, "Descreva a atividade").max(500, "Atividade muito longa"),
  quantidadeTexto: z.string().trim().max(100, "Quantidade muito longa").optional().nullable(),
  ordem:           z.coerce.number().int().min(0).max(999).optional(),
});

export type CriarAtividadeInput = z.infer<typeof CriarAtividadeSchema>;

// ── 6. Parâmetro do relatório C1 ────────────────────────────────────────────

/**
 * C1: o ÚNICO parâmetro do relatório `curriculo-rt` (§5.10). O relatório é
 * parametrizado (`ocultoNoHub`), então não há período — o recorte é a pessoa.
 * O mesmo schema valida a query string em `coletarCurriculoRt`, para a rota de
 * relatórios e a página do currículo recusarem a MESMA coisa.
 */
export const CurriculoQuerySchema = z.object({ profissionalId: uuidSchema });

export type CurriculoQueryInput = z.infer<typeof CurriculoQuerySchema>;
