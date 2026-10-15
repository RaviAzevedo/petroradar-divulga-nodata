/**
 * Helpers de aba XLSX no padrão Proponente — compartilhados por TODOS os relatórios
 * do hub (executivo, mercado, concorrentes, oportunidades, pipeline, etc.).
 *
 * Extraídos de executivo-xlsx.ts (onde eram privados) para que cada gerador novo
 * monte abas com a MESMA identidade visual sem copiar código. Estilo vem de
 * estilo-proponente.ts (fontes/fills/bordas/paleta).
 */

import ExcelJS from "exceljs";
import {
  fonteTitulo, fonteSecao, fonteHeader, fonteValor, fonteRodape,
  fillSecao, fillHeader, fillLinhaPar, bordaFina, argb, PROPONENTE,
} from "./estilo-proponente";

/** Aplica o estilo de cabeçalho (fundo + fonte + borda) numa linha inteira. */
export function aplicarHeaderRow(ws: ExcelJS.Worksheet, rowIdx: number, colCount: number) {
  for (let c = 1; c <= colCount; c++) {
    const cell = ws.getCell(rowIdx, c);
    cell.font = fonteHeader;
    cell.fill = fillHeader;
    cell.border = bordaFina();
    cell.alignment = { vertical: "middle" };
  }
}

/** Título + subtítulo mesclados no topo da aba (linhas 1 e 2). */
export function tituloAba(ws: ExcelJS.Worksheet, titulo: string, subtitulo: string, colCount: number) {
  ws.mergeCells(1, 1, 1, colCount);
  const t = ws.getCell(1, 1);
  t.value = titulo;
  t.font = fonteTitulo;
  t.alignment = { vertical: "middle" };
  ws.mergeCells(2, 1, 2, colCount);
  const s = ws.getCell(2, 1);
  s.value = subtitulo;
  s.font = { ...fonteValor, italic: true };
}

/** Uma linha de dados com zebra (linhas pares recebem fill claro). */
export function linhaDados(ws: ExcelJS.Worksheet, rowIdx: number, valores: (string | number | null)[]) {
  valores.forEach((v, i) => {
    const cell = ws.getCell(rowIdx, i + 1);
    cell.value = v ?? "";
    cell.font = fonteValor;
    cell.border = bordaFina();
  });
  if (rowIdx % 2 === 0) {
    for (let c = 1; c <= valores.length; c++) ws.getCell(rowIdx, c).fill = fillLinhaPar;
  }
}

/** Rodapé com marca + data de geração. */
export function rodape(ws: ExcelJS.Worksheet, rowIdx: number, geradoEm: string, colCount: number) {
  ws.mergeCells(rowIdx, 1, rowIdx, colCount);
  const cell = ws.getCell(rowIdx, 1);
  cell.value = `Petro Radar | Gerado em ${new Date(geradoEm).toLocaleString("pt-BR")}`;
  cell.font = fonteRodape;
}

/** Bloco opcional de KPIs (label | valor) antes de uma tabela. Retorna a próxima linha. */
export function blocoKpis(
  ws: ExcelJS.Worksheet, rowInicio: number, titulo: string,
  kpis: [string, string][], colCount: number,
): number {
  let row = rowInicio;
  ws.mergeCells(row, 1, row, colCount);
  const sec = ws.getCell(row, 1);
  sec.value = titulo;
  sec.font = fonteSecao; sec.fill = fillSecao;
  row++;
  for (const [label, valor] of kpis) {
    ws.getCell(row, 1).value = label;
    ws.getCell(row, 1).font = fonteHeader;
    ws.getCell(row, 1).fill = fillLinhaPar;
    ws.getCell(row, 1).border = bordaFina();
    ws.mergeCells(row, 2, row, colCount);
    ws.getCell(row, 2).value = valor;
    ws.getCell(row, 2).font = fonteValor;
    ws.getCell(row, 2).border = bordaFina();
    row++;
  }
  return row + 1;
}

export interface ColunaAba { header: string; width: number }

export interface AbaTabelaSpec {
  nome:       string;
  titulo:     string;
  subtitulo:  string;
  colunas:    ColunaAba[];
  linhas:     (string | number | null)[][];
  geradoEm:   string;
  /** Pinta a aba de laranja Proponente (usar na aba principal). */
  destaque?:  boolean;
  /** Bloco de KPIs antes da tabela: [titulo, [[label, valor], ...]]. */
  kpis?:      { titulo: string; itens: [string, string][] };
  /** Texto quando não há linhas (default "Sem dados no período."). */
  vazioMsg?:  string;
}

/**
 * Alto nível: cria uma aba de tabela completa (título, KPIs opcionais, cabeçalho,
 * linhas com zebra, rodapé). Deixa cada relatório novo conciso — só SQL + mapa de
 * colunas. Retorna a worksheet para ajustes finos (ex.: semáforo numa coluna).
 */
export function addAbaTabela(wb: ExcelJS.Workbook, spec: AbaTabelaSpec): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(spec.nome,
    spec.destaque ? { properties: { tabColor: { argb: argb(PROPONENTE.laranja) } } } : undefined);
  const colCount = spec.colunas.length;
  ws.columns = spec.colunas.map((c) => ({ width: c.width }));
  tituloAba(ws, spec.titulo, spec.subtitulo, colCount);

  let row = 4;
  if (spec.kpis) row = blocoKpis(ws, row, spec.kpis.titulo, spec.kpis.itens, colCount);

  spec.colunas.forEach((c, i) => (ws.getCell(row, i + 1).value = c.header));
  aplicarHeaderRow(ws, row, colCount);
  row++;

  if (spec.linhas.length === 0) {
    ws.mergeCells(row, 1, row, colCount);
    const c = ws.getCell(row, 1);
    c.value = spec.vazioMsg ?? "Sem dados no período.";
    c.font = { ...fonteValor, italic: true };
    c.border = bordaFina();
    row++;
  } else {
    for (const linha of spec.linhas) { linhaDados(ws, row, linha); row++; }
  }

  row++;
  rodape(ws, row, spec.geradoEm, colCount);
  return ws;
}
