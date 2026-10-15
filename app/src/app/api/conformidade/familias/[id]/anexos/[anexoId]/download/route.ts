export const runtime = "nodejs";

/**
 * GET /api/conformidade/familias/[id]/anexos/[anexoId]/download
 * Proxy autenticado streaming de anexos de família (CRC, atas, etc.).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { familiasAnexos } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { streamFromR2 } from "@/lib/storage/download";
import { buildDownloadHeaders } from "@/lib/storage/disposition";
import { loggerFor } from "@/lib/observability/logger";
import { requireVisualizar, handleApiError } from "@/lib/api/guards";

type Params = { params: Promise<{ id: string; anexoId: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const log = loggerFor(_req, { route: "familia-anexo/download" });
  try {
    await requireVisualizar();
  } catch (e) {
    return handleApiError(e);
  }

  const { id, anexoId } = await params;
  const [a] = await db.select().from(familiasAnexos)
    .where(and(eq(familiasAnexos.id, anexoId), eq(familiasAnexos.familiaId, id)))
    .limit(1);
  if (!a) return NextResponse.json({ error: "Anexo não encontrado" }, { status: 404 });
  if (!a.blobKey) return NextResponse.json({ error: "Anexo sem blob_key" }, { status: 500 });

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
    log.error("R2 error", err, { familiaId: id, anexoId });
    return NextResponse.json({ error: "Falha ao baixar" }, { status: 500 });
  }
}
