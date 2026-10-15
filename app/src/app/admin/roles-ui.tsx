import type { UserRole } from "@/lib/permissions";

/**
 * Constantes de apresentação dos roles compartilhadas pelas seções do Admin
 * Center (usuarios, solicitacoes). Ficam fora das pages porque o App Router
 * restringe os exports de page.tsx.
 */

export const ROLES_OPCOES: { value: UserRole; label: string; desc: string }[] = [
  { value: "ADMIN",        label: "Administrador",   desc: "Acesso total ao sistema" },
  { value: "LIDER",        label: "Líder",           desc: "Aprova participações e acessa métricas" },
  { value: "ORCAMENTISTA", label: "Orçamentista",    desc: "Elabora propostas e faz upload de DFP/PPU" },
  { value: "TECNICO",      label: "Técnico",         desc: "Participa da elaboração técnica" },
  { value: "SGI",          label: "SGI / Conformidade", desc: "Gerencia famílias CRC, cofre, envelopes e contratos" },
  { value: "VISUALIZADOR", label: "Visualizador",    desc: "Somente leitura" },
  { value: "EXTERNO",      label: "Externo",         desc: "Colaborador externo, acesso restrito" },
];

export const ROLE_COLORS: Record<UserRole, string> = {
  ADMIN:        "bg-red-50    text-red-700    border-red-200",
  LIDER:        "bg-purple-50 text-purple-700 border-purple-200",
  ORCAMENTISTA: "bg-blue-50   text-blue-700   border-blue-200",
  TECNICO:      "bg-cyan-50   text-cyan-700   border-cyan-200",
  SGI:          "bg-orange-50 text-orange-700 border-orange-200",
  VISUALIZADOR: "bg-gray-50   text-gray-600   border-gray-200",
  EXTERNO:      "bg-amber-50  text-amber-700  border-amber-200",
};

/** Logomarca da Microsoft (4 quadrados) — badge de conta vinculada ao SSO. */
export function MicrosoftBadge() {
  return (
    <span
      title="Conta Microsoft vinculada"
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-blue-50 text-blue-700 border border-blue-200"
    >
      <svg width="9" height="9" viewBox="0 0 21 21" aria-hidden="true">
        <rect x="0"  y="0"  width="10" height="10" fill="#F25022" />
        <rect x="11" y="0"  width="10" height="10" fill="#7FBA00" />
        <rect x="0"  y="11" width="10" height="10" fill="#00A4EF" />
        <rect x="11" y="11" width="10" height="10" fill="#FFB900" />
      </svg>
      Microsoft
    </span>
  );
}
