/**
 * Schemas de Validação — Módulo Habilitação (Cofre de Documentos)
 */

import { z } from "zod";
// Tuplas do domínio compartilhado (0033/0034) — importadas, nunca recopiadas:
// o CHECK do banco, o schema e a tela têm de enxergar a MESMA lista de valores.
import {
  DETENTORAS,
  PAPEIS_DOCUMENTO,
  SITUACOES_PROVA,
  TIPOS_DOCUMENTO,
} from "@/lib/conformidade/operacoes";

// ── Helpers ──────────────────────────────────────────────────────────────────

const uuidSchema = z.string().uuid("ID inválido");

const dateTimeSchema = z
  .string()
  .datetime({ message: "Data e hora inválidas. Use o formato ISO 8601." });

const valorMonetarioSchema = z
  .number()
  .nonnegative("Valor não pode ser negativo")
  .max(999_999_999_999_99, "Valor excede o limite permitido");

// ── Enums ────────────────────────────────────────────────────────────────────

export const categoriaSchema = z.enum([
  "JURIDICA",
  "FISCAL",
  "ECONOMICA",
  "TECNICA",
  "QUALIFICACAO_PESSOAL",
  "DECLARACAO",
]);

export const subcategoriaSchema = z.enum([
  // FISCAL
  "CND_FEDERAL", "FGTS", "CNDT", "CND_ESTADUAL", "CND_MUNICIPAL", "FALENCIA",
  // ECONOMICA
  "BALANCO", "INDICES_FINANCEIROS",
  // JURIDICA
  "CONTRATO_SOCIAL", "CNPJ", "ATO_CONSTITUTIVO", "PROCURACAO",
  // TECNICA
  "ATESTADO_ACT", "ISO_9001", "ISO_14001", "ISO_45001",
  "NR_10", "NR_13", "NR_35", "ASME", "API_Q1", "API_6D", "PED", "OUTROS_TECNICOS",
  // QUALIFICACAO PESSOAL
  "CREA_PJ", "CREA_PF", "ART_CAT", "CTPS", "FORMACAO",
  // DECLARACOES
  "DECL_MENOR_NAO_EMPREGA", "DECL_IDONEIDADE", "DECL_ME_EPP", "DECL_OUTRA",
  // OUTROS
  "OUTRO",
]);

const statusDocSchema = z.enum([
  "VIGENTE",
  "EM_RENOVACAO",
  "VENCIDO",
  "SUBSTITUIDO",
]);

// ── 1. Criar Documento ───────────────────────────────────────────────────────

export const CriarDocumentoSchema = z.object({
  categoria: categoriaSchema,
  subcategoria: subcategoriaSchema,
  titulo: z.string().min(2, "Título muito curto").max(200, "Título muito longo"),
  descricao: z.string().max(2000).optional(),
  numeroDocumento: z.string().max(100).optional(),
  // 0044 (B6): a REVISÃO carimbada pela engenharia ("R0", "R1", "02A"). O
  // teto de 20 é o que o CHECK do banco NÃO faz de propósito (spec ONDA-5
  // §1h): um CHECK de formato recusaria o carimbo real do próximo cliente, e
  // a validação de tamanho fica num lugar só, que é aqui.
  revisao: z.string().trim().max(20, "Revisão muito longa").optional(),
  emitidoEm: dateTimeSchema.optional().nullable(),
  validadeFim: dateTimeSchema.optional().nullable(),
  validadeIndeterminada: z.boolean().default(false),
  status: statusDocSchema.default("VIGENTE"),
  tags: z.array(z.string().max(50)).max(50).optional(),
  // O arquivo em si é validado em separado via FormData / lib/blob/upload.ts
});

type CriarDocumentoInput = z.infer<typeof CriarDocumentoSchema>;

// ── 2. Editar Documento ──────────────────────────────────────────────────────

export const EditarDocumentoSchema = z.object({
  categoria: categoriaSchema.optional(),
  subcategoria: subcategoriaSchema.optional(),
  titulo: z.string().min(2).max(200).optional(),
  descricao: z.string().max(2000).optional().nullable(),
  numeroDocumento: z.string().max(100).optional().nullable(),
  // 0044 (B6) — no bloco 0033/0034: `null` limpa, valor troca, ausente não mexe.
  revisao: z.string().trim().max(20, "Revisão muito longa").optional().nullable(),
  emitidoEm: dateTimeSchema.optional().nullable(),
  validadeFim: dateTimeSchema.optional().nullable(),
  validadeIndeterminada: z.boolean().optional(),
  status: statusDocSchema.optional(),
  tags: z.array(z.string().max(50)).max(50).optional(),
  // 0033/0034 (R8 — B1 estendido): `null` limpa, valor troca, ausente não mexe.
  // `operacaoId: null` desvincula SEM limpar `papel` (quem quiser limpar manda
  // `papel: null` junto). `restrito` sem nullable: booleano não tem "limpar".
  operacaoId:    z.string().uuid("ID inválido").optional().nullable(),
  papel:         z.enum(PAPEIS_DOCUMENTO).optional().nullable(),
  tipoDocumento: z.enum(TIPOS_DOCUMENTO).optional().nullable(),
  situacaoProva: z.enum(SITUACOES_PROVA).optional().nullable(),
  detentora:     z.enum(DETENTORAS).optional().nullable(),
  restrito:      z.boolean().optional(),
  // 0043: `null` limpa a disciplina, uuid troca, ausente não mexe. A
  // existência do id é conferida pela rota (`conferirDisciplina`) antes do
  // UPDATE — aqui só a forma, como em `operacaoId` acima.
  disciplinaId:  z.string().uuid("ID inválido").optional().nullable(),   // 0043
});

type EditarDocumentoInput = z.infer<typeof EditarDocumentoSchema>;

// ── 3. Filtros de Listagem ───────────────────────────────────────────────────

export const FiltrosDocumentoSchema = z.object({
  categoria: categoriaSchema.optional(),
  subcategoria: subcategoriaSchema.optional(),
  status: statusDocSchema.optional(),
  familiaId: uuidSchema.optional(),
  busca: z.string().max(200).optional(),
  vencendoEm: z.coerce.number().int().min(1).max(365).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  order: z.enum(["titulo", "categoria", "status", "validade", "criado_em"]).default("validade"),
  dir: z.enum(["asc", "desc"]).default("asc"),
});

export type FiltrosDocumentoInput = z.infer<typeof FiltrosDocumentoSchema>;

// ── 4. Vincular Documento a Família ──────────────────────────────────────────

export const VincularDocumentoFamiliaSchema = z.object({
  familiaId: uuidSchema,
  observacao: z.string().max(500).optional(),
});

type VincularDocumentoFamiliaInput = z.infer<typeof VincularDocumentoFamiliaSchema>;

// ── 5. Vincular Documento a Projeto ──────────────────────────────────────────

export const VincularDocumentoProjetoSchema = z.object({
  clienteCnpj: z.string().regex(/^\d{14}$/, "CNPJ deve conter 14 dígitos").optional(),
  clienteNome: z.string().min(2).max(200),
  projetoNome: z.string().min(2).max(200),
  valorContrato: valorMonetarioSchema.optional(),
  periodoInicio: dateTimeSchema.optional(),
  periodoFim: dateTimeSchema.optional(),
  descricaoServico: z.string().max(2000).optional(),
  engenheiroResponsavel: z.string().max(200).optional(),
  registroCrea: z.string().max(50).optional(),
  numeroArt: z.string().max(50).optional(),
});

type VincularDocumentoProjetoInput = z.infer<typeof VincularDocumentoProjetoSchema>;

// ── Helpers ──────────────────────────────────────────────────────────────────

export function formatZodErrors(error: z.ZodError): Record<string, string> {
  return error.issues.reduce((acc, issue) => {
    const path = issue.path.join(".");
    acc[path] = issue.message;
    return acc;
  }, {} as Record<string, string>);
}

// ── Mapeamento de subcategoria → categoria padrão ───────────────────────────

export const SUBCATEGORIA_TO_CATEGORIA: Record<z.infer<typeof subcategoriaSchema>, z.infer<typeof categoriaSchema>> = {
  CND_FEDERAL:    "FISCAL",
  FGTS:           "FISCAL",
  CNDT:           "FISCAL",
  CND_ESTADUAL:   "FISCAL",
  CND_MUNICIPAL:  "FISCAL",
  FALENCIA:       "FISCAL",
  BALANCO:             "ECONOMICA",
  INDICES_FINANCEIROS: "ECONOMICA",
  CONTRATO_SOCIAL:  "JURIDICA",
  CNPJ:             "JURIDICA",
  ATO_CONSTITUTIVO: "JURIDICA",
  PROCURACAO:       "JURIDICA",
  ATESTADO_ACT:     "TECNICA",
  ISO_9001:         "TECNICA",
  ISO_14001:        "TECNICA",
  ISO_45001:        "TECNICA",
  NR_10:            "TECNICA",
  NR_13:            "TECNICA",
  NR_35:            "TECNICA",
  ASME:             "TECNICA",
  API_Q1:           "TECNICA",
  API_6D:           "TECNICA",
  PED:              "TECNICA",
  OUTROS_TECNICOS:  "TECNICA",
  CREA_PJ:    "QUALIFICACAO_PESSOAL",
  CREA_PF:    "QUALIFICACAO_PESSOAL",
  ART_CAT:    "QUALIFICACAO_PESSOAL",
  CTPS:       "QUALIFICACAO_PESSOAL",
  FORMACAO:   "QUALIFICACAO_PESSOAL",
  DECL_MENOR_NAO_EMPREGA: "DECLARACAO",
  DECL_IDONEIDADE:        "DECLARACAO",
  DECL_ME_EPP:            "DECLARACAO",
  DECL_OUTRA:             "DECLARACAO",
  OUTRO:                  "DECLARACAO",
};

export const CATEGORIA_LABELS: Record<z.infer<typeof categoriaSchema>, string> = {
  JURIDICA:             "Habilitação Jurídica",
  FISCAL:               "Fiscal e Trabalhista",
  ECONOMICA:            "Econômico-Financeira",
  TECNICA:              "Habilitação Técnica",
  QUALIFICACAO_PESSOAL: "Qualificação Pessoal",
  DECLARACAO:           "Declarações",
};

export const SUBCATEGORIA_LABELS: Record<z.infer<typeof subcategoriaSchema>, string> = {
  CND_FEDERAL:           "CND Federal (Receita/PGFN)",
  FGTS:                  "CRF FGTS",
  CNDT:                  "CNDT (Trabalhista)",
  CND_ESTADUAL:          "CND Estadual",
  CND_MUNICIPAL:         "CND Municipal",
  FALENCIA:              "Negativa de Falência",
  BALANCO:               "Balanço Patrimonial",
  INDICES_FINANCEIROS:   "Índices Financeiros",
  CONTRATO_SOCIAL:       "Contrato Social",
  CNPJ:                  "Cartão CNPJ",
  ATO_CONSTITUTIVO:      "Ato Constitutivo",
  PROCURACAO:            "Procuração",
  ATESTADO_ACT:          "Atestado de Capacidade Técnica",
  ISO_9001:              "ISO 9001",
  ISO_14001:             "ISO 14001",
  ISO_45001:             "ISO 45001",
  NR_10:                 "NR-10 (Eletricidade)",
  NR_13:                 "NR-13 (Vasos de pressão)",
  NR_35:                 "NR-35 (Trabalho em altura)",
  ASME:                  "ASME",
  API_Q1:                "API Q1",
  API_6D:                "API 6D",
  PED:                   "PED",
  OUTROS_TECNICOS:       "Outros Técnicos",
  CREA_PJ:               "CREA Pessoa Jurídica",
  CREA_PF:               "CREA Pessoa Física",
  ART_CAT:               "ART / CAT",
  CTPS:                  "CTPS / Vínculo",
  FORMACAO:              "Comprovante de Formação",
  DECL_MENOR_NAO_EMPREGA: "Decl. Não Emprega Menor",
  DECL_IDONEIDADE:        "Decl. Idoneidade",
  DECL_ME_EPP:            "Decl. ME/EPP",
  DECL_OUTRA:             "Outra Declaração",
  OUTRO:                  "Outro",
};
