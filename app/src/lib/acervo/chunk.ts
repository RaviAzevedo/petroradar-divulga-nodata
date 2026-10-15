/**
 * Chunking de texto JÁ extraído do acervo (sem re-OCR).
 *
 * O cron acervo-index lê texto que já está em disco/banco:
 *   - anexos.textoCache       (texto extraído de anexos de edital)
 *   - documentos_habilitacao.ocrTexto (OCR de certidões/atestados)
 *
 * Aqui apenas QUEBRAMOS esse texto em pedaços (~config.acervo.chunkTamanho
 * caracteres, com sobreposição config.acervo.chunkOverlap) para gerar embeddings
 * granulares. Tentamos cortar em fronteiras naturais (parágrafo > frase > espaço)
 * antes de cortar no meio de uma palavra, preservando legibilidade nas citações.
 *
 * Nada de IO aqui — funções puras e testáveis. O hash de idempotência também
 * vive aqui (sha-256 do texto-fonte) para o cron decidir o que reindexar.
 */

import { createHash } from "node:crypto";
import { config } from "@/lib/config";

export interface Chunk {
  /** Posição do chunk dentro da fonte (0-based). */
  index: number;
  /** Texto do chunk (já normalizado/trim). */
  texto: string;
}

/**
 * Normaliza espaços em branco: colapsa runs de espaços/tabs, mantém quebras de
 * linha (delimitam parágrafos) mas remove linhas vazias excessivas.
 */
function normalizar(texto: string): string {
  return texto
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Procura a melhor fronteira de corte dentro de [min, max] do texto, preferindo
 * fim de parágrafo, depois fim de frase, depois espaço. Retorna o índice de
 * corte (exclusivo). Se nada for encontrado, devolve `hardMax` (corte cego).
 */
function acharFronteira(texto: string, min: number, hardMax: number): number {
  const janela = texto.slice(min, hardMax);

  // 1) Quebra de parágrafo
  const par = janela.lastIndexOf("\n\n");
  if (par > 0) return min + par + 2;

  // 2) Fim de frase (.!? seguido de espaço/quebra)
  const frase = Math.max(
    janela.lastIndexOf(". "),
    janela.lastIndexOf(".\n"),
    janela.lastIndexOf("! "),
    janela.lastIndexOf("? "),
  );
  if (frase > 0) return min + frase + 1;

  // 3) Último espaço/quebra
  const espaco = Math.max(janela.lastIndexOf(" "), janela.lastIndexOf("\n"));
  if (espaco > 0) return min + espaco + 1;

  // 4) Corte cego
  return hardMax;
}

/**
 * Quebra o texto em chunks com sobreposição. Parâmetros vêm de config.acervo
 * por padrão, mas podem ser sobrescritos (útil em testes).
 *
 * Garante: cada chunk tem no máx. ~`tamanho` chars; chunks consecutivos
 * compartilham até `overlap` chars de contexto; chunks vazios são descartados.
 */
export function chunkTexto(
  textoBruto: string,
  opts: { tamanho?: number; overlap?: number } = {},
): Chunk[] {
  const tamanho = Math.max(200, opts.tamanho ?? config.acervo.chunkTamanho);
  // overlap nunca pode ser >= tamanho (geraria loop infinito).
  const overlap = Math.min(
    Math.max(0, opts.overlap ?? config.acervo.chunkOverlap),
    Math.floor(tamanho / 2),
  );

  const texto = normalizar(textoBruto);
  if (texto.length === 0) return [];

  // Texto cabe num único chunk.
  if (texto.length <= tamanho) {
    return [{ index: 0, texto }];
  }

  const chunks: Chunk[] = [];
  let pos = 0;
  let idx = 0;

  while (pos < texto.length) {
    const hardMax = Math.min(pos + tamanho, texto.length);

    let fim: number;
    if (hardMax >= texto.length) {
      fim = texto.length;
    } else {
      // Procura fronteira a partir de ~70% da janela para não gerar chunks
      // pequenos demais nem grandes demais.
      const min = pos + Math.floor(tamanho * 0.7);
      fim = acharFronteira(texto, min, hardMax);
    }

    const pedaco = texto.slice(pos, fim).trim();
    if (pedaco.length > 0) {
      chunks.push({ index: idx, texto: pedaco });
      idx++;
    }

    if (fim >= texto.length) break;

    // Avança com sobreposição; garante progresso mínimo para não travar.
    const proximo = fim - overlap;
    pos = proximo > pos ? proximo : fim;
  }

  return chunks;
}

/**
 * Hash estável (sha-256 hex) do texto-fonte, usado para idempotência da
 * indexação em acervo_index_log (texto_hash + modelo_embedding). Normaliza
 * antes de hashear para que diferenças irrelevantes de whitespace não forcem
 * reindexação.
 */
export function hashTexto(textoBruto: string): string {
  return createHash("sha256").update(normalizar(textoBruto), "utf8").digest("hex");
}
