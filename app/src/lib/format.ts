export function normalizeCnpj(cnpj: string | null | undefined): string {
  if (!cnpj) return "";
  return cnpj.replace(/\D/g, "");
}

export function formatBRL(value: number | null | undefined): string {
  if (value == null) return "-";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

/**
 * Valores SIMBÓLICOS do Petronect: em disputas de modalidade FECHADA o portal
 * NÃO divulga os valores reais (sigilosos) — publica centavos que indicam
 * apenas o RANKING (ex.: R$ 0,94 < R$ 0,95). Nenhum contrato real fica abaixo
 * de R$ 100, então o corte é limpo (simbólico em centavos × real na casa dos milhares).
 */
export function isValorSimbolico(v: number | null | undefined): boolean {
  return v != null && v > 0 && v < 100;
}

export function formatCNPJ(cnpj: string | null | undefined): string {
  if (!cnpj) return "-";
  const digits = cnpj.replace(/\D/g, "");
  if (digits.length !== 14) return cnpj;
  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12, 14)}`;
}

export function faseColor(f: string | null): string {
  if (!f) return "text-gray-400";
  if (f.includes("Recebendo") || f.includes("Publicado")) return "text-green-600 bg-green-50";
  if (f.includes("Disputa")) return "text-purple-600 bg-purple-50";
  if (f.includes("Análise")) return "text-amber-600 bg-amber-50";
  if (f.includes("Adjudicado") || f.includes("Homologado")) return "text-blue-600 bg-blue-50";
  if (f.includes("Agendada")) return "text-cyan-600 bg-cyan-50";
  if (f.includes("Cancelado") || f.includes("Deserto") || f.includes("Fracassado") || f.includes("Encerrado") || f.includes("Prazo")) return "text-red-500 bg-red-50";
  return "text-gray-500 bg-gray-50";
}
