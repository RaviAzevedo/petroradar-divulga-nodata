/**
 * Pacote de orçamento — bridge para as skills Proponente.
 *
 * Monta um ZIP com tudo que a equipe de orçamento precisa para iniciar um
 * DFP/PPU a partir de uma licitação do Radar:
 *   00_BRIEFING.md            — briefing legível (derivado de analises_ia)
 *   00_BRIEFING.json          — briefing estruturado (consumível pelas skills)
 *   00_CHECK-LIST.xlsx        — checklist pré-preenchido (exceljs, padrão Proponente)
 *   00_INDICE.txt             — índice do pacote
 *   anexos/<descricao>.<ext>  — anexos do edital (anexos.s3Key)
 *   adendos/<descricao>.<ext> — anexos de circulares ADENDO (quando há s3Key)
 *
 * Reaproveita o padrão de envelopes/[id]/zip/route.ts: JSZip + getR2ObjectBuffer.
 * Download do R2 em paralelo (allSettled) — uma falha não derruba o pacote.
 * Sem db.transaction (read-only nesta lib; a rota faz só leitura).
 */

import JSZip from "jszip";
import { getR2ObjectBuffer } from "@/lib/storage/download";
import { gerarChecklistXlsx } from "@/lib/licitacoes/checklist";
import type { CondicaoDeParticipar } from "@/lib/licitacoes/habilitacao-familias";
import {
  montarBriefingMarkdown,
  montarBriefingJson,
  type AnaliseRow,
  type BriefingMeta,
} from "@/lib/licitacoes/briefing";

/** Limite total de bytes baixados do R2 por pacote (proteção contra OOM/timeout). */
const LIMITE_BYTES_PACOTE = Number(process.env.PACOTE_LIMITE_BYTES ?? 200 * 1024 * 1024);

export interface AnexoPacote {
  descricao: string | null;
  s3Key:     string | null;
  contentType: string | null;
  tamanhoBytes: number | null;
  /** "EDITAL" para anexos da licitação; "ADENDO" para anexos de circulares. */
  origem:    "EDITAL" | "ADENDO";
}

export interface PacoteInput {
  meta:    BriefingMeta;
  analise: AnaliseRow | null;
  anexos:  AnexoPacote[];
  /** Habilitação por família CRC. `null` explícito quando não foi possível apurar. */
  habilitacao: CondicaoDeParticipar | null;
}

export interface PacoteResultado {
  buffer:    Buffer;
  filename:  string;
  incluidos: number;
  pulados:   number;
  bytesBaixados: number;
}

function sanitizeFilename(s: string): string {
  return (s || "documento").replace(/[^a-zA-Z0-9._ -]/g, "_").trim().slice(0, 120) || "documento";
}

function extDe(descricao: string | null, contentType: string | null): string {
  const fromName = descricao?.includes(".") ? descricao.split(".").pop() : null;
  if (fromName && fromName.length <= 5) return "." + fromName.toLowerCase();
  if (contentType?.includes("pdf")) return ".pdf";
  if (contentType?.includes("spreadsheet") || contentType?.includes("excel")) return ".xlsx";
  if (contentType?.includes("word")) return ".docx";
  if (contentType?.includes("zip")) return ".zip";
  return ".bin";
}

/**
 * Constrói o ZIP do pacote de orçamento. Retorna buffer + estatísticas.
 */
export async function montarPacoteOrcamento(input: PacoteInput): Promise<PacoteResultado> {
  const { meta, analise, anexos } = input;
  const zip = new JSZip();
  const indice: string[] = [
    `Pacote de Orçamento — Petro Radar`,
    `Licitação: ${meta.numero}`,
    `Cliente: ${meta.empresa ?? "—"}`,
    `Objeto: ${meta.objeto ?? "—"}`,
    `Gerado em: ${new Date().toLocaleString("pt-BR")}`,
    ``,
    `Conteúdo:`,
    `─────────────────────────────────────────────`,
  ];

  let incluidos = 0;
  let pulados = 0;
  let bytesBaixados = 0;

  // ── 1. Briefing (md + json) + checklist xlsx ────────────────────────────────
  if (analise) {
    const md = montarBriefingMarkdown(meta, analise, input.habilitacao);
    const json = montarBriefingJson(meta, analise);
    zip.file("00_BRIEFING.md", md);
    zip.file("00_BRIEFING.json", JSON.stringify(json, null, 2));
    indice.push(`  [OK]      00_BRIEFING.md / 00_BRIEFING.json (derivados da análise IA)`);
    if (analise.erroParse) {
      indice.push(`  [AVISO]   análise marcada com erro_parse — revisar briefing manualmente`);
    }

    try {
      const xlsx = await gerarChecklistXlsx({
        numero:  meta.numero,
        objeto:  meta.objeto ?? undefined,
        empresa: meta.empresa ?? undefined,
        analise: {
          resumo:               analise.resumo ?? undefined,
          objetoDetalhado:      analise.objetoDetalhado ?? undefined,
          checklist:            (analise.checklist as Record<string, unknown>) ?? undefined,
          requisitos:           (analise.requisitos as string[]) ?? undefined,
          criteriosHabilitacao: (analise.criteriosHabilitacao as string[]) ?? undefined,
          criteriosJulgamento:  analise.criteriosJulgamento ?? undefined,
          valorEstimado:        analise.valorEstimado ?? undefined,
          prazos:               (analise.prazos as string[]) ?? undefined,
          riscos:               (analise.riscos as Array<{ descricao: string; classificacao: string }>) ?? undefined,
          recomendacao:         analise.recomendacao ?? undefined,
        },
      });
      zip.file("00_CHECK-LIST.xlsx", xlsx);
      indice.push(`  [OK]      00_CHECK-LIST.xlsx (pré-preenchido)`);
    } catch (e) {
      indice.push(`  [ERRO]    falha ao gerar CHECK-LIST.xlsx (${e instanceof Error ? e.message : "?"})`);
      pulados++;
    }
  } else {
    indice.push(`  [PENDENTE] sem análise IA — briefing e checklist não gerados (rode a análise primeiro)`);
  }

  // ── 2. Anexos do edital + adendos (download paralelo, respeitando teto) ──────
  const comKey = anexos.filter((a) => !!a.s3Key);
  const semKey = anexos.filter((a) => !a.s3Key);
  for (const a of semKey) {
    indice.push(`  [PENDENTE] ${a.origem.toLowerCase()} "${a.descricao ?? "?"}" sem arquivo no storage`);
    pulados++;
  }

  // Pré-filtra pelo budget de bytes (usa tamanhoBytes quando disponível) para não
  // estourar memória: baixa em ordem até o teto.
  const selecionados: AnexoPacote[] = [];
  let acumulado = 0;
  for (const a of comKey) {
    const tam = a.tamanhoBytes ?? 0;
    if (tam > 0 && acumulado + tam > LIMITE_BYTES_PACOTE) {
      indice.push(`  [PULADO]  ${a.descricao ?? "?"} excede o teto de tamanho do pacote`);
      pulados++;
      continue;
    }
    acumulado += tam;
    selecionados.push(a);
  }

  const buffers = await Promise.allSettled(selecionados.map((a) => getR2ObjectBuffer(a.s3Key!)));
  selecionados.forEach((a, idx) => {
    const r = buffers[idx];
    const pasta = a.origem === "ADENDO" ? "adendos" : "anexos";
    if (r.status === "fulfilled") {
      const nome = `${sanitizeFilename(a.descricao ?? `${pasta}_${idx + 1}`)}${extDe(a.descricao, a.contentType)}`;
      zip.file(`${pasta}/${nome}`, r.value);
      bytesBaixados += r.value.length;
      indice.push(`  [OK]      ${pasta}/${nome}`);
      incluidos++;
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : "?";
      indice.push(`  [ERRO]    ${pasta} "${a.descricao ?? "?"}" — falha ao baixar (${msg})`);
      pulados++;
    }
  });

  indice.push(``);
  indice.push(`Resumo: ${incluidos} arquivo(s) incluído(s), ${pulados} pendente(s)/erro(s).`);
  indice.push(``);
  indice.push(`Use este pacote como fonte para a elaboração do orçamento (DFP/PPU) e do briefing/checklist da proposta.`);
  zip.file("00_INDICE.txt", indice.join("\n"));

  const out = await zip.generateAsync({ type: "uint8array" });
  const filename = `pacote-orcamento_${sanitizeFilename(meta.numero)}_${new Date().toISOString().slice(0, 10)}.zip`;

  return {
    buffer:    Buffer.from(out),
    filename,
    incluidos,
    pulados,
    bytesBaixados,
  };
}
