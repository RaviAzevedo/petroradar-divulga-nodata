import { z } from "zod";

const TIPOS_EVENTO = ["ANUNCIADO", "DESCLASSIFICADO", "CONVOCADO", "DESISTIU", "HOMOLOGADO"] as const;
const MOTIVOS_EVENTO = [
  "DOCUMENTACAO_INSUFICIENTE",
  "INEXEQUIBILIDADE",
  "DESCUMPRIMENTO_REQUISITOS",
  "DESISTENCIA_VOLUNTARIA",
  "CADUCIDADE_PRAZO",
  "OUTRO",
] as const;
const FONTES_EVENTO = [
  "PORTAL_PETRONECT",
  "EMAIL_PETROBRAS",
  "DOU",
  "CONFIRMACAO_INTERNA",
  "OUTRO",
] as const;

const MOTIVO_LABEL: Record<typeof MOTIVOS_EVENTO[number], string> = {
  DOCUMENTACAO_INSUFICIENTE:  "Documentação insuficiente",
  INEXEQUIBILIDADE:            "Inexequibilidade do preço",
  DESCUMPRIMENTO_REQUISITOS:   "Descumprimento de requisitos",
  DESISTENCIA_VOLUNTARIA:      "Desistência voluntária",
  CADUCIDADE_PRAZO:            "Caducidade do prazo",
  OUTRO:                       "Outro motivo",
};

const TIPO_LABEL: Record<typeof TIPOS_EVENTO[number], string> = {
  ANUNCIADO:        "Anunciado vencedor",
  DESCLASSIFICADO:  "Desclassificado",
  CONVOCADO:        "Convocado",
  DESISTIU:         "Desistiu",
  HOMOLOGADO:       "Homologado",
};

const FONTE_LABEL: Record<typeof FONTES_EVENTO[number], string> = {
  PORTAL_PETRONECT:    "Portal Petronect",
  EMAIL_PETROBRAS:     "E-mail da Petrobras",
  DOU:                 "Diário Oficial da União",
  CONFIRMACAO_INTERNA: "Confirmação interna",
  OUTRO:               "Outra fonte",
};

export const RegistrarEventoSchema = z.object({
  cnpj:          z.string().transform((v) => v.replace(/\D/g, "")).refine((d) => d.length === 14, "CNPJ inválido"),
  fornecedor:    z.string().trim().min(2).max(300),
  tipo:          z.enum(TIPOS_EVENTO),
  dataEvento:    z.string().datetime({ offset: true }).optional(),
  motivo:        z.enum(MOTIVOS_EVENTO).optional(),
  motivoDetalhe: z.string().trim().max(500).optional(),
  fonte:         z.enum(FONTES_EVENTO).default("CONFIRMACAO_INTERNA"),
  observacao:    z.string().trim().max(1000).optional(),
});

type RegistrarEventoInput = z.infer<typeof RegistrarEventoSchema>;

export function formatZodErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".");
    if (!out[path]) out[path] = issue.message;
  }
  return out;
}
