/**
 * OCR de documentos de habilitação via Claude Haiku 4.5.
 *
 * Anthropic SDK aceita PDFs nativamente (vision). Aqui usamos o modelo mais
 * barato (Haiku 4.5) pra extrair metadados estruturados de certidões/atestados:
 *   - numeroDocumento
 *   - emitidoEm
 *   - validadeFim
 *   - ocrTexto (texto bruto extraído)
 *   - ocrConfianca (0..1)
 *
 * Custo aproximado: ~R$ 0,02 por documento (input ~3-5k tokens, output ~200).
 * Já está dentro do orçamento Anthropic existente (mesmo SDK usado pra análise
 * de licitações). Pra economizar mais, considerar cache de prompts comuns.
 *
 * Uso:
 *   const meta = await extrairMetadadosDocumento(blobUrl, "FISCAL", "CND_FEDERAL");
 *   if (meta.validadeFim) await db.update(...).set({ validadeFim: meta.validadeFim });
 */

import { criarClienteAnthropic } from "@/lib/ia/gate";
import type { CategoriaDocHab, SubcategoriaDocHab } from "@/db/schema";
import { MODELS } from "@/lib/config";

const MODEL = MODELS.ocr;

// Bloco ESTÁTICO de instruções — idêntico em todo documento processado. Vai como
// `system` (separado do dado variável: categoria/subcategoria + PDF entram no
// message do usuário) e marcado com cache_control pra ativar prompt caching: a
// Anthropic reaproveita o prefixo entre chamadas, cortando custo/latência quando
// o cofre processa vários docs em lote. (Mesmo padrão da triagem-semântica do feed.)
const SYSTEM_OCR = `Você é um especialista em documentos de habilitação para licitações da Petrobras no Brasil.

Examine o PDF anexo e extraia os metadados estruturados.

Responda EXATAMENTE em JSON válido (sem markdown, sem \`\`\`):
{
  "numero_documento": "número/código do documento ou null",
  "emitido_em": "YYYY-MM-DD ou null",
  "validade_fim": "YYYY-MM-DD ou null (data de vencimento/validade)",
  "validade_indeterminada": true ou false (true se o documento não tem prazo formal — ex: contrato social, CREA-PJ vitalício),
  "texto_resumo": "1-2 frases descrevendo o conteúdo do documento",
  "confianca": 0.0 a 1.0 (sua confiança nos dados extraídos)
}

REGRAS:
- "validade_fim" é a data até quando o documento é válido. Para CNDs e certidões, geralmente é 6 meses após emissão.
- Para ISO/NRs, é a data de fim de vigência do certificado.
- Se for um contrato social ou ato constitutivo SEM prazo, marque "validade_indeterminada": true e deixe "validade_fim": null.
- Se não conseguir identificar, retorne null no campo (não invente).
- Datas devem estar no formato ISO YYYY-MM-DD (ex: "2026-08-12").`;

export interface MetadadosDocumento {
  numeroDocumento: string | null;
  emitidoEm:       Date | null;
  validadeFim:     Date | null;
  validadeIndeterminada: boolean;
  textoResumo:     string;
  ocrConfianca:    number;
  modelo:          string;
  tokensInput:     number;
  tokensOutput:    number;
  tempoMs:         number;
}

/**
 * Extrai metadados de um PDF de documento de habilitação.
 *
 * @param pdfUrl URL do PDF (deve ser acessível publicamente OU byte content via param adicional)
 * @param categoria categoria do documento (FISCAL, TECNICA, etc.)
 * @param subcategoria subcategoria específica (CND_FEDERAL, ISO_9001, etc.)
 */
export async function extrairMetadadosDocumento(
  pdfBytes: ArrayBuffer | Uint8Array,
  categoria: CategoriaDocHab,
  subcategoria: SubcategoriaDocHab,
): Promise<MetadadosDocumento> {
  // IA BLOQUEADA para este módulo por decisão de produto (ver lib/ia/gate.ts):
  // só a análise de edital consome a API da Anthropic. Não há fallback aqui, e
  // isso é intencional — criarClienteAnthropic LANÇA e o OCR de conformidade
  // fica indisponível de forma explícita, em vez de silenciosamente caro.
  const client = criarClienteAnthropic("ocr-conformidade");

  // Encode bytes em base64 (Buffer é muito mais rápido que loop char-a-char).
  const bytes = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
  const base64 = Buffer.from(bytes).toString("base64");

  const start = Date.now();

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    // Prefixo estático cacheável (instruções idênticas em todo documento),
    // marcado com cache_control pra ativar prompt caching.
    system: [
      {
        type: "text",
        text: SYSTEM_OCR,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type:        "base64",
              media_type:  "application/pdf",
              data:        base64,
            },
          },
          {
            // Parte dinâmica (categoria/subcategoria) — fora do bloco cacheado.
            type: "text",
            text: `Contexto do documento — categoria: ${categoria}, subcategoria: ${subcategoria}. Extraia os metadados do PDF acima conforme as instruções.`,
          },
        ],
      },
    ],
  });

  const elapsed = Date.now() - start;

  // Se truncou no teto de tokens, o JSON está incompleto: lança pra não gravar
  // metadados parciais como se fossem confiáveis.
  if (message.stop_reason === "max_tokens") {
    throw new Error("Resposta de OCR truncada (max_tokens).");
  }

  const block = message.content.find((b) => b.type === "text");
  const texto = block && block.type === "text" ? block.text : "";

  // Parse JSON tolerante
  const cleaned = texto.replace(/```json\s*/g, "").replace(/```\s*$/g, "").trim();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start2 = cleaned.indexOf("{");
    if (start2 >= 0) {
      let depth = 0;
      for (let i = start2; i < cleaned.length; i++) {
        if (cleaned[i] === "{") depth++;
        else if (cleaned[i] === "}") {
          depth--;
          if (depth === 0) {
            try { parsed = JSON.parse(cleaned.slice(start2, i + 1)); } catch { /* ignora */ }
            break;
          }
        }
      }
    }
  }

  function parseDate(v: unknown): Date | null {
    if (!v || typeof v !== "string") return null;
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const d = new Date(`${v}T00:00:00Z`);
    return isNaN(d.getTime()) ? null : d;
  }

  return {
    numeroDocumento:        typeof parsed.numero_documento === "string" ? parsed.numero_documento : null,
    emitidoEm:              parseDate(parsed.emitido_em),
    validadeFim:            parseDate(parsed.validade_fim),
    validadeIndeterminada:  parsed.validade_indeterminada === true,
    textoResumo:            typeof parsed.texto_resumo === "string" ? parsed.texto_resumo : "",
    ocrConfianca:           typeof parsed.confianca === "number" ? parsed.confianca : 0.5,
    modelo:                 MODEL,
    tokensInput:            message.usage.input_tokens,
    tokensOutput:           message.usage.output_tokens,
    tempoMs:                elapsed,
  };
}
