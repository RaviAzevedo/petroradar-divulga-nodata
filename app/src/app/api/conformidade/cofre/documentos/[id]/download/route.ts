export const runtime = "nodejs";

/**
 * GET /api/conformidade/cofre/documentos/[id]/download
 *
 * Proxy autenticado pra download de documento do cofre de habilitação (CND,
 * ISO, ART/CAT, declarações, ACT etc.). Stream direto do R2.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { auditLog, operacoes } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getDocumentoById } from "@/lib/conformidade/cofre/queries";
import { registrarDownloadRestrito } from "@/lib/conformidade/cofre/audit-restrito";
import { streamFromR2 } from "@/lib/storage/download";
import { buildDownloadHeaders } from "@/lib/storage/disposition";
import { loggerFor } from "@/lib/observability/logger";
import { isConformidade } from "@/lib/permissions";
import { requireVisualizar, handleApiError } from "@/lib/api/guards";

type Params = { params: Promise<{ id: string }> };

/** IP do cliente via x-forwarded-for (1º IP) → x-real-ip → "unknown". */
function getClientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  const first = xff.split(",")[0]?.trim();
  if (first) return first;
  return req.headers.get("x-real-ip") ?? "unknown";
}

/** User-Agent truncado em 512 chars (não infla o audit). */
function getUserAgent(req: Request): string {
  return (req.headers.get("user-agent") ?? "unknown").slice(0, 512);
}

export async function GET(_req: NextRequest, { params }: Params) {
  const log = loggerFor(_req, { route: "cofre/download" });
  let user: Awaited<ReturnType<typeof requireVisualizar>>["user"];
  try {
    ({ user } = await requireVisualizar());
  } catch (e) {
    return handleApiError(e);
  }

  const { id } = await params;
  const documento = await getDocumentoById(id);
  if (!documento) {
    return NextResponse.json({ error: "Documento não encontrado" }, { status: 404 });
  }

  // Barreira restrito (0034/R16): o MESMO corpo do 404 de inexistente — nunca
  // 403, que confirmaria a existência (ADR-05).
  if (documento.restrito && !isConformidade(user.role)) {
    return NextResponse.json({ error: "Documento não encontrado" }, { status: 404 });
  }

  if (!documento.blobKey) {
    return NextResponse.json({ error: "Documento sem blob_key" }, { status: 500 });
  }

  try {
    const obj = await streamFromR2(documento.blobKey);
    const requestedInline = new URL(_req.url).searchParams.get("inline") === "1";

    // Espelho 0035 (P7): Conformidade baixando restrito é registrado FORA do
    // expurgo de 12 meses, ANTES de streamar o corpo — best-effort com log,
    // ALÉM do audit LGPD abaixo. IP/user-agent NÃO entram aqui (colunas fixas
    // da 0035; quem precisar cruza com o audit_log na janela de 12 meses).
    if (documento.restrito) {
      try {
        const operacaoCodigo = documento.operacaoId
          ? (await db
              .select({ codigo: operacoes.codigo })
              .from(operacoes)
              .where(eq(operacoes.id, documento.operacaoId))
              .limit(1))[0]?.codigo ?? null
          : null;
        await registrarDownloadRestrito({
          documentoId:    documento.id,
          titulo:         documento.titulo,
          operacaoCodigo,
          userId:         user.id,
          userEmail:      user.email ?? "",
          role:           user.role,
          via:            "DOWNLOAD",
        });
      } catch (e) {
        log.error("Falha ao gravar espelho 0035 (best-effort)", e, { docId: id });
      }
    }

    // Auditoria LGPD (best-effort): documentos de habilitação contêm PII (CPF,
    // certidões). Registra QUEM baixou O QUÊ e QUANDO — após o guard
    // requireVisualizar (401/403 nunca chegam aqui), a linha existir (404 já
    // retornou) e o storage responder (o catch abaixo trata 500): só download
    // efetivamente autorizado. IP/user-agent vão no jsonb `detalhes` (sem PII do
    // conteúdo). Falha de auditoria NÃO derruba o download (try/catch próprio).
    try {
      await db.insert(auditLog).values({
        userId:     user.id,
        acao:       "DOWNLOAD_DOCUMENTO_HABILITACAO",
        entidade:   "documento_habilitacao",
        entidadeId: documento.id,
        detalhes: {
          nomeArquivo: documento.nomeArquivo,
          inline:      requestedInline,
          ip:          getClientIp(_req),
          userAgent:   getUserAgent(_req),
        },
      });
    } catch (auditErr) {
      log.error("Falha ao gravar audit de download (best-effort)", auditErr, { docId: id });
    }

    const { contentType, contentDisposition } = buildDownloadHeaders(
      documento.nomeArquivo,
      documento.contentType,
      obj.contentType,
      requestedInline,
    );
    const headers = new Headers({
      "Content-Type":        contentType,
      "Content-Disposition": contentDisposition,
      "Cache-Control":       "private, no-store",
    });
    if (obj.contentLength != null) headers.set("Content-Length", String(obj.contentLength));
    return new NextResponse(obj.body, { status: 200, headers });
  } catch (err) {
    log.error("R2 error", err, { docId: id });
    return NextResponse.json({ error: "Falha ao baixar o arquivo" }, { status: 500 });
  }
}
