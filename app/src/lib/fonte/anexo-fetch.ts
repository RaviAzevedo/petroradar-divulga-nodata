/**
 * Conector de download de anexos na fonte de origem da licitação.
 *
 * Esta versão pública NÃO inclui conector para nenhum portal externo: o ponto
 * de extensão fica aqui. Para plugar uma fonte, implemente `baixarAnexoFonte`
 * devolvendo os bytes e o content-type do anexo identificado por `phio`.
 */

/** MIMEs perigosos: página de erro disfarçada ou executável — recusa. */
export const BLOCKED_DOWNSTREAM_MIMES: ReadonlySet<string> = new Set([
  "text/html", "application/xhtml+xml", "image/svg+xml",
  "text/xml", "application/xml", "application/javascript",
  "text/javascript", "application/x-javascript",
]);

export interface AnexoBaixado {
  bytes:       Uint8Array;
  contentType: string;
}

export class ConectorAusenteError extends Error {
  constructor() {
    super("Conector de anexos não configurado nesta instalação");
    this.name = "ConectorAusenteError";
  }
}

/**
 * Baixa o binário de um anexo na fonte de origem.
 *
 * @param phio     identificador do anexo na fonte (anexos.phio_objid)
 * @param maxBytes teto de tamanho (default 40MB)
 */
export async function baixarAnexoFonte(phio: string, maxBytes = 40 * 1024 * 1024): Promise<AnexoBaixado> {
  void phio; void maxBytes;
  throw new ConectorAusenteError();
}
