/**
 * Catálogo dos tipos de e-mail do sistema (0028) — FONTE ÚNICA DE VERDADE.
 *
 * Cada tipo mapeia 1:1 para um template exportado em lib/email/templates.ts.
 * O admin liga/desliga tipos POR USUÁRIO em /admin/emails (tabela
 * preferencias_email); os crons consultam a preferência via
 * lib/email/destinatarios.ts.
 *
 * SEMÂNTICA — a preferência é SUBTRATIVA (decisão de produto):
 *   • `papeis` continua sendo o gate: quem não tem o papel NUNCA recebe, mesmo
 *     que a preferência esteja ligada. A matriz do admin só DESLIGA.
 *   • Ausência de linha em preferencias_email = HABILITADO (retrocompatível:
 *     ninguém deixa de receber o que já recebia sem uma ação explícita).
 *
 * Módulo PURO (só constantes + tipos): importável do client e do server. NÃO
 * importar `@/db` aqui — quem toca no banco é destinatarios.ts.
 *
 * O digest de licitações por filtro (0026) NÃO entra nesta matriz: ele já é
 * opt-in explícito, por assinatura, na seção "Assinaturas" da mesma tela.
 */

import { ROLES, type UserRole } from "@/lib/permissions";

export const TIPOS_EMAIL = [
  "PRAZO_CRITICO_LICITACAO",
  "CONVOCACAO_REMANESCENTE",
  "VENCIMENTO_DOCUMENTO",
  "VENCIMENTO_FAMILIA",
  "ENVELOPE_INCOMPLETO",
  "CONTRATO_CRITICO",
  "CNPJ_SITUACAO",
  "DIGEST_EXECUTIVO",
  "RELATORIO_MENSAL",
  "SYNC_FALHOU",
] as const;

export type TipoEmail = (typeof TIPOS_EMAIL)[number];

export type GrupoEmail =
  | "Licitações"
  | "Habilitação & Conformidade"
  | "Gestão"
  | "Sistema";

/**
 * Como o cron resolve o destinatário:
 *   PAPEL   — broadcast para todos os usuários ativos com um dos `papeis`.
 *   VINCULO — só quem está ligado ao registro (líder / resp. técnico / resp.
 *             orçamento / propositor da participação). `papeis` fica vazio:
 *             qualquer papel pode receber SE for o responsável.
 *   AMBOS   — o responsável do registro + broadcast de fallback para `papeis`.
 */
export type OrigemDestinatario = "PAPEL" | "VINCULO" | "AMBOS";

export interface TipoEmailDef {
  chave: TipoEmail;
  label: string;
  descricao: string;
  grupo: GrupoEmail;
  origem: OrigemDestinatario;
  /** Papéis do broadcast. Vazio em `VINCULO` (o vínculo é que decide). */
  papeis: readonly UserRole[];
  /** Cron que dispara — exibido na UI para o admin saber a cadência. */
  cron: string;
  cadencia: string;
}

export const CATALOGO_EMAIL: readonly TipoEmailDef[] = [
  // ── Licitações ────────────────────────────────────────────────────────────
  {
    chave: "PRAZO_CRITICO_LICITACAO",
    label: "Licitação com prazo crítico",
    descricao: "UM e-mail com as licitações ALTA/MÉDIA que entraram em prazo crítico (janela de 7 dias). Cada licitação aparece quando cruza uma faixa — 7, 3, 1 e 0 dias —, não todo dia.",
    grupo: "Licitações",
    origem: "PAPEL",
    papeis: [ROLES.ADMIN, ROLES.LIDER],
    cron: "prazos",
    cadencia: "Diário, 08:00 (só quando alguma licitação muda de faixa)",
  },
  {
    chave: "CONVOCACAO_REMANESCENTE",
    label: "Convocação de remanescente",
    descricao: "A Proponente virou a próxima elegível após desclassificação/desistência de um concorrente.",
    grupo: "Licitações",
    origem: "PAPEL",
    papeis: [ROLES.ADMIN, ROLES.LIDER],
    cron: "convocacao-watch",
    cadencia: "A cada 30 min",
  },

  // ── Habilitação & Conformidade ────────────────────────────────────────────
  {
    chave: "VENCIMENTO_DOCUMENTO",
    label: "Documento de habilitação vencendo",
    descricao: "Documento a 60, 30, 15, 7 ou 1 dia do vencimento — ou já vencido.",
    grupo: "Habilitação & Conformidade",
    origem: "PAPEL",
    papeis: [ROLES.ADMIN, ROLES.LIDER, ROLES.SGI],
    cron: "vencimentos",
    cadencia: "Diário, 09:00",
  },
  {
    chave: "VENCIMENTO_FAMILIA",
    label: "Família CRC em janela de renovação",
    descricao: "Família CRC entrou na janela de renovação (até 60 dias).",
    grupo: "Habilitação & Conformidade",
    origem: "PAPEL",
    papeis: [ROLES.ADMIN, ROLES.LIDER, ROLES.SGI],
    cron: "vencimentos",
    cadencia: "Diário, 09:00",
  },
  {
    chave: "ENVELOPE_INCOMPLETO",
    label: "Envelope de habilitação incompleto",
    descricao: "Envelope em montagem com itens pendentes ou vencidos e prazo próximo.",
    grupo: "Habilitação & Conformidade",
    origem: "PAPEL",
    papeis: [ROLES.ADMIN, ROLES.LIDER, ROLES.SGI],
    cron: "vencimentos",
    cadencia: "Diário, 09:00",
  },
  {
    chave: "CONTRATO_CRITICO",
    label: "Contrato em estado crítico",
    descricao: "Contrato ativo passou a CRÍTICO por pendências de habilitação. Vai para o responsável de SGI do contrato e, como fallback, para os papéis marcados.",
    grupo: "Habilitação & Conformidade",
    origem: "AMBOS",
    papeis: [ROLES.ADMIN, ROLES.LIDER, ROLES.SGI],
    cron: "saude-contratos",
    cadencia: "Diário, 10:30",
  },
  {
    chave: "CNPJ_SITUACAO",
    label: "Situação cadastral do CNPJ mudou",
    descricao: "Um CNPJ da Proponente deixou de estar ATIVA na Receita.",
    grupo: "Habilitação & Conformidade",
    origem: "PAPEL",
    papeis: [ROLES.ADMIN, ROLES.LIDER, ROLES.SGI],
    cron: "cnpj-watch",
    cadencia: "Semanal, segunda 06:00",
  },

  // ── Gestão ────────────────────────────────────────────────────────────────
  {
    chave: "DIGEST_EXECUTIVO",
    label: "Painel executivo semanal",
    descricao: "KPIs de performance, mercado e concorrência da semana.",
    grupo: "Gestão",
    origem: "PAPEL",
    papeis: [ROLES.ADMIN, ROLES.LIDER],
    cron: "digest-executivo",
    cadencia: "Semanal, segunda 05:00",
  },
  {
    chave: "RELATORIO_MENSAL",
    label: "Relatório executivo mensal",
    descricao: "Taxa de sucesso, valor ganho em 12 meses, participações e lacunas de CRC.",
    grupo: "Gestão",
    origem: "PAPEL",
    papeis: [ROLES.ADMIN, ROLES.LIDER],
    cron: "relatorio-mensal",
    cadencia: "Mensal, dia 1 às 03:00",
  },

  // ── Sistema ───────────────────────────────────────────────────────────────
  {
    chave: "SYNC_FALHOU",
    label: "Falha ou atraso na coleta",
    descricao: "A coleta do Petronect falhou ou está sem rodar além do limite.",
    grupo: "Sistema",
    origem: "PAPEL",
    papeis: [ROLES.ADMIN],
    cron: "sync-monitor",
    cadencia: "4x por dia",
  },
] as const;

/** Ordem de exibição dos grupos na UI. */
export const GRUPOS_EMAIL: readonly GrupoEmail[] = [
  "Licitações",
  "Habilitação & Conformidade",
  "Gestão",
  "Sistema",
] as const;

const POR_CHAVE = new Map(CATALOGO_EMAIL.map((t) => [t.chave, t]));

export function tipoEmailDef(tipo: TipoEmail): TipoEmailDef {
  const def = POR_CHAVE.get(tipo);
  if (!def) throw new Error(`Tipo de e-mail desconhecido: ${tipo}`);
  return def;
}

export function ehTipoEmail(v: unknown): v is TipoEmail {
  return typeof v === "string" && POR_CHAVE.has(v as TipoEmail);
}

/** Papéis do broadcast de um tipo (vazio = resolvido por vínculo). */
export function papeisDoTipo(tipo: TipoEmail): readonly UserRole[] {
  return tipoEmailDef(tipo).papeis;
}

/**
 * O papel do usuário o torna ELEGÍVEL a este tipo?
 * Em `VINCULO`/`AMBOS` qualquer papel é elegível — o vínculo com o registro é
 * que decide na hora do envio, então a UI não trava a linha.
 */
export function papelElegivel(tipo: TipoEmail, papel: UserRole): boolean {
  const def = tipoEmailDef(tipo);
  if (def.origem !== "PAPEL") return true;
  return def.papeis.includes(papel);
}
