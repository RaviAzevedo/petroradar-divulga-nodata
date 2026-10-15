/**
 * Importação em massa de Famílias CRC via planilha XLSX.
 *
 * Fluxo:
 *   1. parsePlanilhaFamilias(buffer): valida estrutura e retorna lista parseada
 *   2. gerarDiffFamilias(linhas): compara com banco, retorna { novas, atualizadas, inalteradas, erros }
 *   3. aplicarDiffFamilias(diff, userId): faz INSERT/UPDATE em transação, registra import_job
 *
 * Convenção da planilha (1 linha por família):
 *   codigoCrc | nome | descricao | segmentoPetrobras | statusFluxoCrc |
 *   validadeFim | crit_juridico | crit_economico | crit_tecnico |
 *   crit_tecnico_sms | crit_lfo | crit_revendedor | crit_integridade |
 *   tags | observacoes
 */

import ExcelJS from "exceljs";
import { db } from "@/db";
import { familias, importJobs, type StatusFamilia, type SegmentoPetrobras, type StatusFluxoCrc, type CriterioCrc, type StatusCriterioCrc } from "@/db/schema";
import { eq, isNull, and } from "drizzle-orm";
import { normalizarCodigoCrc } from "@/lib/conformidade/familias/validations";

export interface LinhaFamiliaImport {
  codigoCrc:           string;
  nome:                string;
  descricao:           string | null;
  segmentoPetrobras:   SegmentoPetrobras | null;
  statusFluxoCrc:      StatusFluxoCrc | null;
  validadeFim:         Date | null;
  criterios:           Partial<Record<CriterioCrc, { status: StatusCriterioCrc; validadeFim: string | null }>>;
  tags:                string[] | null;
  observacoes:         string | null;
  // Linha original na planilha (pra mensagens de erro)
  linhaPlanilha:       number;
}

export interface DiffFamilias {
  novas:        LinhaFamiliaImport[];
  atualizadas:  Array<{ linha: LinhaFamiliaImport; existenteId: string; mudancas: string[] }>;
  inalteradas:  number;
  erros:        Array<{ linhaPlanilha: number; codigoCrc?: string; mensagem: string }>;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

const COLUNAS_OBRIGATORIAS = ["codigoCrc", "nome"] as const;

function parseSegmento(v: unknown): SegmentoPetrobras | null {
  const s = String(v ?? "").trim().toUpperCase().replace(/\s+/g, "_");
  if (s === "YELLOW_PAGES" || s === "OPERACIONAL" || s === "CRITICA" || s === "ESTRATEGICA") {
    return s as SegmentoPetrobras;
  }
  // aliases comuns em pt-BR
  if (s === "AMARELAS" || s === "PAGINAS_AMARELAS") return "YELLOW_PAGES";
  if (s === "OPERACIONAIS") return "OPERACIONAL";
  if (s === "CRÍTICA" || s === "CRITICAS") return "CRITICA";
  if (s === "ESTRATÉGICA" || s === "ESTRATEGICAS") return "ESTRATEGICA";
  return null;
}

function parseStatusFluxo(v: unknown): StatusFluxoCrc | null {
  const s = String(v ?? "").trim().toUpperCase();
  if (s === "D" || s === "Q" || s === "A" || s === "X") return s as StatusFluxoCrc;
  return null;
}

function parseStatusCriterio(v: unknown): StatusCriterioCrc | null {
  const s = String(v ?? "").trim().toUpperCase();
  if (s === "APROVADO" || s === "QUALIFICADO" || s === "EM_AVALIACAO" || s === "REJEITADO" || s === "CANCELADO") {
    return s as StatusCriterioCrc;
  }
  // Letras Petrobras: A=Aprovado, Q=Qualificado, D=Em Avaliação, R=Rejeitado, X=Cancelado
  if (s === "A") return "APROVADO";
  if (s === "Q") return "QUALIFICADO";
  if (s === "D") return "EM_AVALIACAO";
  if (s === "R") return "REJEITADO";
  if (s === "X") return "CANCELADO";
  return null;
}

function parseDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const s = String(v).trim();
  if (!s) return null;
  // dd/mm/yyyy
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00Z`);
  // yyyy-mm-dd
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m2) return new Date(`${s}T00:00:00Z`);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function parseTags(v: unknown): string[] | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.split(/[,;|]/).map((t) => t.trim()).filter(Boolean);
}

export async function parsePlanilhaFamilias(buffer: Buffer): Promise<{
  linhas: LinhaFamiliaImport[];
  erros:  Array<{ linhaPlanilha: number; codigoCrc?: string; mensagem: string }>;
}> {
  const wb = new ExcelJS.Workbook();
  // ExcelJS espera ArrayBuffer; copia o slice exato pra evitar mismatch ArrayBufferLike vs ArrayBuffer
  const ab = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(ab).set(buffer);
  await wb.xlsx.load(ab);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("Planilha vazia");

  // Header na linha 1
  const headerRow = ws.getRow(1);
  const headers: Record<string, number> = {};
  headerRow.eachCell((cell, col) => {
    const v = String(cell.value ?? "").trim();
    if (v) headers[v] = col;
  });

  for (const obrig of COLUNAS_OBRIGATORIAS) {
    if (!headers[obrig]) {
      throw new Error(`Coluna obrigatória "${obrig}" não encontrada no cabeçalho`);
    }
  }

  const get = (row: ExcelJS.Row, name: string): unknown => {
    const col = headers[name];
    if (!col) return null;
    const cell = row.getCell(col);
    return cell.value;
  };

  const linhas: LinhaFamiliaImport[] = [];
  const erros: Array<{ linhaPlanilha: number; codigoCrc?: string; mensagem: string }> = [];

  for (let i = 2; i <= ws.rowCount; i++) {
    const row = ws.getRow(i);
    const codigoCrcRaw = String(get(row, "codigoCrc") ?? "").trim();
    if (!codigoCrcRaw) continue; // linha vazia

    const nome = String(get(row, "nome") ?? "").trim();
    if (!nome) {
      erros.push({ linhaPlanilha: i, codigoCrc: codigoCrcRaw, mensagem: "Nome obrigatório" });
      continue;
    }

    const criterios: LinhaFamiliaImport["criterios"] = {};
    const mapaCriterios: Array<[string, CriterioCrc]> = [
      ["crit_juridico",     "JURIDICO"],
      ["crit_economico",    "ECONOMICO"],
      ["crit_tecnico",      "TECNICO"],
      ["crit_tecnico_sms",  "TECNICO_SMS"],
      ["crit_lfo",          "LFO"],
      ["crit_revendedor",   "REVENDEDOR"],
      ["crit_integridade",  "INTEGRIDADE"],
    ];
    for (const [coluna, key] of mapaCriterios) {
      const status = parseStatusCriterio(get(row, coluna));
      if (status) {
        criterios[key] = { status, validadeFim: null };
      }
    }

    linhas.push({
      codigoCrc:         codigoCrcRaw,
      nome,
      descricao:         (String(get(row, "descricao") ?? "").trim() || null),
      segmentoPetrobras: parseSegmento(get(row, "segmentoPetrobras")),
      statusFluxoCrc:    parseStatusFluxo(get(row, "statusFluxoCrc")),
      validadeFim:       parseDate(get(row, "validadeFim")),
      criterios,
      tags:              parseTags(get(row, "tags")),
      observacoes:       (String(get(row, "observacoes") ?? "").trim() || null),
      linhaPlanilha:     i,
    });
  }

  return { linhas, erros };
}

// ── Diff vs banco ────────────────────────────────────────────────────────────

export async function gerarDiffFamilias(
  linhas: LinhaFamiliaImport[],
  errosParse: Array<{ linhaPlanilha: number; codigoCrc?: string; mensagem: string }>,
): Promise<DiffFamilias> {
  const codigosNorm = linhas.map((l) => normalizarCodigoCrc(l.codigoCrc));

  // Busca todas existentes pra esses códigos
  const existentes = codigosNorm.length > 0
    ? await db
        .select({
          id:                familias.id,
          codigoNormalizado: familias.codigoNormalizado,
          nome:              familias.nome,
          descricao:         familias.descricao,
          segmentoPetrobras: familias.segmentoPetrobras,
          statusFluxoCrc:    familias.statusFluxoCrc,
          validadeFim:       familias.validadeFim,
          observacoes:       familias.observacoes,
        })
        .from(familias)
        .where(and(isNull(familias.deletadoEm)))
    : [];

  const mapaExist = new Map(existentes.map((e) => [e.codigoNormalizado, e]));

  const diff: DiffFamilias = {
    novas:       [],
    atualizadas: [],
    inalteradas: 0,
    erros:       [...errosParse],
  };

  for (const linha of linhas) {
    const norm = normalizarCodigoCrc(linha.codigoCrc);
    const exist = mapaExist.get(norm);
    if (!exist) {
      diff.novas.push(linha);
      continue;
    }

    const mudancas: string[] = [];
    if ((exist.nome ?? "") !== linha.nome) mudancas.push("nome");
    if ((exist.descricao ?? "") !== (linha.descricao ?? "")) mudancas.push("descricao");
    if ((exist.segmentoPetrobras ?? "") !== (linha.segmentoPetrobras ?? "")) mudancas.push("segmentoPetrobras");
    if ((exist.statusFluxoCrc ?? "") !== (linha.statusFluxoCrc ?? "")) mudancas.push("statusFluxoCrc");
    const validadeAtualISO = exist.validadeFim ? new Date(exist.validadeFim).toISOString().slice(0, 10) : "";
    const validadeNovaISO  = linha.validadeFim ? linha.validadeFim.toISOString().slice(0, 10) : "";
    if (validadeAtualISO !== validadeNovaISO) mudancas.push("validadeFim");
    if ((exist.observacoes ?? "") !== (linha.observacoes ?? "")) mudancas.push("observacoes");

    if (mudancas.length === 0) {
      diff.inalteradas++;
    } else {
      diff.atualizadas.push({ linha, existenteId: exist.id, mudancas });
    }
  }

  return diff;
}

// ── Apply ────────────────────────────────────────────────────────────────────

export async function aplicarDiffFamilias(
  diff: DiffFamilias,
  userId: string,
): Promise<{ jobId: string; novos: number; atualizados: number; erros: number }> {
  const [job] = await db
    .insert(importJobs)
    .values({
      fonte:         "PLANILHA",
      iniciadoPor:   userId,
      status:        "EM_ANDAMENTO",
      totalArquivos: diff.novas.length + diff.atualizadas.length,
      observacao:    "Importação de famílias CRC via planilha",
    })
    .returning({ id: importJobs.id });

  let novos = 0;
  let atualizados = 0;
  let erros = diff.erros.length;

  // INSERTs
  for (const l of diff.novas) {
    try {
      const validadeFim = l.validadeFim;
      const proximaRenovacaoEm = validadeFim
        ? new Date(validadeFim.getTime() - 60 * 24 * 60 * 60 * 1000)
        : null;

      await db.insert(familias).values({
        codigoCrc:           l.codigoCrc,
        codigoNormalizado:   normalizarCodigoCrc(l.codigoCrc),
        nome:                l.nome,
        descricao:           l.descricao,
        nivel:               "FAMILIA",
        path:                l.codigoCrc,
        cadastroCorporativo: true,
        segmentoPetrobras:   l.segmentoPetrobras ?? null,
        status:              "ATIVA" as StatusFamilia,
        statusFluxoCrc:      l.statusFluxoCrc ?? null,
        validadeFim,
        proximaRenovacaoEm,
        criterios:           Object.keys(l.criterios).length > 0 ? l.criterios : null,
        tags:                l.tags,
        observacoes:         l.observacoes,
        criadoPor:           userId,
        atualizadoPor:       userId,
      });
      novos++;
    } catch (e) {
      erros++;
      console.error(`[import-familias] Falha ao inserir ${l.codigoCrc}:`, e);
    }
  }

  // UPDATEs
  for (const u of diff.atualizadas) {
    try {
      const validadeFim = u.linha.validadeFim;
      const proximaRenovacaoEm = validadeFim
        ? new Date(validadeFim.getTime() - 60 * 24 * 60 * 60 * 1000)
        : null;

      await db
        .update(familias)
        .set({
          nome:              u.linha.nome,
          descricao:         u.linha.descricao,
          segmentoPetrobras: u.linha.segmentoPetrobras ?? null,
          statusFluxoCrc:    u.linha.statusFluxoCrc ?? null,
          validadeFim,
          proximaRenovacaoEm,
          observacoes:       u.linha.observacoes,
          atualizadoPor:     userId,
          atualizadoEm:      new Date(),
        })
        .where(eq(familias.id, u.existenteId));
      atualizados++;
    } catch (e) {
      erros++;
      console.error(`[import-familias] Falha ao atualizar ${u.linha.codigoCrc}:`, e);
    }
  }

  await db
    .update(importJobs)
    .set({
      status:       erros > 0 && novos + atualizados === 0 ? "FALHOU" : "CONCLUIDO",
      processados:  novos + atualizados,
      novos,
      atualizados,
      erros,
      finalizadoEm: new Date(),
      payload: {
        novosCodigos:       diff.novas.map((l) => l.codigoCrc),
        atualizadosCodigos: diff.atualizadas.map((u) => u.linha.codigoCrc),
        erros:              diff.erros,
      },
    })
    .where(eq(importJobs.id, job.id));

  return { jobId: job.id, novos, atualizados, erros };
}
