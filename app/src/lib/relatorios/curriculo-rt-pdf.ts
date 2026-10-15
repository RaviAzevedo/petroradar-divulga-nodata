/**
 * Relatório "Currículo técnico do RT" em PDF (padrão Proponente) via pdf-lib — C1.
 *
 * O anexo que acompanha o atestado: a pessoa (CREA, formação, situação e as
 * três contagens) e a hierarquia obra → documento → atividade. Trabalha PURO
 * sobre o snapshot
 * `DadosCurriculoRt` coletado por `curriculo-rt.ts` — nenhum acesso a DB aqui.
 *
 * `Ctx`/`texto`/`novaLinha`/`garantePagina`/`secao` são a cópia dos helpers
 * privados de `executivo-pdf.ts`. Única diferença do original: `texto`
 * passa tudo por `sanitizarPdf`, porque a Helvetica só codifica WinAnsi e "→"
 * viraria "?" — sanitizar DENTRO de `texto` é o que garante que nenhum texto
 * desenhado escapa da regra. `sanitizarPdf` e `quebrarLinhas` vêm de
 * `pdf-texto.ts`, que já existe (onda 2): não se duplica (§6.4).
 *
 * Sem anotação de link no PDF (sem precedente; o XLSX tem o hyperlink). Falha
 * aqui SOBE: quem chama não faz fallback para XLSX (§1e da onda 2).
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { PAPEL_PROFISSIONAL_LABELS } from "@/lib/conformidade/profissionais/validations";
import { corPdfLaranja, corPdfPreto, corPdfCinza, corPdfRodape } from "./estilo-proponente";
import { quebrarLinhas, sanitizarPdf } from "./pdf-texto";
import {
  NOTA_QUANTIDADE_ART,
  formatarPeriodo,
  rotuloCliente,
  textoCrea,
  textoIgnorados,
  type DadosCurriculoRt,
} from "./curriculo-rt";

const A4 = { largura: 595.28, altura: 841.89 };
const MARGEM = 48;
const LARGURA_UTIL = A4.largura - 2 * MARGEM;
/** Recuo das linhas de atividade sob o documento (item 4 do §5.10). */
const RECUO = 14;

interface Ctx {
  page:  PDFPage;
  doc:   PDFDocument;
  fonte: PDFFont;
  bold:  PDFFont;
  y:     number;
}

function texto(ctx: Ctx, s: string, opts: { x?: number; size?: number; bold?: boolean; cor?: { r: number; g: number; b: number } } = {}) {
  const x = opts.x ?? MARGEM;
  const size = opts.size ?? 10;
  const fonte = opts.bold ? ctx.bold : ctx.fonte;
  const c = opts.cor ?? corPdfPreto;
  ctx.page.drawText(sanitizarPdf(s), { x, y: ctx.y, size, font: fonte, color: rgb(c.r, c.g, c.b) });
}

function novaLinha(ctx: Ctx, delta = 16) {
  ctx.y -= delta;
}

function garantePagina(ctx: Ctx) {
  if (ctx.y < MARGEM + 40) {
    ctx.page = ctx.doc.addPage([A4.largura, A4.altura]);
    ctx.y = A4.altura - MARGEM;
  }
}

function secao(ctx: Ctx, titulo: string) {
  garantePagina(ctx);
  novaLinha(ctx, 24);
  ctx.page.drawRectangle({
    x: MARGEM, y: ctx.y - 4, width: A4.largura - 2 * MARGEM, height: 18,
    color: rgb(corPdfPreto.r, corPdfPreto.g, corPdfPreto.b),
  });
  texto(ctx, titulo.toUpperCase(), { x: MARGEM + 6, size: 10, bold: true, cor: { r: 1, g: 1, b: 1 } });
  novaLinha(ctx, 22);
}

// ── Helpers deste relatório ──────────────────────────────────────────────────

/** Corta `s` (já sanitizado para medir certo) para caber em `maxWidth`, com "...". */
function truncar(font: PDFFont, s: string, size: number, maxWidth: number): string {
  const limpo = sanitizarPdf(s);
  if (font.widthOfTextAtSize(limpo, size) <= maxWidth) return limpo;
  let fim = limpo.length;
  while (fim > 0 && font.widthOfTextAtSize(`${limpo.slice(0, fim)}...`, size) > maxWidth) fim--;
  return `${limpo.slice(0, fim)}...`;
}

/**
 * Linha rótulo: valor (duas colunas). O rótulo é cortado para caber na sua
 * coluna (não invade o valor); o valor quebra em quantas linhas precisar —
 * nome de formação longo não pode ser cortado.
 */
function linhaKpi(ctx: Ctx, rotulo: string, valor: string) {
  const xValor = A4.largura / 2;
  const linhas = quebrarLinhas(ctx.bold, valor, 10, A4.largura - MARGEM - xValor);
  garantePagina(ctx);
  texto(ctx, truncar(ctx.fonte, rotulo, 9, xValor - MARGEM - 8), { size: 9, cor: corPdfCinza });
  linhas.forEach((linha, i) => {
    if (i > 0) { novaLinha(ctx, 13); garantePagina(ctx); }
    texto(ctx, linha, { x: xValor, size: 10, bold: true });
  });
  novaLinha(ctx, 15);
}

/** Parágrafo pequeno em cinza, quebrado na largura útil (as notas fixas). */
function paragrafo(ctx: Ctx, s: string, size = 8) {
  for (const linha of quebrarLinhas(ctx.fonte, s, size, LARGURA_UTIL)) {
    garantePagina(ctx);
    texto(ctx, linha, { size, cor: corPdfCinza });
    novaLinha(ctx, size + 3);
  }
}

/**
 * Faixa laranja de 8 px no topo + rodapé ("Gerado em … · Petro Radar") em TODA página — desenhados no fim, sobre `doc.getPages()`, para o
 * `garantePagina` copiado não precisar saber de rodapé. O conteúdo nunca desce
 * abaixo de MARGEM + 40 (regra do `garantePagina`), então não há sobreposição.
 */
function decorarPaginas(doc: PDFDocument, fonte: PDFFont, dados: DadosCurriculoRt) {
  const paginas = doc.getPages();
  const geradoEm = `Gerado em ${new Date(dados.geradoEm).toLocaleString("pt-BR")} · Petro Radar`;
  const cor = rgb(corPdfRodape.r, corPdfRodape.g, corPdfRodape.b);
  paginas.forEach((page, i) => {
    page.drawRectangle({
      x: 0, y: A4.altura - 8, width: A4.largura, height: 8,
      color: rgb(corPdfLaranja.r, corPdfLaranja.g, corPdfLaranja.b),
    });
    page.drawText(sanitizarPdf(`${geradoEm} · página ${i + 1}/${paginas.length}`), { x: MARGEM, y: 22, size: 8, font: fonte, color: cor });
  });
}

// ── Geração ──────────────────────────────────────────────────────────────────

/**
 * Gera o PDF do currículo. Retorna Buffer pronto para download/anexo. Lança em
 * qualquer falha — sem fallback (§1e da onda 2).
 */
export async function gerarCurriculoRtPdf(dados: DadosCurriculoRt): Promise<Buffer> {
  const { curriculo } = dados;
  const { profissional, contagens, ignorados } = curriculo;

  const doc = await PDFDocument.create();
  doc.setTitle(`Currículo técnico — ${profissional.nome}`);
  doc.setProducer("Petro Radar");

  const fonte = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([A4.largura, A4.altura]);

  const ctx: Ctx = { page, doc, fonte, bold, y: A4.altura - MARGEM };

  // Cabeçalho (a faixa laranja entra em `decorarPaginas`). O título QUEBRA em
  // até 2 linhas em vez de cortar: é o NOME da pessoa, e nome composto não cabe
  // em 18 pt numa linha só. Só a 2ª linha, se ainda sobrar texto, leva "...".
  let linhasTitulo = quebrarLinhas(bold, `Currículo técnico — ${profissional.nome}`, 18, LARGURA_UTIL);
  if (linhasTitulo.length > 2) {
    linhasTitulo = linhasTitulo.slice(0, 2);
    linhasTitulo[1] = truncar(bold, `${linhasTitulo[1]} ...`, 18, LARGURA_UTIL);
  }
  linhasTitulo.forEach((linha, i) => {
    if (i > 0) novaLinha(ctx, 20);
    texto(ctx, linha, { size: 18, bold: true, cor: corPdfLaranja });
  });
  novaLinha(ctx, 16);
  texto(ctx, "Petro Radar", { size: 9, cor: corPdfCinza });
  novaLinha(ctx, 4);

  // ── Profissional ───────────────────────────────────────────────────────
  secao(ctx, "Profissional");
  linhaKpi(ctx, "CREA", textoCrea(profissional));
  linhaKpi(ctx, "Formação", profissional.formacao ?? "não informada");
  linhaKpi(ctx, "Situação", profissional.ativo ? "Ativo" : "Inativo");
  linhaKpi(ctx, "Obras", String(contagens.operacoes));
  linhaKpi(ctx, "Documentos", String(contagens.documentos));
  linhaKpi(ctx, "Atividades de ART", String(contagens.atividades));
  // Q4: o que ficou de fora aparece com o mesmo destaque do que entrou.
  linhaKpi(ctx, "Fora do currículo", textoIgnorados(ignorados));

  // ── Obras ──────────────────────────────────────────────────────────────
  if (curriculo.operacoes.length === 0) {
    secao(ctx, "Obras");
    texto(ctx, "Nenhum documento deste profissional está ligado a uma operação.", { size: 9, cor: corPdfCinza });
    novaLinha(ctx, 14);
  }

  for (const operacao of curriculo.operacoes) {
    const periodo = formatarPeriodo(operacao.periodoInicio, operacao.periodoFim) ?? "período não informado";
    const cabecalho = `${operacao.codigo} · ${rotuloCliente(operacao.clienteNome, operacao.clienteGrupo)} · ${periodo}`;
    // `secao` desenha em MAIÚSCULAS (~18% mais largas na Helvetica-Bold): o
    // corte tem de medir o que SERÁ desenhado, senão um cliente longo estoura a
    // faixa preta sem "..." (erro cometido e corrigido na onda 2). O toUpperCase
    // de `secao` fica idempotente.
    secao(ctx, truncar(bold, cabecalho.toUpperCase(), 10, LARGURA_UTIL - 12));

    // As disciplinas DA OBRA (o que a obra declara), acima dos documentos.
    if (operacao.disciplinasDaOperacao.length > 0) {
      garantePagina(ctx);
      texto(ctx, `Disciplinas da obra: ${operacao.disciplinasDaOperacao.map((d) => d.codigo).join(" · ")}`,
        { size: 8, cor: corPdfCinza });
      novaLinha(ctx, 12);
    }

    for (const documento of operacao.documentos) {
      garantePagina(ctx); // item 6 do §5.10: antes de CADA bloco de documento
      const partes = [
        documento.titulo,
        documento.tipoDocumento ?? "sem tipo",
        PAPEL_PROFISSIONAL_LABELS[documento.papelProfissional],
      ];
      if (documento.numeroArt) partes.push(`ART ${documento.numeroArt}`);
      if (documento.disciplina) partes.push(documento.disciplina.codigo);
      texto(ctx, truncar(bold, partes.join(" · "), 9, LARGURA_UTIL), { size: 9, bold: true });
      novaLinha(ctx, 12);

      for (const atividade of documento.atividades) {
        garantePagina(ctx);
        const quantidade = atividade.quantidadeTexto ? ` · ${atividade.quantidadeTexto}` : "";
        texto(ctx, truncar(fonte, `— ${atividade.atividade}${quantidade}`, 8, LARGURA_UTIL - RECUO),
          { x: MARGEM + RECUO, size: 8 });
        novaLinha(ctx, 11);
      }
      novaLinha(ctx, 4);
    }
  }

  novaLinha(ctx, 4);
  paragrafo(ctx, NOTA_QUANTIDADE_ART);

  decorarPaginas(doc, fonte, dados);

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
