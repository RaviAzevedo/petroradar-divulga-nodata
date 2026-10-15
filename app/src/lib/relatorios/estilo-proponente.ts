/**
 * Estilo visual padrão Proponente para relatórios exportados (XLSX/PDF).
 *
 * Identidade: laranja institucional #F59C00 + preto #1D1D1B sobre branco.
 * Centraliza paleta, fontes e helpers de estilo reusados por executivo-xlsx.ts
 * (ExcelJS) e executivo-pdf.ts (pdf-lib) — evita string hardcoded espalhada.
 *
 * As cores ARGB seguem a convenção do ExcelJS ("FF" + hex RGB). Para o pdf-lib,
 * use os helpers `corPdf*` (componentes 0..1).
 */

import type { Font, Fill, Borders, Border } from "exceljs";

// ── Paleta (hex puro) ─────────────────────────────────────────────────────────

export const PROPONENTE = {
  /** Laranja institucional. */
  laranja:     "F59C00",
  /** Preto institucional (quase preto, levemente quente). */
  preto:       "1D1D1B",
  /** Cinza de texto secundário. */
  cinza:       "4A4A4A",
  /** Cinza claro de fundo de linha. */
  cinzaClaro:  "F7F8FA",
  /** Cinza de rodapé/legendas. */
  cinzaRodape: "98A2B3",
  branco:      "FFFFFF",
  // Semáforo (status)
  verde:    "059669",
  amarelo:  "D97706",
  vermelho: "D92D20",
} as const;

// ── ARGB helpers (ExcelJS) ──────────────────────────────────────────────────

/** Converte hex RGB ("F59C00") em ARGB do ExcelJS ("FFF59C00"). */
export function argb(hexRgb: string): string {
  return "FF" + hexRgb.toUpperCase();
}

// Fontes ExcelJS reutilizáveis
export const fonteTitulo:  Partial<Font> = { bold: true, size: 16, color: { argb: argb(PROPONENTE.laranja) }, name: "Calibri" };
export const fonteSecao:   Partial<Font> = { bold: true, size: 11, color: { argb: argb(PROPONENTE.branco) }, name: "Calibri" };
export const fonteHeader:  Partial<Font> = { bold: true, size: 10, color: { argb: argb(PROPONENTE.preto) }, name: "Calibri" };
export const fonteValor:   Partial<Font> = { size: 10, color: { argb: argb(PROPONENTE.cinza) }, name: "Calibri" };
export const fonteRodape:  Partial<Font> = { size: 8, italic: true, color: { argb: argb(PROPONENTE.cinzaRodape) }, name: "Calibri" };

// Preenchimentos ExcelJS
export const fillSecao:    Fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(PROPONENTE.preto) } };
export const fillHeader:   Fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(PROPONENTE.laranja) } };
export const fillLinhaPar: Fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(PROPONENTE.cinzaClaro) } };

/** Borda fina cinza em todas as faces (para tabelas). */
export function bordaFina(): Partial<Borders> {
  const b: Partial<Border> = { style: "thin", color: { argb: "FFE2E8F0" } };
  return { top: b, left: b, bottom: b, right: b };
}

/** Cor de semáforo (ARGB) a partir de um status textual. */
export function corStatusArgb(status: "OK" | "ATENCAO" | "CRITICO" | string): string {
  if (status === "OK") return argb(PROPONENTE.verde);
  if (status === "ATENCAO") return argb(PROPONENTE.amarelo);
  return argb(PROPONENTE.vermelho);
}

// ── pdf-lib helpers (componentes 0..1) ──────────────────────────────────────

export interface RgbTriplet {
  r: number;
  g: number;
  b: number;
}

/** Converte hex RGB em triplet 0..1 para `rgb()` do pdf-lib. */
function hexParaRgb(hexRgb: string): RgbTriplet {
  const h = hexRgb.replace(/^#/, "");
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

export const corPdfLaranja = hexParaRgb(PROPONENTE.laranja);
export const corPdfPreto   = hexParaRgb(PROPONENTE.preto);
export const corPdfCinza   = hexParaRgb(PROPONENTE.cinza);
export const corPdfRodape  = hexParaRgb(PROPONENTE.cinzaRodape);

// ── Formatação numérica/monetária ──────────────────────────────────────────

export function fmtBRL(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function fmtNum(v: number | null | undefined, casas = 0): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
}

export function fmtPct(v: number | null | undefined, casas = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas })}%`;
}
