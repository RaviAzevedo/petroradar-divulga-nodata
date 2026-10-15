/**
 * GET /api/licitacoes/export/xlsx — a planilha do Explorar.
 *
 * Substitui o antigo botão CSV: o analista abre no Excel e já filtra/ordena, sem
 * o assistente de importação e sem o problema de acento/separador que o CSV tem
 * no Excel pt-BR.
 *
 * Honra os MESMOS filtros da tela (o construtor é compartilhado com
 * `/api/licitacoes` via `@/lib/licitacoes/filtros`), então o que está na tela é o
 * que sai no arquivo. A 2ª aba registra quais filtros valiam na hora da geração —
 * sem isso, uma planilha filtrada e uma planilha inteira são indistinguíveis
 * depois de salvas no disco.
 *
 * ROTA WEB-ONLY. O nginx manda todo /api/ para o BFF; esta rota está na lista de
 * exceções (nginx/conf.d/petro-radar*.conf) porque o arquivo é gerado com ExcelJS
 * (Node). Se renomear a rota, ATUALIZE OS CONFS, senão ela cai no BFF e dá 404.
 */

import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { and, sql } from "drizzle-orm";
import { db } from "@/db";
import { licitacoes } from "@/db/schema";
import { requireVisualizar, handleApiError } from "@/lib/api/guards";
import { construirFiltrosLicitacoes } from "@/lib/licitacoes/filtros";
import { addAbaTabela } from "@/lib/relatorios/aba-helpers";
import { fonteValor } from "@/lib/relatorios/estilo-proponente";

export const dynamic = "force-dynamic";

/** Teto de linhas — o mesmo do export antigo. */
const LIMITE = 5000;

/** Colunas da planilha, na ordem. Largura calibrada para leitura sem ajuste. */
const COLUNAS = [
  { header: "Nº da licitação",  width: 18 },
  { header: "Objeto",           width: 80 },
  { header: "Empresa",          width: 30 },
  { header: "Fonte",            width: 14 },
  { header: "Status",           width: 18 },
  { header: "Sub-status",       width: 18 },
  { header: "Fase",             width: 16 },
  { header: "Modalidade",       width: 18 },
  { header: "Tipo de oportunidade", width: 20 },
  { header: "Abrangência",      width: 14 },
  { header: "Início",           width: 12 },
  { header: "Hora início",      width: 11 },
  { header: "Fim",              width: 12 },
  { header: "Hora fim",         width: 11 },
  { header: "Dias restantes",   width: 14 },
  { header: "Publicação",       width: 12 },
  { header: "Abertura",         width: 12 },
  { header: "Disputa",          width: 12 },
  { header: "Regiões",          width: 26 },
  { header: "Natureza",         width: 18 },
  { header: "Tipo de serviço",  width: 22 },
  { header: "Segmento",         width: 22 },
  { header: "Relevância",       width: 15 },
  { header: "Score",            width: 9 },
  { header: "Melhor perfil",    width: 24 },
  { header: "Perfis que casaram", width: 30 },
  { header: "Equalizada",       width: 12 },
  { header: "Pré-qualificada",  width: 15 },
  { header: "Anexos",           width: 9 },
  { header: "Circulares",       width: 11 },
  { header: "Link",             width: 46 },
];

// Índices (1-based) usados nos ajustes finos pós-montagem.
const COL_OBJETO = 2;
const COL_DATAS = [11, 13, 16, 17, 18]; // início, fim, publicação, abertura, disputa
const COL_NUMERICAS = [15, 24, 29, 30]; // dias restantes, score, anexos, circulares
const COL_LINK = COLUNAS.length;

/**
 * 'YYYY-MM-DD' -> Date (meio-dia UTC evita o recuo de 1 dia por fuso no Excel).
 *
 * Rejeita data-sentinela e data impossível. O Petronect grava `0000-00-00` quando
 * não há data — e `0000-00-00` casa com a regex de formato. Sem esta guarda,
 * `Date.UTC(0, -1, 0)` vira **30/11/1899** (o dia zero do Excel) e a coluna
 * "Disputa" apareceria assim na maioria das licitações: boa parte da
 * planilha com cara de dado corrompido. Sem data, a célula fica VAZIA.
 */
function paraData(v: string | null): Date | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const [a, m, d] = v.slice(0, 10).split("-").map(Number);
  if (a < 1990 || a > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(a, m - 1, d, 12, 0, 0));
  // Round-trip: descarta 2026-02-31 e afins, que o Date "corrige" em silêncio.
  if (dt.getUTCFullYear() !== a || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

function diasRestantes(dataFim: string | null): number | null {
  const d = paraData(dataFim);
  if (!d) return null;
  const hoje = new Date();
  const base = Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate(), 12, 0, 0);
  return Math.round((d.getTime() - base) / 86_400_000);
}

/** Rótulos dos filtros para a aba de procedência. */
const ROTULO_FILTRO: Record<string, string> = {
  search: "Busca", empresa: "Empresa", fonte: "Fonte", relevancia: "Relevância",
  natureza: "Natureza", fase: "Fase", segmento: "Segmento", score_min: "Score mínimo",
  estado: "Estado (UF)", abrangencia: "Abrangência", perfil: "Perfil de interesse",
  prazo: "Prazo", data_fim_de: "Fim (de)", data_fim_ate: "Fim (até)",
  data_pub_de: "Publicação (de)", data_pub_ate: "Publicação (até)",
  data_inicio_de: "Início (de)", data_inicio_ate: "Início (até)",
  novas: "Somente novas (24h)", com_circulares: "Somente com circulares",
};

export async function GET(request: NextRequest) {
  try {
    await requireVisualizar();
  } catch (e) {
    return handleApiError(e);
  }

  try {
    const { searchParams } = new URL(request.url);
    const conditions = construirFiltrosLicitacoes(searchParams);
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const linhasDb = await db
      .select({
        numero: licitacoes.numero,
        objeto: licitacoes.objeto,
        objetoResumido: licitacoes.objetoResumido,
        empresa: licitacoes.empresa,
        fonte: licitacoes.fonte,
        status: licitacoes.status,
        subStatus: licitacoes.subStatus,
        fase: licitacoes.fase,
        modalidade: licitacoes.modalidade,
        tipoOportunidade: licitacoes.tipoOportunidade,
        abrangencia: licitacoes.abrangencia,
        dataInicio: licitacoes.dataInicio,
        horaInicio: licitacoes.horaInicio,
        dataFim: licitacoes.dataFim,
        horaFim: licitacoes.horaFim,
        dataPublicacao: licitacoes.dataPublicacao,
        dataAbertura: licitacoes.dataAbertura,
        dataDisputa: licitacoes.dataDisputa,
        regioes: licitacoes.regioes,
        natureza: licitacoes.natureza,
        tipoServico: licitacoes.tipoServico,
        segmento: licitacoes.segmento,
        relevancia: licitacoes.relevancia,
        scoreInteresse: licitacoes.scoreInteresse,
        melhorPerfil: licitacoes.melhorPerfil,
        perfisMatch: licitacoes.perfisMatch,
        equalizada: licitacoes.equalizada,
        preQualificada: licitacoes.preQualificada,
        id: licitacoes.id,
        qtdAnexos: sql<number>`(SELECT count(*) FROM anexos a WHERE a.licitacao_id = ${licitacoes.id})`,
        qtdCirculares: sql<number>`(SELECT count(*) FROM circulares c WHERE c.licitacao_id = ${licitacoes.id})`,
      })
      .from(licitacoes)
      .where(where)
      .orderBy(sql`${licitacoes.scoreInteresse} DESC NULLS LAST`)
      .limit(LIMITE);

    const baseUrl = process.env.NEXTAUTH_URL ?? "";
    const linhas = linhasDb.map((r) => [
      r.numero ?? "",
      r.objeto || r.objetoResumido || "",
      r.empresa ?? "",
      r.fonte === "transparencia" ? "Transparência" : "Petronect",
      r.status ?? "",
      r.subStatus ?? "",
      r.fase ?? "",
      r.modalidade ?? "",
      r.tipoOportunidade ?? "",
      r.abrangencia ?? "",
      r.dataInicio ?? "",
      r.horaInicio ?? "",
      r.dataFim ?? "",
      r.horaFim ?? "",
      diasRestantes(r.dataFim),
      r.dataPublicacao ?? "",
      r.dataAbertura ?? "",
      r.dataDisputa ?? "",
      r.regioes ?? "",
      r.natureza ?? "",
      r.tipoServico ?? "",
      r.segmento ?? "",
      r.relevancia ?? "",
      r.scoreInteresse ?? null,
      r.melhorPerfil ?? "",
      r.perfisMatch ?? "",
      r.equalizada ?? "",
      r.preQualificada ?? "",
      Number(r.qtdAnexos ?? 0),
      Number(r.qtdCirculares ?? 0),
      `${baseUrl}/licitacoes/${r.id}`,
    ]);

    const geradoEm = new Date().toISOString();
    const wb = new ExcelJS.Workbook();
    wb.creator = "Petro Radar";
    wb.created = new Date();

    const truncou = linhas.length >= LIMITE;
    const ws = addAbaTabela(wb, {
      nome: "Licitações",
      titulo: "Licitações — Explorar",
      subtitulo:
        `${linhas.length.toLocaleString("pt-BR")} licitações` +
        (conditions.length > 0 ? " (filtros da tela aplicados — ver aba \"Filtros\")" : " (sem filtros)") +
        (truncou ? ` · TETO DE ${LIMITE.toLocaleString("pt-BR")} LINHAS ATINGIDO — refine os filtros` : ""),
      colunas: COLUNAS,
      linhas: linhas as (string | number | null)[][],
      geradoEm,
      destaque: true,
      vazioMsg: "Nenhuma licitação casou com os filtros aplicados.",
    });

    // ── Ajustes finos que o helper genérico não faz ────────────────────────────
    const linhaHeader = 4;            // o helper usa 1=título, 2=subtítulo, 4=header
    const primeiraLinha = linhaHeader + 1;
    const ultimaLinha = linhaHeader + linhas.length;

    // Congela cabeçalho + as duas primeiras colunas (número e objeto ficam à vista
    // ao rolar para a direita, que é onde estão as 29 colunas restantes).
    ws.views = [{ state: "frozen", xSplit: 2, ySplit: linhaHeader }];
    ws.autoFilter = {
      from: { row: linhaHeader, column: 1 },
      to:   { row: Math.max(linhaHeader, ultimaLinha), column: COLUNAS.length },
    };

    if (linhas.length > 0) {
      for (let r = primeiraLinha; r <= ultimaLinha; r++) {
        // Objeto COMPLETO: quebra de linha + topo, senão o Excel corta na largura.
        const cObj = ws.getCell(r, COL_OBJETO);
        cObj.alignment = { wrapText: true, vertical: "top" };

        // Datas viram Date de verdade — ordenar e filtrar por período no Excel só
        // funciona com data real; texto "2026-08-12" ordena como string.
        for (const col of COL_DATAS) {
          const cell = ws.getCell(r, col);
          const d = paraData(typeof cell.value === "string" ? cell.value : null);
          if (d) {
            cell.value = d;
            cell.numFmt = "dd/mm/yyyy";
          } else {
            // Sem data real, a celula fica VAZIA. As 5 colunas de data so trazem
            // ISO ou a sentinela `0000-00-00`, entao nao ha
            // formato alternativo sendo apagado aqui.
            cell.value = "";
          }
          cell.alignment = { horizontal: "center" };
        }
        for (const col of COL_NUMERICAS) {
          ws.getCell(r, col).alignment = { horizontal: "center" };
        }

        const cLink = ws.getCell(r, COL_LINK);
        const url = String(cLink.value ?? "");
        if (url.startsWith("http")) {
          cLink.value = { text: "Abrir no Petro Radar", hyperlink: url };
          cLink.font = { ...fonteValor, underline: true };
        }
      }
    }

    // ── Aba 2: procedência (o que estava filtrado) ─────────────────────────────
    const filtrosAtivos: (string | number | null)[][] = [];
    for (const [chave, rotulo] of Object.entries(ROTULO_FILTRO)) {
      const v = searchParams.get(chave);
      if (v) filtrosAtivos.push([rotulo, v]);
    }
    addAbaTabela(wb, {
      nome: "Filtros",
      titulo: "Filtros aplicados na geração",
      subtitulo: "Reproduz o recorte que estava na tela do Explorar.",
      colunas: [{ header: "Filtro", width: 30 }, { header: "Valor", width: 60 }],
      linhas: filtrosAtivos,
      geradoEm,
      vazioMsg: "Nenhum filtro — a planilha traz a base inteira.",
    });

    const buffer = await wb.xlsx.writeBuffer();
    const dataSlug = new Date().toISOString().slice(0, 10);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="petro-radar-licitacoes-${dataSlug}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return handleApiError(e, request);
  }
}
