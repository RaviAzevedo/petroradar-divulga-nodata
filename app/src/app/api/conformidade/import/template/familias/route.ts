export const runtime = "nodejs";

/**
 * GET /api/conformidade/import/template/familias
 *
 * Retorna o template XLSX que o SGI deve preencher e fazer upload em
 * /api/conformidade/import/familias. Estrutura: 1 família por linha, cabeçalho na linha 1.
 *
 * Auth: SGI/LIDER/ADMIN.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { podeImportarConformidade } from "@/lib/permissions";
import ExcelJS from "exceljs";

const COLUNAS: Array<{
  key: string;
  label: string;
  largura: number;
  obrigatorio?: boolean;
  exemplo?: string;
  comentario?: string;
}> = [
  { key: "codigoCrc",         label: "codigoCrc",         largura: 14, obrigatorio: true,  exemplo: "G02.01.05" },
  { key: "nome",              label: "nome",              largura: 40, obrigatorio: true,  exemplo: "Bombas centrífugas" },
  { key: "descricao",         label: "descricao",         largura: 50, exemplo: "Descrição livre" },
  { key: "segmentoPetrobras", label: "segmentoPetrobras", largura: 18, exemplo: "CRITICA",
    comentario: "YELLOW_PAGES | OPERACIONAL | CRITICA | ESTRATEGICA" },
  { key: "statusFluxoCrc",    label: "statusFluxoCrc",    largura: 14, exemplo: "A",
    comentario: "D=Declaração | Q=Qualificado | A=Aprovado | X=Cancelado" },
  { key: "validadeFim",       label: "validadeFim",       largura: 14, exemplo: "2027-03-15",
    comentario: "Data ISO YYYY-MM-DD ou DD/MM/YYYY" },
  { key: "crit_juridico",     label: "crit_juridico",     largura: 12, exemplo: "A",
    comentario: "A=Aprovado | Q=Qualificado | D=Em Avaliação | R=Rejeitado | X=Cancelado" },
  { key: "crit_economico",    label: "crit_economico",    largura: 12, exemplo: "A" },
  { key: "crit_tecnico",      label: "crit_tecnico",      largura: 12, exemplo: "A" },
  { key: "crit_tecnico_sms",  label: "crit_tecnico_sms",  largura: 14, exemplo: "A" },
  { key: "crit_lfo",          label: "crit_lfo",          largura: 10, exemplo: "A" },
  { key: "crit_revendedor",   label: "crit_revendedor",   largura: 14, exemplo: "" },
  { key: "crit_integridade",  label: "crit_integridade",  largura: 14, exemplo: "A" },
  { key: "tags",              label: "tags",              largura: 24, exemplo: "petroquimica;onshore" },
  { key: "observacoes",       label: "observacoes",       largura: 40, exemplo: "" },
];

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  }
  if (!podeImportarConformidade(session.user.role)) {
    return NextResponse.json({ error: "Permissão negada" }, { status: 403 });
  }

  const wb = new ExcelJS.Workbook();
  wb.creator  = "Petro Radar — Conformidade";
  wb.created  = new Date();

  // ── Sheet principal: cabeçalho + linha de exemplo ──
  const ws = wb.addWorksheet("Familias");

  ws.columns = COLUNAS.map((c) => ({ header: c.label, key: c.key, width: c.largura }));

  // Estilo cabeçalho
  const header = ws.getRow(1);
  header.font   = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
  header.fill   = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1D1D1B" } };
  header.height = 22;
  header.alignment = { vertical: "middle", horizontal: "left" };

  // Marca obrigatórios em laranja
  COLUNAS.forEach((c, i) => {
    if (c.obrigatorio) {
      const cell = header.getCell(i + 1);
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF59C00" } };
    }
    if (c.comentario) {
      header.getCell(i + 1).note = {
        texts:    [{ text: c.comentario }],
        margins:  { insetmode: "auto" },
        editAs:   "twoCells",
      };
    }
  });

  // Linha de exemplo (linha 2)
  const exemplo = ws.addRow(COLUNAS.map((c) => c.exemplo ?? ""));
  exemplo.font  = { italic: true, color: { argb: "FF94A3B8" } };

  ws.views = [{ state: "frozen", ySplit: 1 }];

  // ── Sheet de instruções ──
  const wsInst = wb.addWorksheet("Instruções");
  wsInst.columns = [{ header: "Campo", key: "campo", width: 22 }, { header: "Descrição", key: "desc", width: 90 }];
  wsInst.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  wsInst.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1D1D1B" } };

  wsInst.addRows([
    { campo: "codigoCrc",         desc: "Código oficial Petrobras (ex.: G02.01.05). Obrigatório. Único. Aceita pontuação (será normalizada)." },
    { campo: "nome",              desc: "Nome da família. Obrigatório. Ex.: 'Bombas centrífugas'." },
    { campo: "descricao",         desc: "Descrição livre do escopo coberto. Opcional." },
    { campo: "segmentoPetrobras", desc: "Classificação Petrobras: YELLOW_PAGES, OPERACIONAL, CRITICA, ESTRATEGICA. Aceita também 'Páginas Amarelas', 'Crítica' etc." },
    { campo: "statusFluxoCrc",    desc: "Status oficial Petrobras: D=Declaração de Interesse, Q=Tecnicamente Qualificado, A=Aprovado, X=Cancelado." },
    { campo: "validadeFim",       desc: "Data de vencimento do CRC nesta família. Aceita YYYY-MM-DD ou DD/MM/YYYY. Sistema calcula 'proximaRenovacaoEm' automaticamente (60 dias antes)." },
    { campo: "crit_*",            desc: "Status individual de cada critério Petrobras. Use letras A/Q/D/R/X ou nomes APROVADO/QUALIFICADO/EM_AVALIACAO/REJEITADO/CANCELADO. Critérios oficiais: Jurídico, Econômico, Técnico, Técnico-SMS, LFO (Linha de Fornecimento), Revendedor (apenas distribuidores), Integridade." },
    { campo: "tags",              desc: "Lista separada por ; , ou |. Ex.: 'petroquimica;onshore;manutencao'." },
    { campo: "observacoes",       desc: "Texto livre para anotações internas SGI." },
  ]);

  // ── Buffer ──
  const buffer = await wb.xlsx.writeBuffer();
  const filename = "familias_template.xlsx";
  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type":        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control":       "no-store",
    },
  });
}
