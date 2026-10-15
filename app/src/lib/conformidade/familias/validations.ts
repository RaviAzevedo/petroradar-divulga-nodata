/**
 * Schemas de Validação — Módulo Famílias CRC
 * Usado em: API routes (server) + formulários (client)
 */

import { z } from "zod";

// ── Helpers ──────────────────────────────────────────────────────────────────

const uuidSchema = z.string().uuid("ID inválido");

const dateTimeSchema = z
  .string()
  .datetime({ message: "Data e hora inválidas. Use o formato ISO 8601." });

// ── Enums ────────────────────────────────────────────────────────────────────

const nivelFamiliaSchema = z.enum(["FAMILIA", "SUBFAMILIA", "GRUPO", "ITEM"]);

const statusFamiliaSchema = z.enum([
  "ATIVA",
  "EM_RENOVACAO",
  "SUSPENSA",
  "VENCIDA",
  "REJEITADA",
]);

const statusCriterioSchema = z.enum([
  "APROVADO",
  "QUALIFICADO",
  "EM_AVALIACAO",
  "REJEITADO",
  "CANCELADO",
]);

const criterioCrcSchema = z.enum([
  "JURIDICO",
  "ECONOMICO",
  "TECNICO",
  "TECNICO_SMS",
  "LFO",          // Linha de Fornecimento (autodeclaratório)
  "REVENDEDOR",   // distribuidor / revendedor
  "INTEGRIDADE",
]);

const segmentoPetrobrasSchema = z.enum([
  "YELLOW_PAGES",
  "OPERACIONAL",
  "CRITICA",
  "ESTRATEGICA",
]);

const statusFluxoCrcSchema = z.enum(["D", "Q", "A", "X"]);

// Labels legíveis pra UI
const CRITERIO_CRC_LABELS: Record<z.infer<typeof criterioCrcSchema>, string> = {
  JURIDICO:    "Jurídico",
  ECONOMICO:   "Econômico",
  TECNICO:     "Técnico",
  TECNICO_SMS: "Técnico-SMS",
  LFO:         "Linha de Fornecimento",
  REVENDEDOR:  "Revendedor / Distribuidor",
  INTEGRIDADE: "Integridade",
};

const SEGMENTO_PETROBRAS_LABELS: Record<z.infer<typeof segmentoPetrobrasSchema>, string> = {
  YELLOW_PAGES: "Yellow Pages",
  OPERACIONAL:  "Operacional",
  CRITICA:      "Crítica",
  ESTRATEGICA:  "Estratégica",
};

const STATUS_FLUXO_CRC_LABELS: Record<z.infer<typeof statusFluxoCrcSchema>, string> = {
  D: "Declaração de Interesse",
  Q: "Tecnicamente Qualificado",
  A: "Aprovado",
  X: "Cancelado",
};

// ── Helpers de normalização ──────────────────────────────────────────────────

/** Normaliza código CRC: remove pontuação, espaços, mantém alfanumérico em maiúsculas. */
export function normalizarCodigoCrc(codigo: string): string {
  return codigo
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
}

// ── 1. Criar Nova Família ────────────────────────────────────────────────────

export const CriarFamiliaSchema = z.object({
  codigoCrc: z
    .string()
    .min(2, "Código CRC deve ter pelo menos 2 caracteres")
    .max(50, "Código CRC muito longo"),

  nome: z
    .string()
    .min(2, "Nome deve ter pelo menos 2 caracteres")
    .max(200, "Nome muito longo"),

  descricao: z.string().max(2000, "Descrição muito longa").optional(),

  nivel: nivelFamiliaSchema.default("FAMILIA"),
  parentId: uuidSchema.optional().nullable(),

  cadastroCorporativo: z.boolean().default(true),

  segmentoPetrobras: segmentoPetrobrasSchema.optional().nullable(),

  status: statusFamiliaSchema.default("ATIVA"),
  statusFluxoCrc: statusFluxoCrcSchema.optional().nullable(),

  validadeFim: dateTimeSchema.optional().nullable(),

  // Critérios opcionais (estrutura JSONB)
  criterios: z
    .record(
      criterioCrcSchema,
      z.object({
        status: statusCriterioSchema,
        validadeFim: z.string().datetime().nullable(),
        observacao: z.string().max(500).optional(),
      })
    )
    .optional(),

  tags: z.array(z.string().max(50)).max(50).optional(),
  escoposCobertos: z.array(z.string().max(200)).max(100).optional(),
  observacoes: z.string().max(2000).optional(),
});

type CriarFamiliaInput = z.infer<typeof CriarFamiliaSchema>;

// ── 2. Editar Família ────────────────────────────────────────────────────────

export const EditarFamiliaSchema = z.object({
  codigoCrc: z.string().min(2).max(50).optional(),
  nome: z.string().min(2).max(200).optional(),
  descricao: z.string().max(2000).optional().nullable(),
  nivel: nivelFamiliaSchema.optional(),
  parentId: uuidSchema.optional().nullable(),
  cadastroCorporativo: z.boolean().optional(),
  segmentoPetrobras: segmentoPetrobrasSchema.optional().nullable(),
  status: statusFamiliaSchema.optional(),
  statusFluxoCrc: statusFluxoCrcSchema.optional().nullable(),
  validadeFim: dateTimeSchema.optional().nullable(),
  criterios: z
    .record(
      criterioCrcSchema,
      z.object({
        status: statusCriterioSchema,
        validadeFim: z.string().datetime().nullable(),
        observacao: z.string().max(500).optional(),
      })
    )
    .optional(),
  tags: z.array(z.string().max(50)).max(50).optional(),
  escoposCobertos: z.array(z.string().max(200)).max(100).optional(),
  observacoes: z.string().max(2000).optional().nullable(),
});

type EditarFamiliaInput = z.infer<typeof EditarFamiliaSchema>;

// ── 3. Filtros de Listagem ───────────────────────────────────────────────────

export const FiltrosFamiliaSchema = z.object({
  status: statusFamiliaSchema.optional(),
  statusFluxoCrc: statusFluxoCrcSchema.optional(),
  segmentoPetrobras: segmentoPetrobrasSchema.optional(),
  nivel: nivelFamiliaSchema.optional(),
  parentId: uuidSchema.optional(),
  busca: z.string().max(200).optional(),
  vencendoEm: z.coerce.number().int().min(1).max(365).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  order: z.enum(["codigo", "nome", "status", "validade", "criado_em"]).default("codigo"),
  dir: z.enum(["asc", "desc"]).default("asc"),
});

export type FiltrosFamiliaInput = z.infer<typeof FiltrosFamiliaSchema>;

// ── 4. Adicionar Alias ───────────────────────────────────────────────────────

const AdicionarAliasSchema = z.object({
  codigoAlternativo: z.string().min(2).max(50),
  observacao: z.string().max(500).optional(),
});

type AdicionarAliasInput = z.infer<typeof AdicionarAliasSchema>;

// ── Helpers de validação de erros para o frontend ───────────────────────────

export function formatZodErrors(error: z.ZodError): Record<string, string> {
  return error.issues.reduce((acc, issue) => {
    const path = issue.path.join(".");
    acc[path] = issue.message;
    return acc;
  }, {} as Record<string, string>);
}
