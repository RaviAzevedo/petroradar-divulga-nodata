import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Parseia uma string de data como data LOCAL (não UTC).
 *
 * `new Date("2026-04-01")` interpreta como meia-noite UTC, o que em BRT (UTC-3)
 * vira 31/03 21:00 — exibindo o dia anterior. Esta função garante que
 * "2026-04-01" sempre resulte em 01/04 no fuso local.
 */
function parseLocalDate(input: string | Date): Date {
  // Se já é Date, retorna direto
  if (input instanceof Date) return input;
  // Formato YYYY-MM-DD (sem horário) → forçar como local
  const match = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }
  // Outros formatos (ISO com T, timestamps) → Date nativo
  return new Date(input);
}

export function formatDate(dateStr: string | Date | null | undefined): string {
  if (!dateStr) return "-";
  const d = parseLocalDate(dateStr);
  if (isNaN(d.getTime())) return typeof dateStr === "string" ? dateStr : "-";
  return d.toLocaleDateString("pt-BR");
}

export function diasRestantes(dataFim: string | Date | null | undefined): number | null {
  if (!dataFim) return null;
  const fim = parseLocalDate(dataFim);
  if (isNaN(fim.getTime())) return null;
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  fim.setHours(0, 0, 0, 0);
  return Math.ceil((fim.getTime() - hoje.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Corrige a fase em tempo real: se a data_fim já passou e a fase
 * ainda indica "ativa" (Recebendo Propostas, Agendada), retorna "Prazo Encerrado".
 * Preserva fases que já são terminais ou definidas pelo portal.
 */
export function faseAtualizada(fase: string | null, dataFim: string | null | undefined): string {
  if (!fase) return "—";
  if (!dataFim) return fase;

  const fasesQueVencem = ["Recebendo Propostas", "Agendada (Futura)"];
  if (!fasesQueVencem.includes(fase)) return fase;

  const dias = diasRestantes(dataFim);
  if (dias !== null && dias < 0) return "Prazo Encerrado";

  return fase;
}

export function relevanciaColor(rel: string | null): string {
  switch (rel) {
    case "ALTA": return "text-red-600 bg-red-50 border-red-200";
    case "MEDIA":
    case "MÉDIA": return "text-amber-600 bg-amber-50 border-amber-200";
    case "BAIXA": return "text-blue-600 bg-blue-50 border-blue-200";
    default: return "text-gray-500 bg-gray-50 border-gray-200";
  }
}
