/**
 * Registry dos relatórios servidos por `/api/relatorios/[tipo]`.
 *
 * Cada relatório encapsula internamente o "coletar dados + gerar arquivo" (o tipo
 * do snapshot fica privado ao módulo — sem variância genérica no array). A rota
 * dinâmica resolve o slug aqui, chama o `guard` e o `gerar`.
 *
 * Hoje há um só: o currículo do RT, que a página do profissional chama direto,
 * parametrizado pelo id.
 */

import type { RelatorioDef } from "./tipos";
import { curriculoRtDef } from "./curriculo-rt";

export type { RelatorioDef, RelatorioArquivo, Formato } from "./tipos";
export { CT_XLSX, CT_PDF } from "./tipos";

export const RELATORIOS: RelatorioDef[] = [
  curriculoRtDef, // página do profissional (spec ONDA-4 §5.10)
];

export function getRelatorio(slug: string): RelatorioDef | undefined {
  return RELATORIOS.find((r) => r.slug === slug);
}
