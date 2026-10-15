/**
 * Briefing de licitação em PDF — identidade visual Proponente (pdf-lib).
 *
 * Renderiza o briefing de proposta a partir da análise IA já persistida
 * (`analises_ia`) — mesma fonte do briefing.md/json (briefing.ts) e do checklist
 * oficial (checklist-oficial.ts). NENHUMA chamada a IA aqui: 100% sobre dados salvos.
 *
 * ── REGRAS DE MARCA (herdadas de lib/email/tokens.ts, o design system já auditado) ──
 * O manual da marca admite SÓ dois hex: laranja #F59C00 e preto #1D1D1B.
 *
 *   O LARANJA É ESTRUTURA, NUNCA TEXTO.
 *
 * #F59C00 sobre branco dá 2,18:1 de contraste — reprova até o piso de 3:1 para texto
 * grande. A única forma legítima de usar o laranja com texto é INVERTIDA: #1D1D1B
 * sobre #F59C00 = 7,75:1 (AAA). Por isso aqui o laranja só aparece como filete, rail
 * e preenchimento de tarja; todo texto é preto/cinza, e o que assenta sobre laranja
 * é preto. (A versão anterior deste arquivo desenhava o título da capa em laranja
 * sobre branco — ilegível e fora do manual. Foi essa a origem da reforma.)
 *
 * A logo entra como PNG embutido (LOGO_PROPONENTE_BASE64, 560x101, já regenerado com a
 * paleta corrigida) em vez do texto "PROPONENTE ENGENHARIA" desenhado à mão.
 *
 * Dependência: `pdf-lib` (já em package.json; mesma usada por executivo-pdf.ts).
 * Rota web-only: gerado no Next; o BFF (Python) parita o ramo de erro (o binário
 * PDF não é byte-replicável entre pdf-lib e reportlab).
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { LOGO_PROPONENTE_BASE64 } from "@/lib/email/logo-proponente"; // com slogan — capa
import { LOGO_MARCA_BASE64 } from "@/lib/email/logo-marca";       // sem slogan — header corrente
import type { AnaliseRow, BriefingMeta } from "@/lib/licitacoes/briefing";
import type { CondicaoDeParticipar } from "./habilitacao-familias";

/** Requisito rastreável (subconjunto de RequisitoEstruturado) para a tabela de habilitação. */
export interface RequisitoBriefing {
  codigo: string;
  descricao: string;
  obrigatorio?: boolean;
  confianca?: number;
}

// ── Paleta (espelha lib/email/tokens.ts, em componentes 0..1 para o pdf-lib) ──────

function hex(h: string): { r: number; g: number; b: number } {
  const s = h.replace(/^#/, "");
  return {
    r: parseInt(s.slice(0, 2), 16) / 255,
    g: parseInt(s.slice(2, 4), 16) / 255,
    b: parseInt(s.slice(4, 6), 16) / 255,
  };
}
const c = (h: string) => { const t = hex(h); return rgb(t.r, t.g, t.b); };

const LARANJA    = c("#F59C00"); // estrutura: filete, rail, tarja. NUNCA texto.
const PRETO      = c("#1D1D1B"); // tarjas, títulos
const TXT_FORTE  = c("#1D1D1B");
const TXT_CORPO  = c("#333333");
const TXT_FRACO  = c("#6A7282"); // rótulos e meta — piso 4,8:1
const TXT_INV    = c("#FFFFFF"); // sobre tarja preta
const SUPERF     = c("#F5F5F5"); // linhas alternadas / fundo de rótulo
const BORDA      = c("#E5E7EB");
const BRANCO     = c("#FFFFFF");

/** Estados semânticos (sem azul) — mesma convenção do e-mail. */
const ESTADO = {
  CRITICO: { bg: c("#FEF2F2"), borda: c("#FFC9C9"), txt: c("#C10007") },
  ATENCAO: { bg: c("#FFFBEB"), borda: c("#FEE685"), txt: c("#B45309") },
  OK:      { bg: c("#F0FDF4"), borda: c("#B9F8CF"), txt: c("#15803D") },
  NEUTRO:  { bg: c("#F5F5F5"), borda: c("#E5E7EB"), txt: c("#4A4A4A") },
} as const;
type Estado = keyof typeof ESTADO;

// ── Geometria ────────────────────────────────────────────────────────────────

const A4 = { largura: 595.28, altura: 841.89 };
const MARGEM_X = 48;
const LARGURA_UTIL = A4.largura - 2 * MARGEM_X;
const ALTURA_HEADER = 52;  // faixa branca com logo + filete laranja
const ALTURA_RODAPE = 20;  // tarja preta
const TOPO_CONTEUDO = A4.altura - ALTURA_HEADER - 24;
const BASE_CONTEUDO = ALTURA_RODAPE + 22;
const FILETE = 3.5;

interface Ctx {
  doc: PDFDocument;
  page: PDFPage;
  fonte: PDFFont;
  bold: PDFFont;
  /** Marca COM slogan (5,5:1) — só na capa, onde há escala para ela respirar. */
  logoCapa: PDFImage;
  /** Marca SEM slogan (2,7:1) — header corrente; legível a 17pt de altura. */
  logoHeader: PDFImage;
  y: number;
  numero: string;
  empresa: string;
  /** Páginas de capa não levam header/rodapé correntes. */
  paginasCapa: Set<number>;
}

// ── Texto ────────────────────────────────────────────────────────────────────

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
  [/[​‌‍⁠﻿]/g, ""],                 // zero-width / BOM (viravam "?")
  [/­/g, ""],                                           // hífen suave
  [/[      ]/g, " "],          // espaços fixos/finos -> espaço comum
  [/[‘’‚′]/g, "'"],                      // aspas simples curvas + prima
  [/[“”„″]/g, '"'],                      // aspas duplas curvas + prima dupla
  [/[‐‑‒–—―−]/g, "-"],    // hífens, travessões e o "menos" matemático
  [/[•·▪●⁃∙]/g, "-"],          // marcadores de lista
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
function sanitizar(v: unknown): string {
  if (v == null) return "";
  let t = String(v).replace(/\r/g, "").replace(/\t/g, " ");
  for (const [re, sub] of FORA_DO_LATIN1) t = t.replace(re, sub);
  return t.replace(/[^\n\x20-\x7E\xA0-\xFF]/g, "?");
}

/** Quebra `s` em linhas que cabem em `maxWidth` (pdf-lib não faz wrap). */
function quebrar(font: PDFFont, s: string, size: number, maxWidth: number): string[] {
  const limpo = sanitizar(s);
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

/** Desenha texto com tracking (espaçamento entre letras) — usado nos kickers. */
function textoTrack(page: PDFPage, txt: string, x: number, y: number, size: number, font: PDFFont, cor: ReturnType<typeof rgb>, track = 1.2) {
  let cx = x;
  for (const ch of sanitizar(txt)) {
    page.drawText(ch, { x: cx, y, size, font, color: cor });
    cx += font.widthOfTextAtSize(ch, size) + track;
  }
}

function larguraTrack(font: PDFFont, txt: string, size: number, track = 1.2): number {
  const s = sanitizar(txt);
  return font.widthOfTextAtSize(s, size) + Math.max(0, s.length - 1) * track;
}

// ── Header / rodapé correntes ────────────────────────────────────────────────

/**
 * Header das páginas de conteúdo: logo à esquerda sobre BRANCO (a marca é escura —
 * numa tarja preta ela sumiria), número do edital à direita, filete laranja embaixo.
 */
function desenharHeader(ctx: Ctx, page: PDFPage) {
  const topo = A4.altura;
  const logoH = 18;
  const logoW = (ctx.logoHeader.width / ctx.logoHeader.height) * logoH;

  page.drawImage(ctx.logoHeader, { x: MARGEM_X, y: topo - 26 - logoH + 6, width: logoW, height: logoH });

  // Kicker + número do edital, alinhados à direita
  const kicker = "BRIEFING DE LICITACAO";
  const wK = larguraTrack(ctx.fonte, kicker, 6.5, 1.4);
  textoTrack(page, kicker, A4.largura - MARGEM_X - wK, topo - 20, 6.5, ctx.fonte, TXT_FRACO, 1.4);

  const num = sanitizar(ctx.numero);
  const wN = ctx.bold.widthOfTextAtSize(num, 11);
  page.drawText(num, { x: A4.largura - MARGEM_X - wN, y: topo - 34, size: 11, font: ctx.bold, color: TXT_FORTE });

  // Filete laranja full-bleed (estrutura — a assinatura visual da marca)
  page.drawRectangle({ x: 0, y: topo - ALTURA_HEADER, width: A4.largura, height: FILETE, color: LARANJA });
}

/** Rodapé: tarja PRETA com texto branco (na tarja laranja o branco reprovaria contraste). */
function desenharRodapes(ctx: Ctx) {
  const paginas = ctx.doc.getPages();
  const total = paginas.length;
  paginas.forEach((page, i) => {
    page.drawRectangle({ x: 0, y: 0, width: A4.largura, height: ALTURA_RODAPE, color: PRETO });
    page.drawRectangle({ x: 0, y: ALTURA_RODAPE, width: A4.largura, height: 1.5, color: LARANJA });
    page.drawText("PROPONENTE ENGENHARIA  |  DOCUMENTO CONFIDENCIAL", {
      x: MARGEM_X, y: 7, size: 6.5, font: ctx.fonte, color: c("#B3B3B3"),
    });
    const pag = `${i + 1} / ${total}`;
    const w = ctx.bold.widthOfTextAtSize(pag, 7);
    page.drawText(pag, { x: A4.largura - MARGEM_X - w, y: 7, size: 7, font: ctx.bold, color: TXT_INV });
  });
}

function novaPagina(ctx: Ctx) {
  ctx.page = ctx.doc.addPage([A4.largura, A4.altura]);
  desenharHeader(ctx, ctx.page);
  ctx.y = TOPO_CONTEUDO;
}

function garantir(ctx: Ctx, altura: number) {
  if (ctx.y - altura < BASE_CONTEUDO) novaPagina(ctx);
}

// ── Primitivos de conteúdo ───────────────────────────────────────────────────

/** Cabeçalho de seção: rail laranja + tarja preta com título branco. */
function secao(ctx: Ctx, n: number, titulo: string) {
  // A tarja consome 42 (16 de respiro + 18 de barra + 26 de baixo). Reservar só
  // isso deixava a barra ÓRFÃ no pé da página, com o conteúdo na página seguinte:
  // pedimos 42 + ~2 linhas de corpo (28) para a seção nunca abrir sozinha.
  garantir(ctx, 46 + 28);
  ctx.y -= 16;
  const h = 18;
  const rail = 4;
  ctx.page.drawRectangle({ x: MARGEM_X, y: ctx.y - 4, width: rail, height: h, color: LARANJA });
  ctx.page.drawRectangle({ x: MARGEM_X + rail, y: ctx.y - 4, width: LARGURA_UTIL - rail, height: h, color: PRETO });
  const num = String(n).padStart(2, "0");
  ctx.page.drawText(num, { x: MARGEM_X + rail + 8, y: ctx.y + 1, size: 9, font: ctx.bold, color: LARANJA });
  textoTrack(ctx.page, sanitizar(titulo).toUpperCase(), MARGEM_X + rail + 28, ctx.y + 1, 9, ctx.bold, TXT_INV, 0.6);
  ctx.y -= 26; // respiro entre a tarja e o primeiro bloco de conteúdo
}

/** Rótulo em negrito acima de um bloco (subtítulo interno da seção). */
function rotulo(ctx: Ctx, txt: string) {
  // Mesmo motivo do secao(): o rótulo sozinho no pé da página é órfão — reserva
  // 13 (dele) + ~2 linhas do bloco que ele anuncia.
  garantir(ctx, 13 + 26);
  textoTrack(ctx.page, sanitizar(txt).toUpperCase(), MARGEM_X, ctx.y, 7, ctx.bold, TXT_FRACO, 0.8);
  ctx.y -= 13;
}

function paragrafo(ctx: Ctx, texto: string, size = 9) {
  const linhas = quebrar(ctx.fonte, texto, size, LARGURA_UTIL);
  for (const l of linhas) {
    garantir(ctx, size + 4);
    ctx.page.drawText(l, { x: MARGEM_X, y: ctx.y, size, font: ctx.fonte, color: TXT_CORPO });
    ctx.y -= size + 4;
  }
  ctx.y -= 4;
}

function bullets(ctx: Ctx, itens: string[], size = 9) {
  for (const item of itens) {
    const linhas = quebrar(ctx.fonte, item, size, LARGURA_UTIL - 16);
    linhas.forEach((l, i) => {
      garantir(ctx, size + 4);
      if (i === 0) {
        // marcador: quadradinho laranja (estrutura), não um caractere laranja
        ctx.page.drawRectangle({ x: MARGEM_X + 1, y: ctx.y + 2, width: 3.5, height: 3.5, color: LARANJA });
      }
      ctx.page.drawText(l, { x: MARGEM_X + 16, y: ctx.y, size, font: ctx.fonte, color: TXT_CORPO });
      ctx.y -= size + 4;
    });
    ctx.y -= 1.5;
  }
  ctx.y -= 3;
}

/**
 * Pílula de estado (fundo suave + borda + texto colorido) — risco, recomendação.
 *
 * `maxW` é o TETO de largura (a coluna que a hospeda). A IA escreve classificações
 * livres ("ALTO - risco de inabilitacao sumaria..."), e sem teto a pílula crescia
 * por cima da coluna vizinha e saía da página. Quando não cabe, o texto é truncado
 * com reticências: a pílula é um rótulo, o texto íntegro está na coluna ao lado.
 */
function pilula(
  ctx: Ctx,
  page: PDFPage,
  txt: string,
  x: number,
  y: number,
  estado: Estado,
  size = 7.5,
  maxW?: number,
  /**
   * Faixa vertical em que a pílula PODE existir (topo/base da linha da tabela).
   *
   * Sem isto, a pílula era desenhada a partir da baseline do texto (`y - 2.5`,
   * altura `size + 7`) e o topo dela caía em `y + size + 4,5` — ACIMA do topo da
   * linha (`y + 8 + 1`). Ela vazava ~3pt pra fora da faixa cinza: era o "box
   * saindo do padrão" que se via na tabela de riscos. Com a faixa, ela se
   * centraliza dentro e é grampeada — não tem como escapar.
   */
  banda?: { topo: number; base: number },
): number {
  const e = ESTADO[estado];
  let t = sanitizar(txt).toUpperCase();

  // Teto horizontal: o menor entre a coluna pedida e o que resta até a margem.
  const teto = Math.min(maxW ?? Infinity, A4.largura - MARGEM_X - x);
  const interno = teto - 12; // 6pt de respiro de cada lado
  if (ctx.bold.widthOfTextAtSize(t, size) > interno) {
    while (t.length > 0 && ctx.bold.widthOfTextAtSize(`${t}...`, size) > interno) t = t.slice(0, -1);
    t = `${t}...`;
  }
  const w = Math.min(ctx.bold.widthOfTextAtSize(t, size) + 12, Math.max(teto, 0));

  let h = size + 6;
  let baseCaixa = y - 2;

  if (banda) {
    const alturaBanda = banda.topo - banda.base;
    h = Math.min(h, Math.max(alturaBanda - 2, size + 2)); // nunca maior que a faixa
    // centraliza na PRIMEIRA linha da célula (não na linha inteira, que pode ter
    // 3 linhas de texto ao lado — a pílula rotula a linha, e o olho a espera em cima)
    const centroPrimeiraLinha = y + size * 0.32;
    baseCaixa = centroPrimeiraLinha - h / 2;
    // grampeia dentro da faixa
    baseCaixa = Math.min(baseCaixa, banda.topo - h - 1);
    baseCaixa = Math.max(baseCaixa, banda.base + 1);
  }

  page.drawRectangle({ x, y: baseCaixa, width: w, height: h, color: e.bg, borderColor: e.borda, borderWidth: 0.8 });
  // texto centrado verticalmente na caixa (aproximação boa p/ Helvetica: 0,30·size)
  page.drawText(t, { x: x + 6, y: baseCaixa + h / 2 - size * 0.34, size, font: ctx.bold, color: e.txt });
  return w;
}

/**
 * Quebra o texto em no MÁXIMO `maxLinhas`, com reticências quando sobra conteúdo.
 *
 * Existe porque a capa é um resumo e precisa caber — mas cortar no meio da palavra
 * e parar, como fazia o `.slice(0, n)` de antes, faz a frase parecer bug: o valor
 * estimado saía "R$ 12.345.678,90 (orçamento referencial total, prazo de execução
 * de 1460" e acabava ali. As reticências dizem ao leitor que há mais, e o dado
 * íntegro está sempre nas seções do miolo.
 */
function truncarLinhas(
  font: PDFFont,
  texto: string,
  size: number,
  maxWidth: number,
  maxLinhas: number,
): string[] {
  const linhas = quebrar(font, texto, size, maxWidth);
  if (linhas.length <= maxLinhas) return linhas;

  const mantidas = linhas.slice(0, maxLinhas);
  let ultima = mantidas[maxLinhas - 1];
  // abre espaço para as reticências, cortando por PALAVRA (nunca no meio dela)
  while (ultima.length > 0 && font.widthOfTextAtSize(`${ultima}...`, size) > maxWidth) {
    const corte = ultima.lastIndexOf(" ");
    ultima = corte > 0 ? ultima.slice(0, corte) : ultima.slice(0, -1);
  }
  mantidas[maxLinhas - 1] = `${ultima}...`;
  return mantidas;
}

/**
 * Tabela rótulo→valor. Rótulo em caixa cinza à esquerda, valor à direita.
 *
 * A linha QUEBRA ENTRE PÁGINAS. Antes, a altura da linha era o número de linhas do
 * valor sem teto nenhum: um `docs_habilitacao` que a IA escreve em parágrafos (o
 * schema Zod não limita) gerava `h` maior que a página inteira, o `garantir` abria
 * uma página nova e o texto era desenhado ABAIXO do rodapé — sumia do PDF sem erro.
 * Agora só desenhamos o que cabe e o resto continua na página seguinte, com o
 * rótulo marcado "(cont.)". Nada de truncar: isto é conteúdo de habilitação.
 */
function tabelaInfo(ctx: Ctx, rows: Array<[string, string]>) {
  const visiveis = rows.filter(([, v]) => sanitizar(v).trim() !== "");
  if (!visiveis.length) return;
  const rotuloW = 148;
  const valorW = LARGURA_UTIL - rotuloW - 20;
  const size = 8.5;
  const passo = size + 3.5;
  const ROT_SIZE = 6.8;
  const ROT_TRACK = 0.5;
  const ROT_MAX = rotuloW - 14; // calha até a coluna do valor (que começa em rotuloW + 10)
  /** Quantas linhas do valor ainda cabem na página corrente (8 = respiro do fim da linha). */
  const cabem = () => Math.floor((ctx.y + size + 1 - 8 - BASE_CONTEUDO) / passo);

  visiveis.forEach(([rot, val], idx) => {
    const linhas = quebrar(ctx.fonte, val, size, valorW);
    if (!linhas.length) return;

    let i = 0;
    let cont = false;
    while (i < linhas.length) {
      // Abre página nova se não couber nem o mínimo (evita viúva de 1 linha). Numa
      // página limpa cabem ~60 linhas, então o laço SEMPRE progride.
      let n = Math.min(cabem(), linhas.length - i);
      if (n < Math.min(2, linhas.length - i)) {
        novaPagina(ctx);
        n = Math.max(1, Math.min(cabem(), linhas.length - i)); // >= 1: o laco tem de progredir
      }

      const fatia = linhas.slice(i, i + n);
      const h = fatia.length * passo + 8;
      const topoLinha = ctx.y + size + 1;

      if (idx % 2 === 0) {
        ctx.page.drawRectangle({ x: MARGEM_X, y: topoLinha - h, width: LARGURA_UTIL, height: h, color: SUPERF });
      }
      // fio divisor
      ctx.page.drawRectangle({ x: MARGEM_X, y: topoLinha - h, width: LARGURA_UTIL, height: 0.5, color: BORDA });

      // O rótulo é preso à SUA coluna: "DOCUMENTOS DE HABILITACAO (CONT.)" não cabe
      // nos 148pt e invadia o texto do valor. Cortamos a base e preservamos o
      // sufixo — é ele que diz ao leitor que a página anterior continua aqui.
      const sufixo = cont ? " (CONT.)" : "";
      let base = sanitizar(rot).toUpperCase();
      if (larguraTrack(ctx.bold, base + sufixo, ROT_SIZE, ROT_TRACK) > ROT_MAX) {
        while (base.length > 1 && larguraTrack(ctx.bold, `${base}...${sufixo}`, ROT_SIZE, ROT_TRACK) > ROT_MAX) {
          base = base.slice(0, -1);
        }
        base = `${base}...`;
      }
      textoTrack(ctx.page, base + sufixo, MARGEM_X + 10, ctx.y, ROT_SIZE, ctx.bold, TXT_FRACO, ROT_TRACK);
      fatia.forEach((l, j) => {
        ctx.page.drawText(l, {
          x: MARGEM_X + rotuloW + 10, y: ctx.y - j * passo,
          size, font: ctx.fonte, color: TXT_CORPO,
        });
      });
      ctx.y -= h;
      i += fatia.length;
      cont = true;
    }
  });
  ctx.y -= 8;
}

/**
 * Tabela de dados: header preto, linhas alternadas, última coluna opcionalmente
 * renderizada como pílula de estado.
 *
 * A linha QUEBRA ENTRE PÁGINAS, célula a célula (mesma janela de linhas em todas as
 * colunas). O código antigo calculava `h = nLin * (size + 3) + 8` sem teto e só
 * reposicionava a linha UMA vez: um "Requisito" longo (os `requisitos_estruturados`
 * chegam com o `trecho_citado` colado na descrição) transbordava a página e sumia.
 * A pílula da última coluna só entra na PRIMEIRA fatia — ela rotula a linha inteira.
 */
function tabelaDados(
  ctx: Ctx,
  headers: string[],
  rows: string[][],
  colFrac: number[],
  estadoDaUltima?: (v: string) => Estado | null,
) {
  const size = 8;
  const passo = size + 3;
  const cols = colFrac.map((f) => f * LARGURA_UTIL);
  /** Quantas linhas de célula ainda cabem na página corrente (8 = respiro do fim da linha). */
  const cabem = () => Math.floor((ctx.y + size + 1 - 8 - BASE_CONTEUDO) / passo);

  const header = () => {
    // 24 (a tarja) + ~1 linha de dados: header sozinho no pé da página é órfão.
    garantir(ctx, 24 + 22);
    ctx.page.drawRectangle({ x: MARGEM_X, y: ctx.y - 4, width: LARGURA_UTIL, height: 15, color: PRETO });
    let cx = MARGEM_X + 8;
    headers.forEach((h, i) => {
      textoTrack(ctx.page, sanitizar(h).toUpperCase(), cx, ctx.y + 0.5, 6.8, ctx.bold, TXT_INV, 0.5);
      cx += cols[i];
    });
    ctx.y -= 19;
  };
  header();

  rows.forEach((row, idx) => {
    const ultima = row.length - 1;
    // Pré-quebra por célula. A coluna-pílula fica com 1 "linha" (o rótulo); as
    // demais viram o vetor de linhas já ajustado à largura da coluna.
    const ests = row.map((cell, i) => (i === ultima && estadoDaUltima ? estadoDaUltima(cell) : null));
    const celulas = row.map((cell, i) =>
      ests[i] ? [cell] : quebrar(ctx.fonte, cell, size, cols[i] - 14),
    );
    const nLin = Math.max(1, ...celulas.map((cel) => cel.length || 1));

    let i0 = 0;
    while (i0 < nLin) {
      // Não cabe nem o mínimo: página nova + header repetido (tabela nunca órfã).
      let n = Math.min(cabem(), nLin - i0);
      if (n < Math.min(2, nLin - i0)) {
        novaPagina(ctx);
        header();
        n = Math.max(1, Math.min(cabem(), nLin - i0)); // >= 1: o laco tem de progredir
      }

      // Topo da linha 4pt acima da baseline (era 1): a pílula precisa desse ar,
      // senão o topo dela ultrapassa a faixa cinza — o "box saindo do padrão".
      const h = n * passo + 11;
      const topoLinha = ctx.y + size + 4;
      const baseLinha = topoLinha - h;

      if (idx % 2 === 0) {
        ctx.page.drawRectangle({ x: MARGEM_X, y: baseLinha, width: LARGURA_UTIL, height: h, color: SUPERF });
      }
      ctx.page.drawRectangle({ x: MARGEM_X, y: baseLinha, width: LARGURA_UTIL, height: 0.5, color: BORDA });

      const continuacao = i0 > 0;

      let x = MARGEM_X + 8;
      celulas.forEach((cel, i) => {
        const est = ests[i];
        if (est) {
          if (!continuacao) {
            // a pílula rotula a linha inteira: sai só na primeira fatia, e agora
            // GRAMPEADA dentro da faixa (topo/base), sem chance de vazar.
            pilula(ctx, ctx.page, cel[0], x, ctx.y, est, 6.8, cols[i] - 14, { topo: topoLinha, base: baseLinha });
          } else {
            // fatia de continuação: em vez de uma célula muda (que parecia linha
            // órfã sem classificação), diz que é a mesma linha da página anterior.
            ctx.page.drawText("(cont.)", { x, y: ctx.y, size: 6.5, font: ctx.fonte, color: TXT_FRACO });
          }
        } else {
          cel.slice(i0, i0 + n).forEach((l, j) => {
            ctx.page.drawText(l, { x, y: ctx.y - j * passo, size, font: ctx.fonte, color: TXT_CORPO });
          });
        }
        x += cols[i];
      });
      ctx.y -= h;
      i0 += n;
    }
  });
  ctx.y -= 8;
}

// ── Coerção de dados ─────────────────────────────────────────────────────────

function ckObj(a: AnaliseRow): Record<string, unknown> {
  return a.checklist && typeof a.checklist === "object" ? (a.checklist as Record<string, unknown>) : {};
}
function s(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}
function arrStr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x : x == null ? "" : JSON.stringify(x))).filter(Boolean);
}

function estadoDoRisco(v: string): Estado {
  const up = sanitizar(v).toUpperCase();
  if (up.startsWith("ALTO")) return "CRITICO";
  if (up.startsWith("MED") || up.startsWith("MÉD")) return "ATENCAO";
  if (up.startsWith("BAIXO")) return "OK";
  return "NEUTRO";
}

/** Deriva o veredito da recomendação: "PARTICIPAR / NÃO PARTICIPAR / AVALIAR ...". */
function vereditoDaRecomendacao(rec: string): { rotulo: string; estado: Estado } {
  const up = sanitizar(rec).trim().toUpperCase();
  if (up.startsWith("NAO PARTICIPAR") || up.startsWith("NÃO PARTICIPAR")) return { rotulo: "NAO PARTICIPAR", estado: "CRITICO" };
  if (up.startsWith("PARTICIPAR")) return { rotulo: "PARTICIPAR", estado: "OK" };
  if (up.startsWith("AVALIAR")) return { rotulo: "AVALIAR", estado: "ATENCAO" };
  return { rotulo: "SEM VEREDITO", estado: "NEUTRO" };
}

const SEM_DADO = "Nao consta nos documentos analisados - confirmar com o cliente.";

/**
 * Bloco de abertura do miolo: o resumo executivo, destacado num cartão com rail
 * laranja. Não é numerado — é a "lead" do briefing, antes das 12 seções.
 *
 * O CARTÃO QUEBRA ENTRE PÁGINAS. Antes ele tinha altura ilimitada (`linhas.length *
 * 14 + 34`) e um único `garantir`: com um resumo de ~2.500 caracteres a altura já
 * passava da página inteira, o `garantir` abria uma folha nova e o cartão vazava
 * pelo rodapé — o fim do resumo simplesmente não existia no PDF. Agora fatiamos o
 * texto pelo que cabe e redesenhamos o cartão (fundo + rail) em cada página, com o
 * kicker marcado "(CONT.)".
 */
function resumoExecutivo(ctx: Ctx, texto: string) {
  const SIZE = 9.5;
  const PASSO = 14;
  const CROMO = 34; // kicker + respiros de cima e de baixo do cartão
  const linhas = quebrar(ctx.fonte, texto, SIZE, LARGURA_UTIL - 34);
  if (!linhas.length) return;

  /** Linhas de texto que ainda cabem no cartão desta página (ele nasce 12pt acima do y). */
  const cabem = () => Math.floor((ctx.y + 12 - CROMO - BASE_CONTEUDO) / PASSO);

  let i = 0;
  let cont = false;
  while (i < linhas.length) {
    // Numa página limpa cabem ~50 linhas; com menos de 3 o cartão não se paga.
    let n = Math.min(cabem(), linhas.length - i);
    if (n < Math.min(3, linhas.length - i)) {
      novaPagina(ctx);
      n = Math.max(1, Math.min(cabem(), linhas.length - i)); // >= 1: o laco tem de progredir
    }

    const fatia = linhas.slice(i, i + n);
    const h = fatia.length * PASSO + CROMO;
    const topo = ctx.y + 12;

    ctx.page.drawRectangle({ x: MARGEM_X, y: topo - h, width: LARGURA_UTIL, height: h, color: SUPERF, borderColor: BORDA, borderWidth: 0.8 });
    ctx.page.drawRectangle({ x: MARGEM_X, y: topo - h, width: 4, height: h, color: LARANJA });

    textoTrack(ctx.page, cont ? "RESUMO EXECUTIVO (CONT.)" : "RESUMO EXECUTIVO", MARGEM_X + 18, topo - 18, 7, ctx.bold, TXT_FRACO, 1);
    let y = topo - 36;
    for (const l of fatia) {
      ctx.page.drawText(l, { x: MARGEM_X + 18, y, size: SIZE, font: ctx.fonte, color: TXT_FORTE });
      y -= PASSO;
    }
    ctx.y = topo - h - 10;
    i += fatia.length;
    cont = true;
  }
}

// ── Capa ─────────────────────────────────────────────────────────────────────

function desenharCapa(ctx: Ctx, meta: BriefingMeta, a: AnaliseRow, ck: Record<string, unknown>) {
  const page = ctx.doc.addPage([A4.largura, A4.altura]);
  ctx.page = page;
  ctx.paginasCapa.add(ctx.doc.getPages().length - 1);

  let y = A4.altura;

  // Marca COM slogan, em escala grande — sobre branco (a marca é escura; numa
  // tarja preta ela sumiria).
  const logoH = 30;
  const logoW = (ctx.logoCapa.width / ctx.logoCapa.height) * logoH;
  y -= 62;
  page.drawImage(ctx.logoCapa, { x: MARGEM_X, y, width: logoW, height: logoH });

  // Filete laranja full-bleed
  y -= 26;
  page.drawRectangle({ x: 0, y, width: A4.largura, height: FILETE + 1, color: LARANJA });

  // Kicker
  y -= 52;
  textoTrack(page, "BRIEFING PARA ELABORACAO DE PROPOSTA", MARGEM_X, y, 8, ctx.bold, TXT_FRACO, 1.8);

  // Número do edital — o herói tipográfico da capa, em PRETO (nunca laranja)
  y -= 44;
  page.drawText(sanitizar(meta.numero), { x: MARGEM_X, y, size: 34, font: ctx.bold, color: TXT_FORTE });

  // Cliente + segmento
  y -= 22;
  const sub = [s(ck.cliente) || s(meta.empresa), s(meta.segmento)].filter(Boolean).join("  |  ");
  if (sub) page.drawText(sanitizar(sub), { x: MARGEM_X, y, size: 11, font: ctx.fonte, color: TXT_CORPO });

  // Objeto (até 4 linhas, com reticências — nunca corte seco no meio da palavra)
  y -= 26;
  const objeto = s(a.objetoDetalhado) || s(meta.objeto);
  truncarLinhas(ctx.fonte, objeto, 9.5, LARGURA_UTIL, 4).forEach((l) => {
    page.drawText(l, { x: MARGEM_X, y, size: 9.5, font: ctx.fonte, color: TXT_FRACO });
    y -= 13.5;
  });

  // ── Cartão de fatos-chave ──────────────────────────────────────────────────
  //
  // A LINHA CRESCE. Antes era altura fixa (22pt) e o valor pegava só a PRIMEIRA
  // linha do wrap: com o edital inteiro na análise, a IA passou a escrever valores
  // longos ("R$ 12.345.678,90 (orçamento referencial total, prazo de execução de
  // 1460 dias)") e o cartão exibia "…prazo de execução de 1460" — cortado no meio,
  // sem reticências, parecendo defeito. Agora a linha acomoda até 2 linhas de
  // valor e, se ainda sobrar, entra "..." (o dado íntegro está nas seções 01 e 07).
  y -= 26;
  const fatos: Array<[string, string]> = [
    ["Cliente",            s(ck.cliente) || s(meta.empresa) || "-"],
    ["Valor estimado",     s(a.valorEstimado) || "-"],
    ["Limite da proposta", s(ck.data_limite_proposta) || "-"],
    ["Esclarecimentos",    s(ck.data_limite_esclarecimentos) || "-"],
    ["Local do servico",   s(ck.local_servico) || "-"],
    ["Duracao",            s(ck.duracao_contrato) || "-"],
  ];

  const VAL_X = MARGEM_X + 170;
  const VAL_W = LARGURA_UTIL - 190;
  const PASSO_VAL = 11.5;
  const PAD_LINHA = 11;

  // mede antes de desenhar: o cartão precisa nascer com a altura certa
  const fatosLinhas = fatos.map(([rot, val]) => ({
    rot,
    linhas: truncarLinhas(ctx.fonte, val, 9, VAL_W, 2),
  }));
  const alturas = fatosLinhas.map((f) => Math.max(1, f.linhas.length) * PASSO_VAL + PAD_LINHA);
  const cartaoH = alturas.reduce((s0, h0) => s0 + h0, 0);

  page.drawRectangle({
    x: MARGEM_X, y: y + 12 - cartaoH, width: LARGURA_UTIL, height: cartaoH,
    color: BRANCO, borderColor: BORDA, borderWidth: 1,
  });

  let fy = y;
  fatosLinhas.forEach((f, i) => {
    const hLinha = alturas[i];
    const topo = fy + 12;
    if (i % 2 === 0) {
      page.drawRectangle({ x: MARGEM_X + 1, y: topo - hLinha, width: LARGURA_UTIL - 2, height: hLinha, color: SUPERF });
    }
    textoTrack(page, f.rot.toUpperCase(), MARGEM_X + 14, fy, 6.8, ctx.bold, TXT_FRACO, 0.5);
    f.linhas.forEach((l, j) => {
      page.drawText(l, { x: VAL_X, y: fy - j * PASSO_VAL, size: 9, font: ctx.fonte, color: TXT_CORPO });
    });
    fy -= hLinha;
  });
  y = fy - 8;

  // ── Tarja de veredito ──────────────────────────────────────────────────────
  // O veredito é a única coisa que o leitor da capa precisa decidir olhando.
  // A pílula fica no topo, e a justificativa corre embaixo em largura cheia —
  // colocá-la ao lado da pílula espremia o texto e o cortava no meio da frase.
  const vd = vereditoDaRecomendacao(s(a.recomendacao));
  // O veredito já está na pílula; tiramos o prefixo do texto para não repetir —
  // e recapitalizamos, senão a frase abre em minúscula ("o escopo e o valor...").
  const justBruta = s(a.recomendacao).replace(/^(NAO PARTICIPAR|NÃO PARTICIPAR|PARTICIPAR|AVALIAR)\s*[-–—:]?\s*/i, "");
  const just = justBruta ? justBruta.charAt(0).toUpperCase() + justBruta.slice(1) : "";
  // 4 linhas (era 3) e com reticências: a justificativa da IA ficou mais densa
  // depois que ela passou a ler o edital inteiro, e o corte seco deixava a frase
  // pela metade ("...A participação é").
  const linhasJust = truncarLinhas(ctx.fonte, just, 8.5, LARGURA_UTIL - 40, 4);
  const tarjaH = 46 + linhasJust.length * 11.5;
  const topoTarja = y + 12;
  const baseTarja = topoTarja - tarjaH;

  page.drawRectangle({ x: MARGEM_X, y: baseTarja, width: 4, height: tarjaH, color: LARANJA });
  page.drawRectangle({ x: MARGEM_X + 4, y: baseTarja, width: LARGURA_UTIL - 4, height: tarjaH, color: PRETO });

  textoTrack(page, "RECOMENDACAO", MARGEM_X + 20, y, 6.8, ctx.bold, c("#B3B3B3"), 1);
  // grampeada na tarja: sem a faixa, o topo da pílula subia por cima do kicker
  pilula(ctx, page, vd.rotulo, MARGEM_X + 20, y - 20, vd.estado, 8, LARGURA_UTIL - 40, {
    topo: y - 10,
    base: y - 26,
  });

  let jy = y - 42;
  for (const l of linhasJust) {
    page.drawText(l, { x: MARGEM_X + 20, y: jy, size: 8.5, font: ctx.fonte, color: c("#E5E5E5") });
    jy -= 11.5;
  }
  y = baseTarja - 20;

  // ── Principais riscos (topo 3) ─────────────────────────────────────────────
  // Ocupa a metade inferior da capa com o que de fato decide um GO/NO-GO.
  const riscosCapa = (Array.isArray(a.riscos) ? (a.riscos as Array<{ descricao?: unknown; classificacao?: unknown }>) : [])
    .slice()
    .sort((x, z) => {
      const peso = (r: unknown) => (estadoDoRisco(s(r)) === "CRITICO" ? 0 : estadoDoRisco(s(r)) === "ATENCAO" ? 1 : 2);
      return peso(x.classificacao) - peso(z.classificacao);
    })
    .slice(0, 3);

  if (riscosCapa.length) {
    textoTrack(page, "PRINCIPAIS RISCOS", MARGEM_X, y, 7, ctx.bold, TXT_FRACO, 1);
    y -= 18;
    for (const r of riscosCapa) {
      const est = estadoDoRisco(s(r.classificacao));
      // 3 linhas (era 2) e com reticências: os riscos que a IA escreve agora são
      // frases inteiras, e o corte seco deixava "...havendo também referência a".
      const linhas = truncarLinhas(ctx.fonte, s(r.descricao), 8.5, LARGURA_UTIL - 80, 3);
      const h = Math.max(24, linhas.length * 11.5 + 12);
      const topo = y + 11;
      const base = topo - h;

      page.drawRectangle({ x: MARGEM_X, y: base, width: LARGURA_UTIL, height: h, color: SUPERF, borderColor: BORDA, borderWidth: 0.6 });
      // A descrição começa em MARGEM_X + 70: a pílula tem 54pt de teto (calha de
      // 8pt), senão uma classificação longa corre POR BAIXO do texto do risco.
      // A faixa (topo/base) impede que ela vaze pra fora do cartão.
      pilula(ctx, page, s(r.classificacao) || "MEDIO", MARGEM_X + 8, y, est, 6.5, 54, { topo, base });
      linhas.forEach((l, i) => {
        page.drawText(l, { x: MARGEM_X + 70, y: y - i * 11.5, size: 8.5, font: ctx.fonte, color: TXT_CORPO });
      });
      y = base - 5;
    }
    y -= 8;
  }

  // ── Aviso de PROCEDÊNCIA (0032) — o mais importante da capa ────────────────
  //
  // Um briefing feito sobre a linha de objeto tem exatamente as mesmas 12 seções
  // de um feito sobre o edital inteiro. Sem este bloco, NADA no documento
  // distingue os dois — e quem recebe confia igual nos dois. Vai na CAPA, em
  // vermelho, acima do aviso de parse, porque não ter lastro documental é pior
  // que ter extração suja: na extração suja o texto existe e está errado; aqui o
  // texto nunca existiu.
  if (a.fonteTexto === "OBJETO") {
    const e = ESTADO.CRITICO;
    const chars = a.charsEntrada != null ? `${a.charsEntrada} caracteres` : "poucos caracteres";
    page.drawRectangle({ x: MARGEM_X, y: y - 32, width: LARGURA_UTIL, height: 44, color: e.bg, borderColor: e.borda, borderWidth: 1.5 });
    page.drawText("BRIEFING PARCIAL - SEM LASTRO DOCUMENTAL", {
      x: MARGEM_X + 12, y: y - 6, size: 9.5, font: ctx.bold, color: e.txt,
    });
    page.drawText(`Feito so sobre a linha de objeto (${chars}), NAO sobre os documentos do edital.`, {
      x: MARGEM_X + 12, y: y - 19, size: 8, font: ctx.fonte, color: e.txt,
    });
    page.drawText("Baixe os anexos e refaca a analise antes de usar isto para decidir.", {
      x: MARGEM_X + 12, y: y - 29, size: 8, font: ctx.fonte, color: e.txt,
    });
    y -= 56;
  }

  // ── Aviso de erro de parse (quando a extração saiu suja) ───────────────────
  if (a.erroParse) {
    const e = ESTADO.CRITICO;
    page.drawRectangle({ x: MARGEM_X, y: y - 20, width: LARGURA_UTIL, height: 28, color: e.bg, borderColor: e.borda, borderWidth: 1 });
    page.drawText("ATENCAO: a extracao da IA foi marcada com erro de parse - revise todos os campos manualmente.", {
      x: MARGEM_X + 12, y: y - 10, size: 8, font: ctx.bold, color: e.txt,
    });
    y -= 40;
  }

  // ── Metadados de geração (pé da capa) ──────────────────────────────────────
  const meta1 = `Gerado em ${new Date().toLocaleString("pt-BR")} pelo Petro Radar`;
  const meta2 = a.modeloUsado ? `Modelo: ${sanitizar(a.modeloUsado)}` : "";
  page.drawText(meta1, { x: MARGEM_X, y: BASE_CONTEUDO + 14, size: 7.5, font: ctx.fonte, color: TXT_FRACO });
  if (meta2) page.drawText(meta2, { x: MARGEM_X, y: BASE_CONTEUDO + 3, size: 7.5, font: ctx.fonte, color: TXT_FRACO });

  const aviso = "Documento gerado por IA a partir dos anexos da licitacao. Confira contra o edital antes de decidir.";
  const wA = ctx.fonte.widthOfTextAtSize(aviso, 7);
  page.drawText(aviso, { x: A4.largura - MARGEM_X - wA, y: BASE_CONTEUDO + 3, size: 7, font: ctx.fonte, color: TXT_FRACO });
}

// ── API principal ────────────────────────────────────────────────────────────

/**
 * Gera o Briefing PDF (Buffer) a partir da análise persistida.
 *
 * @param meta   identificação da licitação (numero/objeto/empresa/segmento)
 * @param a      linha `analises_ia` (subconjunto AnaliseRow)
 * @param reqs   requisitos estruturados (de resposta_raw) — opcional, p/ tabela de habilitação
 */

// ── Habilitação por família CRC ──────────────────────────────────────────────

/**
 * Estado visual de cada veredito. Sem emoji: o PDF usa Helvetica padrão, que não
 * tem os glifos — no Markdown o ✅ funciona, aqui viraria caixinha. A cor e a
 * palavra fazem o trabalho.
 */
const VEREDITO_PDF: Record<string, { rotulo: string; estado: Estado }> = {
  PODE:              { rotulo: "PODE PARTICIPAR",        estado: "OK" },
  PODE_COM_RESSALVA: { rotulo: "PODE, COM RESSALVA",     estado: "ATENCAO" },
  RISCO:             { rotulo: "RISCO DE INABILITACAO",  estado: "ATENCAO" },
  NAO_PODE:          { rotulo: "NAO PODE PARTICIPAR",    estado: "CRITICO" },
  A_APURAR:          { rotulo: "A APURAR",               estado: "NEUTRO" },
  SEM_FAMILIA:       { rotulo: "SEM FAMILIA IDENTIFICADA", estado: "NEUTRO" },
};

/**
 * O bloco que responde "temos condição de participar?".
 *
 * Vem logo depois do resumo executivo e ANTES das seções numeradas, de
 * propósito: é a única parte do briefing que fala do que a PROPONENTE tem, e quem
 * abre o documento está decidindo ir ou não ir. Um resumo bem escrito de uma
 * licitação em que não podemos nos habilitar é tempo perdido lido na ordem
 * errada.
 *
 * Não é numerado pelo mesmo motivo do resumo executivo: numerar obrigaria a
 * renumerar as 12 seções, e o alinhamento delas com a skill é o que já existe
 * de bom no documento.
 */
function habilitacaoFamilias(ctx: Ctx, h: CondicaoDeParticipar) {
  const geral = VEREDITO_PDF[h.vereditoGeral] ?? VEREDITO_PDF.A_APURAR;
  const e = ESTADO[geral.estado];

  const resumoLinhas = quebrar(ctx.fonte, sanitizar(h.resumo), 9, LARGURA_UTIL - 34);
  garantir(ctx, 30 + resumoLinhas.length * 12 + 30);

  ctx.y -= 16;
  const topo = ctx.y + 12;
  const alturaCartao = 34 + resumoLinhas.length * 12;
  ctx.page.drawRectangle({
    x: MARGEM_X, y: topo - alturaCartao, width: LARGURA_UTIL, height: alturaCartao,
    color: e.bg, borderColor: e.borda, borderWidth: 0.8,
  });
  ctx.page.drawRectangle({ x: MARGEM_X, y: topo - alturaCartao, width: 4, height: alturaCartao, color: LARANJA });
  textoTrack(ctx.page, "TEMOS CONDICAO DE PARTICIPAR?", MARGEM_X + 18, topo - 15, 7, ctx.bold, TXT_FRACO, 1);
  ctx.page.drawText(geral.rotulo, {
    x: MARGEM_X + 18, y: topo - 29, size: 11, font: ctx.bold, color: e.txt,
  });
  let yy = topo - 44;
  for (const l of resumoLinhas) {
    ctx.page.drawText(l, { x: MARGEM_X + 18, y: yy, size: 9, font: ctx.fonte, color: TXT_CORPO });
    yy -= 12;
  }
  ctx.y = topo - alturaCartao - 14;

  paragrafo(
    ctx,
    "Veredito por familia CRC, cruzando o cadastro da Proponente com o acervo de " +
    "atestados. Habilitacao e elo mais fraco: o veredito acima e o PIOR entre as " +
    "familias exigidas, nao a media.",
    8,
  );

  if (h.semProvaConfirmadaNoSistema) {
    // A ressalva mais importante do bloco inteiro, e por isso vai em vermelho e
    // no corpo — nao em nota de rodape. Dizer "habilitados" com base em indicio
    // seria pior que omitir a secao.
    paragrafo(
      ctx,
      "ATENCAO: nenhum vinculo documento-familia foi confirmado por uma pessoa " +
      "ainda. Tudo que aparece abaixo como lastro e INDICIO da maquina: serve " +
      "para orientar a busca do atestado, nao para afirmar habilitacao nem para " +
      "sustentar um NO-GO.",
      8,
    );
  }

  if (h.familias.length === 0) return;

  if (h.dataReferencia) {
    paragrafo(
      ctx,
      `Validade do CRC medida contra ${h.dataReferencia.toLocaleDateString("pt-BR")} (data de referencia da licitacao).`,
      8,
    );
  }

  for (const f of h.familias) {
    const v = VEREDITO_PDF[f.veredito] ?? VEREDITO_PDF.A_APURAR;
    garantir(ctx, 13 + 26);
    rotulo(ctx, `${f.codigo} - ${f.nome ?? "sem nome no catalogo"}`);
    const larguraPilula = pilula(ctx, ctx.page, v.rotulo, MARGEM_X, ctx.y, v.estado, 7.5, 190);
    // A frase do veredito ao lado da pilula, quando couber; senao, embaixo.
    const sobra = LARGURA_UTIL - larguraPilula - 8;
    const porque = sanitizar(f.porque);
    if (ctx.fonte.widthOfTextAtSize(porque, 8) <= sobra) {
      ctx.page.drawText(porque, {
        x: MARGEM_X + larguraPilula + 8, y: ctx.y, size: 8, font: ctx.fonte, color: TXT_CORPO,
      });
      ctx.y -= 16;
    } else {
      ctx.y -= 16;
      paragrafo(ctx, porque, 8);
    }

    const fatos: string[] = [`Itens desta licitacao na familia: ${f.itens}`];
    fatos.push(
      f.cadastrada
        ? `Cadastro: ${f.statusCadastro ?? "-"}${f.statusFluxoCrc ? ` (fluxo ${f.statusFluxoCrc})` : ""}`
        : "Cadastro: NAO temos CRC nesta familia",
    );
    if (f.validadeFim) {
      const folga =
        f.diasDeFolga == null
          ? ""
          : f.diasDeFolga < 0
            ? ` - VENCIDO ${Math.abs(f.diasDeFolga)} dias antes da licitacao`
            : ` (${f.diasDeFolga} dias de folga)`;
      fatos.push(`Validade do CRC: ${f.validadeFim.toLocaleDateString("pt-BR")}${folga}`);
    }
    fatos.push(
      f.provasConfirmadas > 0
        ? `Provas confirmadas no acervo: ${f.provasConfirmadas}`
        : f.indicios > 0
          ? `Indicios no acervo: ${f.indicios}${f.melhorVeredito ? ` (melhor: ${f.melhorVeredito})` : ""} - sem revisao humana`
          : f.avaliada
            ? "Acervo lido contra esta familia: nada a sustenta"
            : "Acervo NUNCA consultado sobre esta familia",
    );
    bullets(ctx, fatos, 8);

    if (f.escopo) { rotulo(ctx, "Escopo oficial da Petrobras"); paragrafo(ctx, f.escopo, 8); }
    if (f.justificativa) { rotulo(ctx, "Por que o acervo sustenta"); paragrafo(ctx, f.justificativa, 8); }
  }
}

export async function gerarBriefingPdf(
  meta: BriefingMeta,
  a: AnaliseRow,
  reqs: RequisitoBriefing[],
  /**
   * OBRIGATÓRIO, aceitando `null` explícito — nunca omissão, e SEM default.
   *
   * Um default aqui derrotaria o propósito inteiro: o chamador poderia continuar
   * omitindo e a seção sumiria do PDF sem nada acusar — que é exatamente como
   * `fonteTexto` se perdeu. Sem default, o compilador obriga cada chamador a
   * DECIDIR, e a decisão fica escrita no código. `reqs` perdeu o default junto,
   * porque um parâmetro opcional ANTES de um obrigatório é sintaxe inválida —
   * e, na prática, os dois chamadores já passavam `reqs`.
   */
  habilitacao: CondicaoDeParticipar | null,
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Briefing ${meta.numero} - Proponente`);
  doc.setSubject(`Briefing para elaboração de proposta - ${meta.objeto ?? ""}`.trim());
  doc.setProducer("Petro Radar");
  doc.setCreator("Petro Radar - Petro Radar");

  const fonte = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logoCapa = await doc.embedPng(LOGO_PROPONENTE_BASE64);
  const logoHeader = await doc.embedPng(LOGO_MARCA_BASE64);

  const ctx: Ctx = {
    doc,
    page: null as unknown as PDFPage,
    fonte, bold, logoCapa, logoHeader,
    y: 0,
    numero: meta.numero,
    empresa: meta.empresa ?? "",
    paginasCapa: new Set(),
  };

  const ck = ckObj(a);

  // ── CAPA ───────────────────────────────────────────────────────────────────
  desenharCapa(ctx, meta, a, ck);

  // ── CONTEÚDO ───────────────────────────────────────────────────────────────
  novaPagina(ctx);

  // Lead: resumo executivo (não numerado)
  if (s(a.resumo)) resumoExecutivo(ctx, s(a.resumo));

  // Habilitação por família — antes das seções numeradas. Ver habilitacaoFamilias().
  if (habilitacao) habilitacaoFamilias(ctx, habilitacao);

  // 01 — Identificação
  secao(ctx, 1, "Identificacao");
  tabelaInfo(ctx, [
    ["Numero", s(meta.numero)],
    ["Cliente", s(ck.cliente) || s(meta.empresa)],
    ["Categoria", s(ck.categoria)],
    ["Tipo de proposta", s(ck.tipo_proposta)],
    ["Tipo de servico", s(ck.tipo_servico)],
    ["Solicitante", s(ck.solicitante)],
    ["Setor", s(ck.setor)],
    ["Data de publicacao", s(ck.data_publicacao)],
    ["Limite da proposta", s(ck.data_limite_proposta)],
    ["Limite de esclarecimentos", s(ck.data_limite_esclarecimentos)],
    ["Envio comercial", s(ck.meio_envio_comercial)],
    ["Envio tecnica", s(ck.meio_envio_tecnica)],
  ]);

  // 02 — Objeto e escopo
  secao(ctx, 2, "Objeto e Escopo");
  const objetoTxt = s(a.objetoDetalhado) || s(meta.objeto);
  if (objetoTxt) paragrafo(ctx, objetoTxt);
  if (s(ck.escopo_resumido)) { rotulo(ctx, "Escopo resumido"); paragrafo(ctx, s(ck.escopo_resumido)); }
  if (s(ck.exclusoes_escopo)) { rotulo(ctx, "Exclusoes do escopo"); paragrafo(ctx, s(ck.exclusoes_escopo)); }
  if (!objetoTxt && !s(ck.escopo_resumido)) paragrafo(ctx, SEM_DADO, 8.5);

  // 03 — Local e logística
  secao(ctx, 3, "Local e Logistica");
  const logistica: Array<[string, string]> = [
    ["Local do servico", s(ck.local_servico)],
    ["Filial mais proxima", s(ck.filial_proxima)],
    ["Remoto / Presencial", s(ck.remoto_presencial)],
    ["Sindicatos", s(ck.sindicatos)],
  ];
  if (logistica.some(([, v]) => v)) tabelaInfo(ctx, logistica);
  else paragrafo(ctx, SEM_DADO, 8.5);

  // 04 — Requisitos técnicos e recursos
  secao(ctx, 4, "Requisitos Tecnicos e Recursos");
  const reqTec = arrStr(a.requisitos);
  const sw = arrStr(ck.softwares);
  const hw = arrStr(ck.hardwares);
  if (reqTec.length) bullets(ctx, reqTec);
  if (sw.length) { rotulo(ctx, "Softwares exigidos"); bullets(ctx, sw); }
  if (hw.length) { rotulo(ctx, "Hardwares exigidos"); bullets(ctx, hw); }
  if (!reqTec.length && !sw.length && !hw.length) paragrafo(ctx, SEM_DADO, 8.5);

  // 05 — Habilitação
  secao(ctx, 5, "Habilitacao e Requisitos Legais");
  const crit = arrStr(a.criteriosHabilitacao);
  if (crit.length) bullets(ctx, crit);
  if (reqs.length) {
    rotulo(ctx, "Requisitos rastreaveis extraidos do edital");
    tabelaDados(
      ctx,
      ["Codigo", "Requisito", "Obrig.", "Conf."],
      reqs.slice(0, 40).map((r) => [
        s(r.codigo),
        s(r.descricao),
        r.obrigatorio === false ? "Nao" : "Sim",
        r.confianca != null ? `${Math.round(r.confianca * 100)}%` : "-",
      ]),
      [0.24, 0.53, 0.11, 0.12], // código precisa de folga: CRC_99000001, INDICES_FINANCEIROS
    );
  }
  const hab: Array<[string, string]> = [
    ["Requisitos legais", s(ck.requisitos_legais)],
    ["Documentos de habilitacao", s(ck.docs_habilitacao)],
    ["Seguros", s(ck.seguros)],
    ["Garantias / retencoes", s(ck.garantias_retencoes)],
  ];
  if (hab.some(([, v]) => v)) tabelaInfo(ctx, hab);
  if (!crit.length && !reqs.length && !hab.some(([, v]) => v)) paragrafo(ctx, SEM_DADO, 8.5);

  // 06 — Critério de julgamento
  secao(ctx, 6, "Criterio de Julgamento");
  if (s(a.criteriosJulgamento)) paragrafo(ctx, s(a.criteriosJulgamento));
  else paragrafo(ctx, SEM_DADO, 8.5);

  // 07 — Condições comerciais e contrato
  secao(ctx, 7, "Condicoes Comerciais e Contrato");
  const comercial: Array<[string, string]> = [
    ["Valor estimado", s(a.valorEstimado)],
    ["Duracao do contrato", s(ck.duracao_contrato)],
    ["Prazo de mobilizacao", s(ck.prazo_mobilizacao)],
    ["Tipo de mao de obra", s(ck.tipo_mao_obra)],
    ["Permite subcontratacao", s(ck.permite_subcontratacao)],
    ["Recursos previstos", s(ck.recursos_previstos)],
  ];
  if (comercial.some(([, v]) => v)) tabelaInfo(ctx, comercial);
  else paragrafo(ctx, SEM_DADO, 8.5);

  // 08 — Prazos
  const prazos = arrStr(a.prazos);
  if (prazos.length) { secao(ctx, 8, "Prazos Importantes"); bullets(ctx, prazos); }

  // 09 — Riscos
  const riscos = Array.isArray(a.riscos)
    ? (a.riscos as Array<{ descricao?: unknown; classificacao?: unknown }>)
    : [];
  if (riscos.length) {
    secao(ctx, 9, "Analise de Riscos");
    tabelaDados(
      ctx,
      ["Risco identificado", "Classificacao"],
      riscos.slice(0, 20).map((r) => [s(r.descricao), s(r.classificacao) || "MEDIO"]),
      [0.8, 0.2],
      estadoDoRisco,
    );
  }

  // 10 — Equipe
  const equipe = Array.isArray(ck.equipe)
    ? (ck.equipe as Array<{ descricao?: unknown; quantidade?: unknown }>)
    : [];
  if (equipe.length) {
    secao(ctx, 10, "Equipe Prevista");
    tabelaDados(
      ctx,
      ["Funcao / descricao", "Qtd"],
      equipe.slice(0, 40).map((m) => [s(m.descricao), s(m.quantidade)]),
      [0.86, 0.14],
    );
  }

  // 11 — Informações complementares
  const infos = arrStr(ck.info_complementares);
  if (infos.length) { secao(ctx, 11, "Informacoes Complementares"); bullets(ctx, infos); }

  // 12 — Recomendação
  secao(ctx, 12, "Recomendacao e Proximos Passos");
  if (s(a.recomendacao)) paragrafo(ctx, s(a.recomendacao));
  else paragrafo(ctx, "Sem recomendacao registrada na analise.", 8.5);
  paragrafo(ctx, "As secoes sem dados dependem de anexos ainda nao processados ou de esclarecimento com o cliente. Este briefing foi gerado por IA a partir dos documentos anexados a licitacao e nao substitui a leitura do edital.", 8);

  desenharRodapes(ctx);
  const bytes = await doc.save();
  return Buffer.from(bytes);
}
