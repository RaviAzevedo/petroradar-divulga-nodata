/**
 * Dossiê da licitação — o entregável único da análise por IA.
 *
 * Um clique em "Gerar dossiê" produz UM zip com tudo que a equipe de proposta
 * precisa para começar a trabalhar:
 *
 *   BRIEFING_<numero>.pdf              — briefing de 12 seções, padrão visual Proponente
 *   CHECK-LIST_<numero>_Proponente.xlsx  — template OFICIAL da casa, pré-preenchido
 *   00_LEIA-ME.txt                     — índice, procedência e avisos
 *   documentos/edital/<arquivos>       — anexos originais da licitação (binários)
 *   documentos/adendos/<arquivos>      — anexos de circulares do tipo ADENDO
 *   circulares/CIRCULARES.md           — texto das circulares/esclarecimentos
 *
 * NENHUMA chamada a IA acontece aqui: esta lib é 100% determinística, sobre a
 * análise já persistida em `analises_ia` e os binários já no storage. Quem chama
 * a IA é a rota /dossie, que orquestra (baixa anexos -> analisa -> monta o zip).
 *
 * Distinção proposital em relação a pacote-orcamento.ts: aquele é a ponte para as
 * *skills* (entrega briefing em .md/.json, consumível por script). Este é a peça
 * que o humano abre — PDF e o XLSX oficial.
 *
 * O download do storage é paralelo (allSettled): a falha de um anexo não derruba
 * o dossiê, só entra como [ERRO] no LEIA-ME. Teto de bytes para não estourar
 * memória em licitação com anexo gigante.
 */

import JSZip from "jszip";
import { getR2ObjectBuffer } from "@/lib/storage/download";
import { gerarBriefingPdf, type RequisitoBriefing } from "@/lib/licitacoes/briefing-pdf";
import type { CondicaoDeParticipar } from "./habilitacao-familias";
import { preencherChecklistOficial } from "@/lib/licitacoes/checklist-oficial";
import type { AnaliseRow, BriefingMeta } from "@/lib/licitacoes/briefing";

/** Teto total de bytes baixados do storage por dossiê (proteção contra OOM/timeout). */
const LIMITE_BYTES = Number(process.env.DOSSIE_LIMITE_BYTES ?? 200 * 1024 * 1024);

export interface AnexoDossie {
  descricao: string | null;
  s3Key: string | null;
  contentType: string | null;
  tamanhoBytes: number | null;
  /** "EDITAL" = anexo da licitação; "ADENDO" = anexo de circular. */
  origem: "EDITAL" | "ADENDO";
}

export interface CircularDossie {
  tipo: string;
  autor: string | null;
  mensagem: string | null;
  dataPublicacao: Date | null;
}

export interface DossieInput {
  meta: BriefingMeta;
  analise: AnaliseRow;
  requisitos: RequisitoBriefing[];
  anexos: AnexoDossie[];
  circulares: CircularDossie[];
  /** Habilitação por família CRC. `null` explícito quando não foi possível apurar. */
  habilitacao: CondicaoDeParticipar | null;
}

export interface DossieResultado {
  buffer: Buffer;
  filename: string;
  /** Arquivos efetivamente embalados (anexos + adendos). */
  incluidos: number;
  /** Anexos que não entraram (sem binário no storage, erro de download ou teto). */
  pulados: number;
  bytesBaixados: number;
}

function sanitizeFilename(s: string): string {
  return (s || "documento").replace(/[^a-zA-Z0-9._ -]/g, "_").trim().slice(0, 120) || "documento";
}

function extDe(descricao: string | null, contentType: string | null): string {
  const doNome = descricao?.includes(".") ? descricao.split(".").pop() : null;
  if (doNome && doNome.length <= 5) return "." + doNome.toLowerCase();
  if (contentType?.includes("pdf")) return ".pdf";
  if (contentType?.includes("spreadsheet") || contentType?.includes("excel")) return ".xlsx";
  if (contentType?.includes("word")) return ".docx";
  if (contentType?.includes("zip")) return ".zip";
  return ".bin";
}

function dataBR(d: Date | null): string {
  return d ? d.toLocaleDateString("pt-BR") : "—";
}

/** Monta o ZIP do dossiê. Retorna buffer + estatísticas para a rota logar. */
export async function montarDossie(input: DossieInput): Promise<DossieResultado> {
  const { meta, analise, requisitos, anexos, circulares } = input;
  const zip = new JSZip();
  const num = sanitizeFilename(meta.numero);

  const leiaMe: string[] = [
    `DOSSIÊ DA LICITAÇÃO ${meta.numero}`,
    `${"=".repeat(60)}`,
    ``,
    `Cliente ....... ${meta.empresa ?? "—"}`,
    `Segmento ...... ${meta.segmento ?? "—"}`,
    `Objeto ........ ${meta.objeto ?? "—"}`,
    `Gerado em ..... ${new Date().toLocaleString("pt-BR")}`,
    `Modelo de IA .. ${analise.modeloUsado ?? "—"}`,
    ``,
    `CONTEÚDO`,
    `${"-".repeat(60)}`,
  ];

  let incluidos = 0;
  let pulados = 0;
  let bytesBaixados = 0;

  // ── 1. Briefing PDF ────────────────────────────────────────────────────────
  try {
    const pdf = await gerarBriefingPdf(meta, analise, requisitos, input.habilitacao);
    zip.file(`BRIEFING_${num}.pdf`, pdf);
    leiaMe.push(`  [OK]     BRIEFING_${num}.pdf`);
  } catch (e) {
    leiaMe.push(`  [ERRO]   BRIEFING_${num}.pdf — ${e instanceof Error ? e.message : "falha"}`);
    pulados++;
  }

  // ── 2. Checklist no template OFICIAL Proponente ──────────────────────────────
  try {
    const xlsx = await preencherChecklistOficial(meta, analise);
    zip.file(`CHECK-LIST_${num}_Proponente.xlsx`, xlsx);
    leiaMe.push(`  [OK]     CHECK-LIST_${num}_Proponente.xlsx (template oficial)`);
  } catch (e) {
    leiaMe.push(`  [ERRO]   CHECK-LIST — ${e instanceof Error ? e.message : "falha"}`);
    pulados++;
  }

  if (analise.erroParse) {
    leiaMe.push(``);
    leiaMe.push(`  *** ATENÇÃO: a extração da IA foi marcada com ERRO DE PARSE. ***`);
    leiaMe.push(`  *** Revise TODOS os campos do briefing e do checklist à mão. ***`);
  }

  // ── 3. Circulares e esclarecimentos (texto) ────────────────────────────────
  if (circulares.length) {
    const md: string[] = [
      `# Circulares e esclarecimentos — ${meta.numero}`,
      ``,
      `${circulares.length} circular(es) publicada(s) no Petronect até ${new Date().toLocaleDateString("pt-BR")}.`,
      ``,
    ];
    for (const ci of circulares) {
      md.push(`## ${ci.tipo} — ${dataBR(ci.dataPublicacao)}`);
      if (ci.autor) md.push(`**Autor:** ${ci.autor}`);
      md.push(``);
      md.push(ci.mensagem?.trim() || "_(sem texto)_");
      md.push(``);
      md.push(`---`);
      md.push(``);
    }
    zip.file("circulares/CIRCULARES.md", md.join("\n"));
    leiaMe.push(`  [OK]     circulares/CIRCULARES.md (${circulares.length} circular(es))`);
  }

  // ── 4. Documentos originais (anexos do edital + adendos) ───────────────────
  const comKey = anexos.filter((a) => !!a.s3Key);
  for (const a of anexos.filter((x) => !x.s3Key)) {
    leiaMe.push(`  [FALTA]  ${a.origem.toLowerCase()} "${a.descricao ?? "?"}" — sem arquivo no storage`);
    pulados++;
  }

  // Pré-filtra pelo teto de bytes: baixa em ordem até estourar o orçamento.
  const selecionados: AnexoDossie[] = [];
  let acumulado = 0;
  for (const a of comKey) {
    const tam = a.tamanhoBytes ?? 0;
    if (tam > 0 && acumulado + tam > LIMITE_BYTES) {
      leiaMe.push(`  [PULADO] ${a.descricao ?? "?"} — excede o teto de tamanho do dossiê`);
      pulados++;
      continue;
    }
    acumulado += tam;
    selecionados.push(a);
  }

  const baixados = await Promise.allSettled(selecionados.map((a) => getR2ObjectBuffer(a.s3Key!)));
  selecionados.forEach((a, i) => {
    const r = baixados[i];
    const pasta = a.origem === "ADENDO" ? "documentos/adendos" : "documentos/edital";
    if (r.status === "fulfilled") {
      const nome = `${sanitizeFilename(a.descricao ?? `documento_${i + 1}`)}${extDe(a.descricao, a.contentType)}`;
      zip.file(`${pasta}/${nome}`, r.value);
      bytesBaixados += r.value.length;
      leiaMe.push(`  [OK]     ${pasta}/${nome}`);
      incluidos++;
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : "falha";
      leiaMe.push(`  [ERRO]   ${pasta} "${a.descricao ?? "?"}" — ${msg}`);
      pulados++;
    }
  });

  // ── 5. LEIA-ME ─────────────────────────────────────────────────────────────
  leiaMe.push(``);
  leiaMe.push(`${"-".repeat(60)}`);
  leiaMe.push(`Resumo: ${incluidos} documento(s) original(is) embalado(s), ${pulados} pendência(s).`);
  leiaMe.push(``);
  leiaMe.push(`PROCEDÊNCIA E LIMITES`);
  leiaMe.push(`${"-".repeat(60)}`);
  leiaMe.push(`O briefing e o checklist foram gerados por IA (Claude) a partir do texto`);
  leiaMe.push(`extraído dos documentos em documentos/. A IA erra: confira contra o edital`);
  leiaMe.push(`antes de decidir GO/NO-GO, precificar ou assumir qualquer prazo.`);
  leiaMe.push(``);
  leiaMe.push(`Campos em branco significam que a informação NÃO foi encontrada nos`);
  leiaMe.push(`documentos analisados — não que ela não exista. Confirme com o cliente.`);
  zip.file("00_LEIA-ME.txt", leiaMe.join("\n"));

  const out = await zip.generateAsync({ type: "uint8array" });
  const filename = `DOSSIE_${num}_${new Date().toISOString().slice(0, 10)}.zip`;

  return { buffer: Buffer.from(out), filename, incluidos, pulados, bytesBaixados };
}
