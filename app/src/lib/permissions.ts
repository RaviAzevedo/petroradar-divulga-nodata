/**
 * Sistema de Permissões — Petro Radar
 *
 * Roles:
 *   ADMIN        — Acesso total. Gerencia usuários, configurações e todos os módulos.
 *   LIDER        — Aprova licitações, designa equipe, acessa métricas e sync.
 *   ORCAMENTISTA — Elabora propostas, faz upload de DFP/PPU, registra valores.
 *   TECNICO      — Participa da elaboração técnica, pode propor participações.
 *   SGI          — Sistema de Gestão Integrada. Gerencia Conformidade
 *                  (Famílias CRC, Cofre, Envelopes pós-vitória, Contratos).
 *   VISUALIZADOR — Somente leitura. Não pode propor nem editar.
 *   EXTERNO      — Colaborador externo. Acesso muito restrito (futuro uso).
 *
 * Migração dos roles antigos:
 *   admin  → ADMIN
 *   editor → LIDER
 *   viewer → VISUALIZADOR
 */

export const ROLES = {
  ADMIN: "ADMIN",
  LIDER: "LIDER",
  ORCAMENTISTA: "ORCAMENTISTA",
  TECNICO: "TECNICO",
  SGI: "SGI",
  VISUALIZADOR: "VISUALIZADOR",
  EXTERNO: "EXTERNO",
} as const;

export type UserRole = (typeof ROLES)[keyof typeof ROLES];

// ── Grupos de roles ──────────────────────────────────────────────────────────

/** Pode tudo: admin completo */
const ROLES_ADMIN = [ROLES.ADMIN] as const;

/** Controla pipelines, sync, reclassify, métricas */
const ROLES_GESTAO = [ROLES.ADMIN, ROLES.LIDER] as const;

/** Pode propor participações em licitações */
const ROLES_PROPOR = [
  ROLES.ADMIN,
  ROLES.LIDER,
  ROLES.ORCAMENTISTA,
  ROLES.TECNICO,
] as const;

/** Pode visualizar tudo (exceto EXTERNO) */
const ROLES_VISUALIZAR = [
  ROLES.ADMIN,
  ROLES.LIDER,
  ROLES.ORCAMENTISTA,
  ROLES.TECNICO,
  ROLES.SGI,
  ROLES.VISUALIZADOR,
] as const;

/** Setor responsável pela Conformidade (Famílias CRC, Cofre, Envelopes, Contratos) */
const ROLES_CONFORMIDADE = [
  ROLES.ADMIN,
  ROLES.LIDER,
  ROLES.SGI,
] as const;

// ── Funções de verificação ───────────────────────────────────────────────────

export function isAdmin(role: string): boolean {
  return role === ROLES.ADMIN;
}

export function isGestao(role: string): boolean {
  return (ROLES_GESTAO as readonly string[]).includes(role);
}

export function podeProporParticipacao(role: string): boolean {
  return (ROLES_PROPOR as readonly string[]).includes(role);
}

export function podeVisualizar(role: string): boolean {
  return (ROLES_VISUALIZAR as readonly string[]).includes(role);
}

/** Verifica se o role tem permissão para sync e reclassify do Petro Radar */
export function podeSincronizar(role: string): boolean {
  return isGestao(role);
}

/** Pertence ao setor de Conformidade (SGI / LIDER / ADMIN) */
export function isConformidade(role: string): boolean {
  return (ROLES_CONFORMIDADE as readonly string[]).includes(role);
}

// ── Módulo: Conformidade — Famílias CRC ─────────────────────────────────────

/** Pode criar/editar famílias CRC (catálogo) */
export function podeGerenciarFamilias(role: string): boolean {
  return isConformidade(role);
}

/** Pode excluir famílias (somente admin) */
export function podeExcluirFamilia(role: string): boolean {
  return isAdmin(role);
}

// ── Módulo: Conformidade — Cofre de Habilitação ─────────────────────────────

/** Pode subir/editar documentos do cofre de habilitação */
export function podeGerenciarDocumentosHabilitacao(role: string): boolean {
  return isConformidade(role) || role === ROLES.ORCAMENTISTA || role === ROLES.TECNICO;
}

/** Pode substituir versão de documento */
function podeSubstituirDocumento(role: string): boolean {
  return isConformidade(role) || role === ROLES.ORCAMENTISTA;
}

/** Pode excluir documento de habilitação (somente admin) */
export function podeExcluirDocumentoHabilitacao(role: string): boolean {
  return isAdmin(role);
}

// ── Módulo: Conformidade — Envelopes Pós-Vitória ────────────────────────────

/** Pode criar/editar envelopes de habilitação */
export function podeGerenciarEnvelope(role: string): boolean {
  return isConformidade(role);
}

/** Pode aprovar/rejeitar envelope (workflow gerencial) */
function podeAprovarEnvelope(role: string): boolean {
  return isGestao(role);
}

// ── Módulo: Conformidade — Contratos em Execução ────────────────────────────

/** Pode criar/editar contratos em execução e registrar IQF */
function podeGerenciarContratos(role: string): boolean {
  return isConformidade(role);
}

// ── Módulo: Conformidade — Importação em Massa ──────────────────────────────

/** Pode importar planilhas e disparar agent CLI */
export function podeImportarConformidade(role: string): boolean {
  return isConformidade(role);
}

/** Label legível para exibição na UI */
export const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: "Administrador",
  LIDER: "Líder",
  ORCAMENTISTA: "Orçamentista",
  TECNICO: "Técnico",
  SGI: "SGI / Conformidade",
  VISUALIZADOR: "Visualizador",
  EXTERNO: "Externo",
};

/** Role padrão para novos usuários */
export const DEFAULT_ROLE: UserRole = ROLES.VISUALIZADOR;
