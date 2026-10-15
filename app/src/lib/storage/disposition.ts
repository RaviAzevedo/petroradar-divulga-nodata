/**
 * Helpers de Content-Type e Content-Disposition para downloads autenticados.
 *
 * Resolvem três problemas de segurança em rotas de proxy R2 (cofre, anexos
 * família, documentos participação):
 *   1. ?inline=1 pode renderizar HTML/SVG malicioso no browser → XSS
 *   2. Filename mal escapado em Content-Disposition → header injection / parsing quebrado
 *   3. Content-Type vem do upload do cliente (sem garantia) → spoofing de tipo
 *
 * Estratégia (defesa em profundidade — combina com X-Content-Type-Options: nosniff
 * já aplicado globalmente em next.config.ts):
 *   - Whitelist de MIME-types seguros pra inline. Fora dela, força attachment.
 *   - MIMEs perigosos (HTML, JS, SVG, XML) → trocados por application/octet-stream
 *     quando servidos, evitando que o browser execute o conteúdo.
 *   - Filename com fallback ASCII + filename* RFC 5987 UTF-8 encoded.
 */

const INLINE_SAFE_MIMES: ReadonlySet<string> = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
]);

const DANGEROUS_MIMES: ReadonlySet<string> = new Set([
  "text/html",
  "application/xhtml+xml",
  "application/javascript",
  "text/javascript",
  "application/x-javascript",
  "image/svg+xml",
  "text/xml",
  "application/xml",
]);

function normalizeMime(mime: string | null | undefined): string {
  if (!mime) return "application/octet-stream";
  const trimmed = mime.includes(";") ? mime.split(";")[0] : mime;
  return trimmed.trim().toLowerCase();
}

/**
 * Verdadeiro se o MIME pode ser servido com Content-Disposition: inline
 * com baixo risco de XSS.
 */
function isMimeSafeForInline(mime: string | null | undefined): boolean {
  return INLINE_SAFE_MIMES.has(normalizeMime(mime));
}

/**
 * Devolve um MIME seguro pra colocar em Content-Type do response.
 * Tipos perigosos (HTML, JS, SVG, XML) são reescritos como
 * application/octet-stream — combinado com X-Content-Type-Options: nosniff
 * impede execução pelo browser.
 */
export function sanitizeResponseMime(mime: string | null | undefined): string {
  const m = normalizeMime(mime);
  if (DANGEROUS_MIMES.has(m)) return "application/octet-stream";
  return m;
}

/**
 * Sanitiza nome de arquivo pra fallback ASCII no Content-Disposition.
 * Remove CR/LF (header injection), aspas e caracteres não-ASCII.
 */
function asciiFilenameFallback(name: string): string {
  const ascii = name
    .replace(/[\r\n"\\]/g, "_")        // header injection + escape literals
    .replace(/[^\x20-\x7E]/g, "_");     // não-ASCII vira _
  // Limita comprimento pra evitar headers gigantes
  return ascii.slice(0, 200) || "arquivo";
}

/**
 * Monta header Content-Disposition seguindo RFC 6266 + RFC 5987.
 *
 * Combina:
 *   - filename="…" (fallback ASCII pra clientes antigos)
 *   - filename*=UTF-8''… (UTF-8 percent-encoded pra browsers modernos)
 *
 * Decisão automática de inline×attachment:
 *   - Se requestedInline e o MIME está na whitelist → inline
 *   - Caso contrário → attachment (mesmo se ?inline=1 for pedido)
 */
export function buildContentDisposition(
  filename: string,
  requestedInline: boolean,
  mime: string | null | undefined,
): string {
  const allowInline = requestedInline && isMimeSafeForInline(mime);
  const dispo = allowInline ? "inline" : "attachment";

  const ascii = asciiFilenameFallback(filename);
  const utf8  = encodeURIComponent(filename);

  return `${dispo}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/**
 * Resolve os headers seguros pra um download de proxy R2.
 *
 * Recebe MIME do banco (vindo do upload), MIME do R2 e o filename original;
 * devolve {contentType, contentDisposition} prontos pra colocar no Headers.
 */
export function buildDownloadHeaders(
  filename: string,
  storedMime: string | null | undefined,
  r2Mime: string | null | undefined,
  requestedInline: boolean,
): { contentType: string; contentDisposition: string } {
  const mime = storedMime || r2Mime || "application/octet-stream";
  return {
    contentType:        sanitizeResponseMime(mime),
    contentDisposition: buildContentDisposition(filename, requestedInline, mime),
  };
}
