/**
 * PRODUTOR de texto dos anexos de uma licitação.
 *
 * Preenche `anexos.texto_cache` — a coluna que a análise IA já LÊ e concatena
 * para o Claude (analise/route.ts), mas que hoje NINGUÉM popula (a coleta só
 * grava metadados). Sem isto a análise cai no fallback `licitacoes.objeto`.
 *
 * Por anexo: baixa o binário do Petronect (phio_objid) → extrai o texto →
 * grava em texto_cache (+ baixado_em, ou erro_download na falha).
 *
 * EXTRAÇÃO HÍBRIDA:
 *   1. LOCAL (unpdf/pdfjs) — barata, sem limite de tokens, para PDFs de texto.
 *   2. FALLBACK Claude vision (Haiku) — para PDFs escaneados (pouco texto local),
 *      mesmo padrão de conformidade/ocr.ts (bloco `document` base64).
 *
 * Dependências externas: egress Petronect (download) + Anthropic (só no fallback).
 */

import { db } from "@/db";
import { anexos } from "@/db/schema";
import { eq } from "drizzle-orm";
import { MODELS } from "@/lib/config";
import { criarClienteAnthropic } from "@/lib/ia/gate";
import { loggerFor, logger } from "@/lib/observability/logger";
import { baixarAnexoFonte } from "@/lib/fonte/anexo-fetch";
import { uploadByKey } from "@/lib/storage/upload";

/** Extensão do arquivo a partir do content-type, com a descrição como desempate. */
function extensaoDe(contentType: string | null | undefined, descricao: string): string {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("pdf")) return ".pdf";
  if (ct.includes("zip")) return ".zip";
  if (ct.includes("spreadsheet") || ct.includes("excel")) return ".xlsx";
  if (ct.includes("word")) return ".docx";
  if (ct.includes("text/plain")) return ".txt";
  const doNome = descricao.includes(".") ? descricao.split(".").pop() : null;
  if (doNome && /^[a-z0-9]{1,5}$/i.test(doNome)) return `.${doNome.toLowerCase()}`;
  return ".bin";
}

/** Abaixo disto o texto local é considerado insuficiente (provável PDF escaneado). */
const MIN_TEXTO_LOCAL = 200;
/**
 * Teto de caracteres gravados em texto_cache POR ANEXO.
 *
 * Era 120k, calibrado para um teto total de 100k na análise — que por sua vez
 * vinha de um modelo de 200k de contexto. O Sonnet 5 tem 1 MILHÃO de tokens, e um
 * único anexo ZIP de edital Petrobras (com ET + adendos + anexos técnicos dentro)
 * passa fácil de 400k chars. O teto agora é generoso; quem faz o orçamento de
 * verdade é a análise (ANALISE_MAX_CHARS em executar-analise.ts), que sabe o total.
 */
const MAX_TEXTO_ANEXO = Number(process.env.ANEXO_MAX_CHARS ?? 2_000_000);
/** Entradas lidas dentro de um ZIP de edital. Era 20 — os ZIPs da Petrobras passam disso. */
const MAX_ENTRADAS_ZIP = Number(process.env.ANEXO_MAX_ENTRADAS_ZIP ?? 80);
/**
 * Teto de chamadas de OCR (Claude vision) POR PACOTE.
 *
 * O fallback de vision dentro do ZIP é rede de segurança, não modo de operação:
 * medido em editais reais, 12 de 12 PDFs têm camada de texto e o OCR não dispara
 * nenhuma vez. Mas um pacote anômalo com 80 PDFs escaneados dispararia 80
 * chamadas pagas em sequência — caro e lento, sem ninguém pedir. Passando do
 * teto, o resto do pacote é marcado `[NÃO LIDO]`, que é visível e barato.
 */
const MAX_VISION_POR_ZIP = Number(process.env.ANEXO_MAX_VISION_ZIP ?? 8);

type TipoAnexo = "pdf" | "docx" | "xlsx" | "zip" | "ole2" | "texto";

/**
 * Detecta o tipo real do anexo. O content-type do Petronect é enganoso (manda
 * text/plain para PDF), então magic bytes mandam.
 *
 * ARMADILHA QUE CUSTOU 90% DA ANÁLISE: docx, xlsx e pptx são ZIPs por dentro —
 * começam com os mesmos magic bytes `PK`. A versão anterior desta função devolvia
 * "zip" para todos eles, e o extrator de ZIP ignorava entradas do tipo "zip"
 * ("zips aninhados: ignora"). Resultado: METADE do acervo de uma licitação real
 * (472k de 931k chars — Requisitos de Habilitação, Critério Técnico, Postos de
 * Serviço, Minuta do Contrato, DFP) NUNCA era lida. Em silêncio.
 *
 * Agora abrimos o container PK e olhamos a estrutura: OOXML tem `word/document.xml`
 * (docx) ou `xl/workbook.xml` (xlsx/xlsm). Só o que não é OOXML é ZIP de verdade.
 */
async function sniffTipo(bytes: Uint8Array, contentType: string): Promise<TipoAnexo> {
  const ct = (contentType || "").toLowerCase();

  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return "pdf"; // %PDF
  }

  // OLE2/CFB: .doc, .xls e .ppt legados (D0 CF 11 E0). Não são ZIP e não temos
  // leitor — mas precisam ser RECONHECIDOS para virar um aviso, não um silêncio.
  if (
    bytes.length >= 8 &&
    bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0
  ) {
    return "ole2";
  }

  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05)) {
    try {
      const JSZip = (await import("jszip")).default;
      const zip = await JSZip.loadAsync(bytes);
      if (zip.file("word/document.xml")) return "docx";
      if (zip.file("xl/workbook.xml")) return "xlsx";
      return "zip";
    } catch {
      return "zip";
    }
  }

  if (ct.includes("pdf")) return "pdf";
  if (ct.includes("word")) return "docx";
  if (ct.includes("sheet") || ct.includes("excel")) return "xlsx";
  if (ct.includes("zip")) return "zip";
  return "texto";
}

/** Decodifica bytes como texto (UTF-8; fallback latin1 se vier lixo de replacement). */
function decodeTexto(bytes: Uint8Array): string {
  try {
    const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    // se muitos replacement chars, tenta latin1
    const repl = (utf8.match(/�/g) || []).length;
    if (repl > utf8.length * 0.02) return new TextDecoder("latin1").decode(bytes).trim();
    return utf8.trim();
  } catch {
    return "";
  }
}

/** Extração LOCAL de PDF via unpdf (pdfjs). Retorna "" se falhar. */
async function extrairPdfLocal(bytes: Uint8Array): Promise<string> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    // mergePages: true garante `text` como string única.
    const { text } = await extractText(pdf, { mergePages: true });
    return String(text ?? "").trim();
  } catch (e) {
    logger.warn("extração local (unpdf) falhou", { erro: e instanceof Error ? e.message : String(e) });
    return "";
  }
}

/** Desescapa as 5 entidades XML predefinidas + numéricas. */
function desescaparXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&"); // por último, senão desfaz os de cima
}

/**
 * Extração de DOCX (OOXML). Sem dependência nova: o docx JÁ é um zip e o JSZip já
 * está no projeto.
 *
 * Lê word/document.xml (o corpo) mais cabeçalhos e rodapés — em edital da Petrobras
 * é comum o número do documento e a revisão viverem só no cabeçalho. Preserva a
 * quebra de parágrafo (</w:p>), a quebra de linha (<w:br/>) e a tabulação
 * (<w:tab/>); o resto da marcação some. Células de tabela viram linhas de texto,
 * que é o suficiente para o modelo ler um quadro de requisitos.
 */
async function extrairDocx(bytes: Uint8Array): Promise<string> {
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(bytes);

    const alvos = Object.keys(zip.files).filter(
      (n) => n === "word/document.xml" || /^word\/(header|footer|footnotes|endnotes)\d*\.xml$/.test(n),
    );
    // document.xml primeiro; cabeçalho/rodapé depois (contexto, não corpo).
    alvos.sort((a, b) => (a === "word/document.xml" ? -1 : b === "word/document.xml" ? 1 : a.localeCompare(b)));

    const partes: string[] = [];
    for (const nome of alvos) {
      const xml = await zip.file(nome)!.async("string");
      const texto = desescaparXml(
        xml
          .replace(/<w:tab\b[^>]*\/>/g, "\t")
          .replace(/<w:br\b[^>]*\/>/g, "\n")
          .replace(/<\/w:p>/g, "\n")
          .replace(/<[^>]+>/g, ""),
      )
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (texto.length >= 20) partes.push(texto);
    }
    return partes.join("\n\n").trim();
  } catch (e) {
    logger.warn("extração de docx falhou", { erro: e instanceof Error ? e.message : String(e) });
    return "";
  }
}

/**
 * Extração de XLSX/XLSM via ExcelJS (já é dependência — o checklist oficial usa).
 *
 * Planilha de edital carrega coisa que decide proposta: "Detalhamento dos Postos
 * de Serviço" (a equipe inteira), "Checklist de Documentos de Habilitação", a PPU.
 * Serializa como TSV por aba, que o modelo lê bem e é compacto.
 */
async function extrairXlsx(bytes: Uint8Array): Promise<string> {
  try {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const buf = Buffer.from(bytes);
    await wb.xlsx.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);

    const partes: string[] = [];
    wb.eachSheet((ws) => {
      const linhas: string[] = [];
      ws.eachRow({ includeEmpty: false }, (row) => {
        const celulas: string[] = [];
        row.eachCell({ includeEmpty: false }, (cell) => {
          const v = cell.value;
          let s = "";
          if (v == null) s = "";
          else if (typeof v === "object" && "richText" in v) {
            s = (v.richText as Array<{ text: string }>).map((r) => r.text).join("");
          } else if (typeof v === "object" && "result" in v) {
            s = String((v as { result: unknown }).result ?? ""); // fórmula: usa o valor calculado
          } else if (typeof v === "object" && "text" in v) {
            s = String((v as { text: unknown }).text ?? ""); // hyperlink
          } else if (v instanceof Date) {
            s = v.toLocaleDateString("pt-BR");
          } else {
            s = String(v);
          }
          s = s.replace(/\s+/g, " ").trim();
          if (s) celulas.push(s);
        });
        if (celulas.length) linhas.push(celulas.join("\t"));
      });
      if (linhas.length) partes.push(`## Planilha: ${ws.name}\n${linhas.join("\n")}`);
    });
    return partes.join("\n\n").trim();
  } catch (e) {
    logger.warn("extração de xlsx falhou", { erro: e instanceof Error ? e.message : String(e) });
    return "";
  }
}

/**
 * Extrai texto de um ZIP de edital, recursivamente e por TIPO REAL de cada entrada.
 *
 * A versão anterior só lia PDF e texto puro, e pulava tudo que abrisse com `PK` —
 * ou seja, todo docx e todo xlsx de dentro do pacote. Num edital Petrobras isso é
 * metade do conteúdo, e justamente a metade que decide GO/NO-GO.
 *
 * `profundidade` protege contra zip-bomb/recursão: um zip dentro de zip é lido,
 * dois níveis abaixo não.
 */
async function extrairZip(bytes: Uint8Array, descricao: string, profundidade = 0): Promise<string> {
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(bytes);
    const partes: string[] = [];

    const entradas = Object.values(zip.files)
      .filter((f) => !f.dir)
      .slice(0, MAX_ENTRADAS_ZIP);

    // Conta as chamadas de vision deste pacote (ver MAX_VISION_POR_ZIP).
    let visionUsadas = 0;

    for (const entrada of entradas) {
      const conteudo = await entrada.async("uint8array");
      const tipo = await sniffTipo(conteudo, "");
      let texto = "";

      switch (tipo) {
        case "pdf":
          texto = await extrairPdfLocal(conteudo);
          // OCR TAMBÉM AQUI DENTRO. O anexo avulso já caía para vision quando o
          // texto local vinha ralo; dentro do ZIP não caía — e o ZIP é o formato
          // de ENTREGA PADRÃO do edital Petrobras. Ou
          // seja: o caminho que carrega quase todo o acervo era justamente o que
          // não tinha rede de segurança, e um PDF escaneado no meio do pacote
          // saía vazio sem deixar rastro.
          if (texto.trim().length < MIN_TEXTO_LOCAL) {
            if (visionUsadas < MAX_VISION_POR_ZIP) {
              visionUsadas++;
              const viaVision = await extrairTextoVision(conteudo, entrada.name);
              if (viaVision.trim().length > texto.trim().length) texto = viaVision;
            } else {
              logger.warn("teto de OCR do pacote atingido; entrada nao lida", {
                entrada: entrada.name, teto: MAX_VISION_POR_ZIP,
              });
            }
          }
          break;
        case "docx":  texto = await extrairDocx(conteudo); break;
        case "xlsx":  texto = await extrairXlsx(conteudo); break;
        case "texto": texto = decodeTexto(conteudo); break;
        case "zip":
          if (profundidade < 1) texto = await extrairZip(conteudo, entrada.name, profundidade + 1);
          break;
        case "ole2":
          // .doc/.xls legado (OLE2): não temos leitor. AVISA em vez de sumir —
          // um silêncio aqui é indistinguível de "o documento não diz nada".
          logger.warn("anexo em formato legado ignorado (.doc/.xls OLE2)", { entrada: entrada.name });
          texto = `[NÃO LIDO] ${entrada.name} — formato legado (.doc/.xls). Abra manualmente.`;
          break;
      }

      if (texto.length >= 50) {
        partes.push(`### ${entrada.name}\n${texto}`);
      } else if (tipo !== "zip") {
        // NÃO some em silêncio. Antes, um documento que extraiu mal (< 50 chars)
        // desaparecia sem log e sem marca — indistinguível de "não existia".
        // Ironia do código anterior: um .doc legado, que nem tentamos ler,
        // gerava o aviso `[NÃO LIDO]`; um PDF que tentamos e falhamos, não.
        // Agora os dois avisam, e o aviso vai NO TEXTO que a IA recebe, para o
        // briefing poder dizer que aquele anexo não foi lido.
        logger.warn("entrada de zip rendeu texto insuficiente", {
          entrada: entrada.name, tipo, chars: texto.length,
        });
        partes.push(`### ${entrada.name}\n[NÃO LIDO] Extração rendeu ${texto.length} caracteres (tipo detectado: ${tipo}). Abra o arquivo manualmente — pode conter requisitos não considerados nesta análise.`);
      }
    }

    if (Object.values(zip.files).filter((f) => !f.dir).length > MAX_ENTRADAS_ZIP) {
      partes.push(`### [AVISO] O pacote tem mais de ${MAX_ENTRADAS_ZIP} arquivos; os excedentes não foram lidos.`);
    }

    return partes.join("\n\n").trim();
  } catch (e) {
    logger.warn("extração de zip falhou", { descricao, erro: e instanceof Error ? e.message : String(e) });
    return "";
  }
}

/** Fallback: extração via Claude vision (Haiku) — para PDFs escaneados. */
async function extrairTextoVision(bytes: Uint8Array, descricao: string): Promise<string> {
  // Módulo PERMITIDO na allowlist de IA (ver lib/ia/gate.ts): é o passo que
  // extrai o texto do PDF escaneado DENTRO do fluxo da análise de edital — sem
  // ele a análise não recebe os documentos.
  const client = criarClienteAnthropic("ocr-anexo");
  const base64 = Buffer.from(bytes).toString("base64");
  const message = await client.messages.create({
    model: MODELS.ocr,
    max_tokens: 8192,
    system: [
      {
        type: "text",
        text: "Você transcreve documentos de licitação. Devolva APENAS o texto integral do PDF anexo, preservando a ordem e a estrutura (seções, itens, tabelas como texto). NÃO resuma, NÃO comente, NÃO adicione marcadores — apenas o texto extraído.",
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
          { type: "text", text: `Documento: ${descricao || "anexo"}. Transcreva o texto integral acima.` },
        ],
      },
    ],
  });
  const block = message.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text.trim() : "";
}

/** Extração de um anexo, roteada por tipo real (pdf/zip/texto), local + vision fallback. */
export async function extrairTextoDeAnexo(
  bytes: Uint8Array,
  contentType: string,
  descricao: string,
): Promise<{ texto: string; metodo: "local" | "vision" | "zip" | "docx" | "xlsx" | "texto" | "vazio" }> {
  const tipo = await sniffTipo(bytes, contentType);
  const corta = (t: string) => t.slice(0, MAX_TEXTO_ANEXO);

  if (tipo === "texto") {
    const t = decodeTexto(bytes);
    return t.length > 0 ? { texto: corta(t), metodo: "texto" } : { texto: "", metodo: "vazio" };
  }

  if (tipo === "docx") {
    const t = await extrairDocx(bytes);
    return t.length > 0 ? { texto: corta(t), metodo: "docx" } : { texto: "", metodo: "vazio" };
  }

  if (tipo === "xlsx") {
    const t = await extrairXlsx(bytes);
    return t.length > 0 ? { texto: corta(t), metodo: "xlsx" } : { texto: "", metodo: "vazio" };
  }

  if (tipo === "zip") {
    const t = await extrairZip(bytes, descricao);
    return t.length > 0 ? { texto: corta(t), metodo: "zip" } : { texto: "", metodo: "vazio" };
  }

  if (tipo === "ole2") {
    // .doc/.xls legado: sem leitor. Devolve um marcador visível em vez de "",
    // senão o anexo some da análise sem deixar rastro.
    logger.warn("anexo em formato legado (.doc/.xls OLE2)", { descricao });
    return {
      texto: `[NÃO LIDO] ${descricao} — formato legado (.doc/.xls), sem leitor. Abra manualmente.`,
      metodo: "texto",
    };
  }

  // pdf: local primeiro; se pouco texto (escaneado), vision como fallback
  const local = await extrairPdfLocal(bytes);
  if (local.length >= MIN_TEXTO_LOCAL) return { texto: corta(local), metodo: "local" };
  try {
    const visao = await extrairTextoVision(bytes, descricao);
    if (visao.length > local.length) return { texto: corta(visao), metodo: "vision" };
  } catch (e) {
    logger.warn("extração vision falhou", { erro: e instanceof Error ? e.message : String(e) });
  }
  return local.length > 0 ? { texto: corta(local), metodo: "local" } : { texto: "", metodo: "vazio" };
}

export interface ResumoProcessamento {
  total:       number;
  processados: number;
  comTexto:    number;
  jaTinham:    number;
  semPhio:     number;
  falhas:      Array<{ descricao: string; erro: string }>;
}

/**
 * Baixa e extrai o texto de TODOS os anexos de uma licitação, gravando em
 * `anexos.texto_cache`. Idempotente: pula anexos que já têm texto (a menos de
 * `force`). Nunca lança — acumula falhas por anexo no resumo.
 */
export async function processarAnexosDaLicitacao(
  licitacaoId: string,
  opts: { force?: boolean; request?: Request } = {},
): Promise<ResumoProcessamento> {
  const log = opts.request
    ? loggerFor(opts.request, { route: "licitacoes/baixar-anexos" })
    : logger;

  const lista = await db
    .select({
      id: anexos.id,
      phioObjid: anexos.phioObjid,
      descricao: anexos.descricao,
      contentType: anexos.contentType,
      textoCache: anexos.textoCache,
      s3Key: anexos.s3Key,
    })
    .from(anexos)
    .where(eq(anexos.licitacaoId, licitacaoId));

  const resumo: ResumoProcessamento = {
    total: lista.length, processados: 0, comTexto: 0, jaTinham: 0, semPhio: 0, falhas: [],
  };

  for (const a of lista) {
    const desc = a.descricao ?? a.id;
    if (a.textoCache && a.textoCache.length > 0 && !opts.force) {
      resumo.jaTinham++;
      continue;
    }
    if (!a.phioObjid) {
      resumo.semPhio++;
      resumo.falhas.push({ descricao: desc, erro: "sem phio_objid (não coletado)" });
      await db.update(anexos).set({ erroDownload: "sem phio_objid" }).where(eq(anexos.id, a.id));
      continue;
    }
    try {
      const { bytes, contentType } = await baixarAnexoFonte(a.phioObjid);

      // GUARDA O BINÁRIO. Antes, os bytes eram usados só para extrair o texto e
      // descartados: nada no sistema jamais escrevia `anexos.s3_key` (a coleta
      // grava só metadados). A coluna existia e era LIDA — pelo
      // pacote de orçamento e agora pelo dossiê, que filtram `!!s3Key` para montar
      // o ZIP — então o ZIP saía SEM nenhum documento original, em silêncio.
      //
      // Key determinística por anexo: reprocessar sobrescreve em vez de duplicar.
      // A falha de upload NÃO derruba o anexo — o texto (que alimenta a análise) é
      // o valor principal; o binário é conveniência. Só registramos e seguimos.
      let s3Key: string | undefined;
      if (!a.s3Key || opts.force) {
        try {
          const ext = extensaoDe(contentType ?? a.contentType, desc);
          const r = await uploadByKey(
            `licitacoes/${licitacaoId}/anexos/${a.id}${ext}`,
            Buffer.from(bytes),
            contentType ?? a.contentType ?? undefined,
          );
          s3Key = r.key;
        } catch (eUp) {
          log.warn?.("falha ao guardar binário do anexo no storage", {
            anexo: a.id,
            erro: eUp instanceof Error ? eUp.message : String(eUp),
          });
        }
      }

      const { texto, metodo } = await extrairTextoDeAnexo(bytes, contentType ?? a.contentType ?? "", desc);
      resumo.processados++;
      if (texto.length >= 100) {
        await db.update(anexos)
          .set({
            textoCache: texto,
            contentType: contentType ?? a.contentType,
            baixadoEm: new Date(),
            erroDownload: null,
            ...(s3Key ? { s3Key } : {}),
          })
          .where(eq(anexos.id, a.id));
        resumo.comTexto++;
        log.info?.("anexo extraído", { anexo: a.id, chars: texto.length, metodo, guardado: !!s3Key });
      } else {
        // Texto insuficiente NÃO é motivo para perder o arquivo: o PDF continua
        // indo para o ZIP, e o humano lê o que a IA não conseguiu.
        await db.update(anexos)
          .set({
            baixadoEm: new Date(),
            erroDownload: `texto insuficiente (${texto.length} chars, metodo=${metodo})`,
            ...(s3Key ? { s3Key } : {}),
          })
          .where(eq(anexos.id, a.id));
        resumo.falhas.push({ descricao: desc, erro: `texto insuficiente (${metodo})` });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.update(anexos).set({ erroDownload: msg.slice(0, 500) }).where(eq(anexos.id, a.id));
      resumo.falhas.push({ descricao: desc, erro: msg });
    }
  }

  return resumo;
}
