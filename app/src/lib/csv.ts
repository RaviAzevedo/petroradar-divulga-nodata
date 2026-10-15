/**
 * Exporta linhas para um arquivo CSV baixado no navegador — sem libs externas.
 *
 * Usa `;` como separador (padrão do Excel pt-BR) e prefixa BOM UTF-8 para o
 * Excel abrir acentos corretamente. Valores com aspas, quebra de linha ou
 * separador são escapados entre aspas duplas.
 *
 * @param nomeArquivo nome do arquivo (com ou sem `.csv`)
 * @param linhas      array de objetos; as chaves da 1ª linha viram o cabeçalho
 */
export function exportarCSV(
  nomeArquivo: string,
  linhas: Record<string, string | number>[],
): void {
  if (typeof window === "undefined" || linhas.length === 0) return;

  const headers = Object.keys(linhas[0]);

  const escape = (v: string | number | null | undefined): string => {
    const s = v == null ? "" : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const csv = [
    headers.map(escape).join(";"),
    ...linhas.map((linha) => headers.map((h) => escape(linha[h])).join(";")),
  ].join("\r\n");

  // BOM UTF-8 (﻿) para o Excel pt-BR reconhecer a codificação.
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nomeArquivo.endsWith(".csv") ? nomeArquivo : `${nomeArquivo}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
