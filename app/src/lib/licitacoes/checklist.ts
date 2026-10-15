import ExcelJS from "exceljs";

interface ChecklistData {
  numero: string;
  objeto?: string;
  empresa?: string;
  analise: {
    resumo?: string;
    objetoDetalhado?: string;
    checklist?: Record<string, unknown>;
    requisitos?: string[];
    criteriosHabilitacao?: string[];
    criteriosJulgamento?: string;
    valorEstimado?: string;
    prazos?: string[];
    riscos?: Array<{ descricao: string; classificacao: string }>;
    recomendacao?: string;
  };
}

export async function gerarChecklistXlsx(data: ChecklistData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("BRIEFING");

  const ck = (data.analise.checklist || {}) as Record<string, unknown>;
  const a = data.analise;

  // Styles
  const headerFont: Partial<ExcelJS.Font> = { bold: true, size: 9, color: { argb: "FF1D1D1B" } };
  const valueFont: Partial<ExcelJS.Font> = { size: 9, color: { argb: "FF4A4A4A" } };
  const titleFont: Partial<ExcelJS.Font> = { bold: true, size: 14, color: { argb: "FFF59C00" } };
  const sectionFont: Partial<ExcelJS.Font> = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
  const sectionFill: ExcelJS.FillPattern = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1D1D1B" } };
  const lightFill: ExcelJS.FillPattern = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF7F8FA" } };

  // Column widths
  ws.columns = Array.from({ length: 10 }, () => ({ width: 18 }));

  let row = 1;

  // Title
  ws.mergeCells(row, 1, row, 10);
  const titleCell = ws.getCell(row, 1);
  titleCell.value = "CHECK-LIST PARA ELABORACAO DE PROPOSTA";
  titleCell.font = titleFont;
  titleCell.alignment = { horizontal: "center", vertical: "middle" };
  row += 2;

  // Helper functions
  function addSection(title: string) {
    ws.mergeCells(row, 1, row, 10);
    const cell = ws.getCell(row, 1);
    cell.value = title;
    cell.font = sectionFont;
    cell.fill = sectionFill;
    cell.alignment = { vertical: "middle" };
    row++;
  }

  function addField(label: string, value: unknown, colSpan: number = 5) {
    const labelCell = ws.getCell(row, 1);
    labelCell.value = label;
    labelCell.font = headerFont;
    labelCell.fill = lightFill;

    if (colSpan === 10) {
      ws.mergeCells(row, 2, row, 10);
      ws.getCell(row, 2).value = String(value ?? "");
      ws.getCell(row, 2).font = valueFont;
    } else {
      ws.mergeCells(row, 2, row, colSpan);
      ws.getCell(row, 2).value = String(value ?? "");
      ws.getCell(row, 2).font = valueFont;
    }
    row++;
  }

  function addFieldPair(l1: string, v1: unknown, l2: string, v2: unknown) {
    ws.getCell(row, 1).value = l1;
    ws.getCell(row, 1).font = headerFont;
    ws.getCell(row, 1).fill = lightFill;
    ws.mergeCells(row, 2, row, 5);
    ws.getCell(row, 2).value = String(v1 ?? "");
    ws.getCell(row, 2).font = valueFont;

    ws.getCell(row, 6).value = l2;
    ws.getCell(row, 6).font = headerFont;
    ws.getCell(row, 6).fill = lightFill;
    ws.mergeCells(row, 7, row, 10);
    ws.getCell(row, 7).value = String(v2 ?? "");
    ws.getCell(row, 7).font = valueFont;
    row++;
  }

  // ── DADOS GERAIS ──
  addSection("DADOS GERAIS");
  addFieldPair("NUMERO", data.numero, "CATEGORIA", ck.categoria ?? "");
  addFieldPair("CLIENTE", ck.cliente ?? data.empresa ?? "", "TIPO PROPOSTA", ck.tipo_proposta ?? "");
  addFieldPair("DATA PUBLICACAO", ck.data_publicacao ?? "", "TIPO SERVICO", ck.tipo_servico ?? "");
  addFieldPair("SOLICITANTE", ck.solicitante ?? "", "SETOR", ck.setor ?? "");
  addFieldPair("DATA LIMITE PROPOSTA", ck.data_limite_proposta ?? "", "DATA LIMITE ESCLARECIMENTOS", ck.data_limite_esclarecimentos ?? "");
  addFieldPair("ENVIO COMERCIAL", ck.meio_envio_comercial ?? "", "ENVIO TECNICA", ck.meio_envio_tecnica ?? "");
  row++;

  // ── OBJETO ──
  addSection("OBJETO DO ESCOPO");
  addField("OBJETO DETALHADO", a.objetoDetalhado ?? data.objeto ?? "", 10);
  addField("ESCOPO RESUMIDO", ck.escopo_resumido ?? "", 10);
  addField("EXCLUSOES", ck.exclusoes_escopo ?? a.resumo ?? "", 10);
  row++;

  // ── LOCAL ──
  addSection("LOCAL E LOGISTICA");
  addFieldPair("LOCAL DO SERVICO", ck.local_servico ?? "", "FILIAL PROXIMA", ck.filial_proxima ?? "");
  addFieldPair("REMOTO/PRESENCIAL", ck.remoto_presencial ?? "", "SINDICATOS", ck.sindicatos ?? "");
  row++;

  // ── REQUISITOS ──
  addSection("REQUISITOS E SEGUROS");
  addField("REQUISITOS LEGAIS", ck.requisitos_legais ?? "", 10);
  addField("SEGUROS", ck.seguros ?? "", 10);
  addField("GARANTIAS/RETENCOES", ck.garantias_retencoes ?? "", 10);
  row++;

  // ── CONTRATO ──
  addSection("CONTRATO");
  addFieldPair("DURACAO", ck.duracao_contrato ?? "", "PRAZO MOBILIZACAO", ck.prazo_mobilizacao ?? "");
  addFieldPair("VALOR ESTIMADO", a.valorEstimado ?? "", "CRITERIO JULGAMENTO", a.criteriosJulgamento ?? "");
  addFieldPair("TIPO MAO DE OBRA", ck.tipo_mao_obra ?? "", "SUBCONTRATACAO", ck.permite_subcontratacao ?? "");
  addField("RECURSOS PREVISTOS", ck.recursos_previstos ?? "", 10);
  addField("HABILITACAO TECNICA", ck.docs_habilitacao ?? "", 10);
  row++;

  // ── RISCOS ──
  addSection("RISCOS AVALIADOS");
  ws.getCell(row, 1).value = "DESCRICAO";
  ws.getCell(row, 1).font = headerFont;
  ws.getCell(row, 1).fill = lightFill;
  ws.mergeCells(row, 1, row, 8);
  ws.getCell(row, 9).value = "CLASSIFICACAO";
  ws.getCell(row, 9).font = headerFont;
  ws.getCell(row, 9).fill = lightFill;
  ws.mergeCells(row, 9, row, 10);
  row++;

  const riscos = (a.riscos || []) as Array<{ descricao: string; classificacao: string }>;
  for (const risco of riscos.slice(0, 6)) {
    ws.mergeCells(row, 1, row, 8);
    ws.getCell(row, 1).value = risco.descricao ?? String(risco);
    ws.getCell(row, 1).font = valueFont;
    ws.mergeCells(row, 9, row, 10);
    const classif = risco.classificacao ?? "MEDIO";
    ws.getCell(row, 9).value = classif;
    ws.getCell(row, 9).font = {
      bold: true, size: 9,
      color: { argb: classif === "ALTO" ? "FFD92D20" : classif === "MEDIO" ? "FFD97706" : "FF059669" }
    };
    row++;
  }
  row++;

  // ── EQUIPE ──
  const equipe = (ck.equipe ?? []) as Array<{ descricao: string; quantidade: number }>;
  if (equipe.length > 0) {
    addSection("EQUIPE PREVISTA");
    ws.getCell(row, 1).value = "DESCRICAO";
    ws.getCell(row, 1).font = headerFont;
    ws.getCell(row, 1).fill = lightFill;
    ws.mergeCells(row, 1, row, 8);
    ws.getCell(row, 9).value = "QTD";
    ws.getCell(row, 9).font = headerFont;
    ws.getCell(row, 9).fill = lightFill;
    ws.mergeCells(row, 9, row, 10);
    row++;
    for (const m of equipe.slice(0, 25)) {
      ws.mergeCells(row, 1, row, 8);
      ws.getCell(row, 1).value = m.descricao ?? String(m);
      ws.getCell(row, 1).font = valueFont;
      ws.mergeCells(row, 9, row, 10);
      ws.getCell(row, 9).value = m.quantidade ?? "";
      ws.getCell(row, 9).font = valueFont;
      ws.getCell(row, 9).alignment = { horizontal: "center" };
      row++;
    }
    row++;
  }

  // ── SOFTWARE/HARDWARE ──
  const softwares = (ck.softwares ?? []) as string[];
  const hardwares = (ck.hardwares ?? []) as string[];
  if (softwares.length > 0 || hardwares.length > 0) {
    addSection("EXIGENCIAS DE SOFTWARES / HARDWARES");
    ws.getCell(row, 1).value = "SOFTWARES";
    ws.getCell(row, 1).font = headerFont;
    ws.getCell(row, 1).fill = lightFill;
    ws.mergeCells(row, 1, row, 5);
    ws.getCell(row, 6).value = "HARDWARES";
    ws.getCell(row, 6).font = headerFont;
    ws.getCell(row, 6).fill = lightFill;
    ws.mergeCells(row, 6, row, 10);
    row++;
    const maxLen = Math.max(softwares.length, hardwares.length);
    for (let i = 0; i < Math.min(maxLen, 8); i++) {
      ws.mergeCells(row, 1, row, 5);
      ws.getCell(row, 1).value = softwares[i] ?? "";
      ws.getCell(row, 1).font = valueFont;
      ws.mergeCells(row, 6, row, 10);
      ws.getCell(row, 6).value = hardwares[i] ?? "";
      ws.getCell(row, 6).font = valueFont;
      row++;
    }
    row++;
  }

  // ── INFO COMPLEMENTARES ──
  const infos = (ck.info_complementares ?? []) as string[];
  if (infos.length > 0) {
    addSection("INFORMACOES COMPLEMENTARES");
    for (const info of infos.slice(0, 10)) {
      ws.mergeCells(row, 1, row, 10);
      ws.getCell(row, 1).value = info;
      ws.getCell(row, 1).font = valueFont;
      row++;
    }
    row++;
  }

  // ── RECOMENDACAO ──
  addSection("RECOMENDACAO DA IA");
  ws.mergeCells(row, 1, row, 10);
  ws.getCell(row, 1).value = a.recomendacao ?? "";
  ws.getCell(row, 1).font = { bold: true, size: 11, color: { argb: "FF1D1D1B" } };
  ws.getCell(row, 1).alignment = { wrapText: true };
  row += 2;

  // Footer
  ws.mergeCells(row, 1, row, 10);
  ws.getCell(row, 1).value = `Gerado automaticamente pelo Petro Radar | ${new Date().toLocaleString("pt-BR")}`;
  ws.getCell(row, 1).font = { size: 8, italic: true, color: { argb: "FF98A2B3" } };

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
