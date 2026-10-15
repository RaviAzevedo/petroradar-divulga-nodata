export const runtime = "nodejs";

/**
 * GET /api/conformidade/cofre/documentos/[id]/anexos/[anexoId]/download
 * Proxy autenticado streaming de anexos extras do cofre.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { documentosHabilitacao, documentosHabilitacaoAnexos, operacoes } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { streamFromR2 } from "@/lib/storage/download";
import { buildDownloadHeaders } from "@/lib/storage/disposition";
import { loggerFor } from "@/lib/observability/logger";
import { isConformidade } from "@/lib/permissions";
import { requireVisualizar, handleApiError } from "@/lib/api/guards";
import { registrarDownloadRestrito } from "@/lib/conformidade/cofre/audit-restrito";

type Params = { params: Promise<{ id: string; anexoId: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const log = loggerFor(_req, { route: "cofre-anexo/download" });
  let user: Awaited<ReturnType<typeof requireVisualizar>>["user"];
  try {
    ({ user } = await requireVisualizar());
  } catch (e) {
    return handleApiError(e);
  }

  const { id, anexoId } = await params;

  // Barreira do pai (0034/S10) — resolve o documento ANTES do anexo. O SELECT
  // traz titulo/restrito e o código da operação para o espelho 0035. Pai
  // restrito fora de Conformidade → 404 "Documento não encontrado" (a MESMA
  // string do 404 de documento inexistente) — nenhum byte do blob sai.
  const [pai] = await db
    .select({
      id:             documentosHabilitacao.id,
      titulo:         documentosHabilitacao.titulo,
      restrito:       documentosHabilitacao.restrito,
      operacaoCodigo: operacoes.codigo,
    })
    .from(documentosHabilitacao)
    .leftJoin(operacoes, eq(operacoes.id, documentosHabilitacao.operacaoId))
    .where(sql`${documentosHabilitacao.id}::text = ${id}`)
    .limit(1);
  if (pai && pai.restrito && !isConformidade(user.role)) {
    return NextResponse.json({ error: "Documento não encontrado" }, { status: 404 });
  }

  const [a] = await db.select().from(documentosHabilitacaoAnexos)
    .where(and(eq(documentosHabilitacaoAnexos.id, anexoId), eq(documentosHabilitacaoAnexos.documentoId, id)))
    .limit(1);
  if (!a) return NextResponse.json({ error: "Anexo não encontrado" }, { status: 404 });
  if (!a.blobKey) return NextResponse.json({ error: "Anexo sem blob_key" }, { status: 500 });

  // Espelho 0035 (P7 — S10): Conformidade baixando anexo de documento RESTRITO
  // é registrado FORA do expurgo de 12 meses, ANTES do stream — best-effort com
  // log (falha não derruba o download). `via: "DOWNLOAD_ANEXO"` (coluna text
  // sem CHECK na 0035 — valor novo compatível, 02-APIS §16-B.1).
  if (pai && pai.restrito) {
    try {
      await registrarDownloadRestrito({
        documentoId:    pai.id,
        titulo:         pai.titulo,
        operacaoCodigo: pai.operacaoCodigo ?? null,
        userId:         user.id,
        userEmail:      user.email ?? "",
        role:           user.role,
        via:            "DOWNLOAD_ANEXO",
      });
    } catch (e) {
      log.error("Falha ao gravar espelho 0035 (best-effort)", e, { docId: id, anexoId });
    }
  }

  try {
    const obj = await streamFromR2(a.blobKey);
    const requestedInline = new URL(_req.url).searchParams.get("inline") === "1";
    const { contentType, contentDisposition } = buildDownloadHeaders(
      a.nomeArquivo,
      a.contentType,
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
    log.error("R2 error", err, { docId: id, anexoId });
    return NextResponse.json({ error: "Falha ao baixar" }, { status: 500 });
  }
}
