/**
 * Texto para PDF (pdf-lib) — módulo PURO, sem `@/db`, sem pdf-lib.
 *
 * `sanitizarPdf` e `quebrarLinhas` são a cópia fiel de `sanitizar`/`quebrar`,
 * privadas em `lib/licitacoes/briefing-pdf.ts` (que NÃO é tocado — spec ONDA-2
 * §5.2; a unificação fica registrada em §10 para quando aquele arquivo for
 * aberto por outro motivo). Existem aqui porque os relatórios desenham texto
 * de edital/atestado com Helvetica, que só codifica WinAnsi: sem isto
 * "≥ 12.000 m" viraria "? 12.000 m" e "01/2020 → 12/2021" viraria
 * "01/2020 ? 12/2021" — e um texto de habilitação com "?" no lugar do sinal
 * muda de sentido.
 *
 * Duas diferenças em relação ao original, as DUAS deliberadas:
 * 1. `font` é tipada ESTRUTURALMENTE (`FontePdf`) em vez de `PDFFont`, para o
 *    teste passar um objeto fake (`widthOfTextAtSize = (s, size) => s.length * size`)
 *    sem abrir o pdf-lib.
 * 2. O ponto mediano U+00B7 ("·") NÃO é tratado como marcador de lista: passa
 *    intacto. É Latin-1 (0xB7, `periodcentered` do WinAnsi — a Helvetica o
 *    codifica) e é o separador " · " de todo o relatório (cabeçalho, linhas
 *    de documento, contagens "2 · 2 · 3", rodapé); trocado por "-", "2 · 2 · 3"
 *    leria como subtração. No briefing ele só aparece como bullet de lista
 *    colada de edital, por isso lá vira "-". Quem unificar as duas cópias (§10)
 *    tem de preservar isto.
 */

/** O que `quebrarLinhas` precisa de uma fonte — `PDFFont` do pdf-lib satisfaz. */
interface FontePdf {
  widthOfTextAtSize(s: string, size: number): number;
}

/**
 * Transliteração dos caracteres fora do Latin-1 que aparecem DE VERDADE em edital
 * — e no texto que o pdfjs/unpdf devolve ao extrair PDF (ele emite as ligaduras
 * tipográficas cruas). Sem isto tudo isso cai no fallback "?" e o conteúdo MUDA DE
 * SENTIDO: "≥ 80 profissionais" viraria "? 80 profissionais".
 *
 * O Latin-1 já cobre acentos e `º ª ° § ± µ × ÷ ½ ¼ ¾ © ®` — esses NÃO entram aqui:
 * passam direto pelo filtro final.
 */
const FORA_DO_LATIN1: Array<[RegExp, string]> = [
  // Caixas de seleção (`☐`) e o aviso `⚠` sairiam como "?" pelo filtro
  // final — aqui saem legíveis.
  [/[\u2610]/g, "[ ]"],
  [/[\u2611\u2612]/g, "[x]"],
  [/[\u26a0]/g, "!"],
  [/[\ufe0f]/g, ""],
  [/[​‌‍⁠﻿]/g, ""],                 // zero-width / BOM (viravam "?")
  [/­/g, ""],                                           // hífen suave
  [/[      ]/g, " "],          // espaços fixos/finos -> espaço comum
  [/[‘’‚′]/g, "'"],                      // aspas simples curvas + prima
  [/[“”„″]/g, '"'],                      // aspas duplas curvas + prima dupla
  [/[‐‑‒–—―−]/g, "-"],    // hífens, travessões e o "menos" matemático
  [/[•▪●⁃∙]/g, "-"],           // marcadores de lista — SEM o U+00B7 (cabeçalho, item 2): é Latin-1 e passa
  [/…/g, "..."],                                        // reticências
  [/≥/g, ">="],                                         // "efetivo >= 80 profissionais" (não pode virar "?")
  [/≤/g, "<="],
  [/≠/g, "!="],
  [/≈/g, "~="],
  [/→/g, "->"],
  [/←/g, "<-"],
  [/↔/g, "<->"],
  [/⇒/g, "=>"],
  [/⁄/g, "/"],                                          // barra de fração (m3 ⁄ h)
  [/€/g, "EUR"],                                        // euro: cotação de equipamento importado
  [/™/g, "(TM)"],
  [/ℓ/g, "l"],                                          // litro cursivo
  [/μ/g, "u"],                                          // mu GREGO (μm) — o µ do Latin-1 passa direto
  [/№/g, "No."],
  [/ﬀ/g, "ff"],                                         // ligaduras: o unpdf/pdfjs as devolve CRUAS
  [/ﬁ/g, "fi"],
  [/ﬂ/g, "fl"],
  [/ﬃ/g, "ffi"],
  [/ﬄ/g, "ffl"],
];

/** Remove caracteres que a Helvetica (WinAnsi) não codifica. Latin-1 (acentos) passa. */
export function sanitizarPdf(v: unknown): string {
  if (v == null) return "";
  let t = String(v).replace(/\r/g, "").replace(/\t/g, " ");
  for (const [re, sub] of FORA_DO_LATIN1) t = t.replace(re, sub);
  return t.replace(/[^\n\x20-\x7E\xA0-\xFF]/g, "?");
}

/** Quebra `s` em linhas que cabem em `maxWidth` (pdf-lib não faz wrap). */
export function quebrarLinhas(font: FontePdf, s: string, size: number, maxWidth: number): string[] {
  const limpo = sanitizarPdf(s);
  if (!limpo) return [];
  const linhas: string[] = [];
  for (const paragrafo of limpo.split("\n")) {
    const palavras = paragrafo.split(/\s+/).filter(Boolean);
    if (!palavras.length) { linhas.push(""); continue; }
    let atual = "";
    for (const w of palavras) {
      const tentativa = atual ? `${atual} ${w}` : w;
      if (font.widthOfTextAtSize(tentativa, size) <= maxWidth) {
        atual = tentativa;
        continue;
      }
      if (atual) linhas.push(atual);
      // palavra sozinha maior que a linha: corta bruto
      if (font.widthOfTextAtSize(w, size) > maxWidth) {
        let pedaco = "";
        for (const ch of w) {
          if (font.widthOfTextAtSize(pedaco + ch, size) <= maxWidth) pedaco += ch;
          else { if (pedaco) linhas.push(pedaco); pedaco = ch; }
        }
        atual = pedaco;
      } else {
        atual = w;
      }
    }
    if (atual) linhas.push(atual);
  }
  return linhas;
}
