export const runtime = "nodejs";

/**
 * GET  /api/conformidade/cofre/documentos/[id]/anexos — lista anexos extras
 * POST /api/conformidade/cofre/documentos/[id]/anexos — multipart upload de anexo extra
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { documentosHabilitacao, documentosHabilitacaoAnexos, auditLog, type TipoAnexoDocumento } from "@/db/schema";
import { eq } from "drizzle-orm";
import { podeGerenciarDocumentosHabilitacao, isConformidade } from "@/lib/permissions";
import { requireAuth, requireVisualizar, handleApiError } from "@/lib/api/guards";
import { uploadByKey, validarTipoArquivo, validarTamanhoArquivo, validarMagicBytes } from "@/lib/storage/upload";
import { getAnexosByDocumento, paiRestritoInvisivel } from "@/lib/conformidade/cofre/queries";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  let user: Awaited<ReturnType<typeof requireVisualizar>>["user"];
  try {
    ({ user } = await requireVisualizar());
  } catch (e) {
    return handleApiError(e);
  }
  const { id } = await params;
  // Barreira do pai (0034/S8): documento restrito é invisível fora de
  // Conformidade — 404 com a MESMA string do 404 de documento inexistente.
  if (await paiRestritoInvisivel(id, user.role)) {
    return NextResponse.json({ error: "Documento não encontrado" }, { status: 404 });
  }
  const lista = await getAnexosByDocumento(id);
  return NextResponse.json({ data: lista });
}

export async function POST(request: NextRequest, { params }: Params) {
  let session;
  try {
    ({ session } = await requireAuth());
  } catch (e) {
    return handleApiError(e);
  }
  if (!podeGerenciarDocumentosHabilitacao(session.user.role)) {
    return NextResponse.json({ error: "Permissão negada" }, { status: 403 });
  }

  const { id } = await params;
  const [doc] = await db
    .select({ id: documentosHabilitacao.id, restrito: documentosHabilitacao.restrito })
    .from(documentosHabilitacao)
    .where(eq(documentosHabilitacao.id, id))
    .limit(1);
  if (!doc) return NextResponse.json({ error: "Documento não encontrado" }, { status: 404 });

  // (0034/S8) Barreira do pai restrito ANTES do parse do multipart: nenhum
  // blob sobe, nenhuma linha nasce em documentos_habilitacao_anexos —
  // ORCAMENTISTA/TECNICO passam no gate de papel, mas não podem sequer
  // inferir a existência de um contrato restrito pela diferença de resposta.
  if (doc.restrito && !isConformidade(session.user.role)) {
    return NextResponse.json({ error: "Documento não encontrado" }, { status: 404 });
  }

  let formData: FormData;
  try { formData = await request.formData(); }
  catch { return NextResponse.json({ error: "Esperado multipart/form-data" }, { status: 400 }); }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Arquivo é obrigatório" }, { status: 422 });
  }

  const t = validarTipoArquivo(file);
  if (!t.valido) return NextResponse.json({ error: t.erro }, { status: 422 });
  const tam = validarTamanhoArquivo(file, 50);
  if (!tam.valido) return NextResponse.json({ error: tam.erro }, { status: 422 });
  const mb = await validarMagicBytes(file);
  if (!mb.valido) return NextResponse.json({ error: mb.erro }, { status: 422 });

  const tipoRaw = String(formData.get("tipo") ?? "ANEXO");
  const tipo: TipoAnexoDocumento =
    tipoRaw === "COMPLEMENTAR" || tipoRaw === "RETIFICACAO" || tipoRaw === "OUTRO"
      ? tipoRaw
      : "ANEXO";

  const titulo = String(formData.get("titulo") ?? "").trim() || null;

  const nomeSan = file.name
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\.\./g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = `conformidade/documentos/${doc.id}/anexos/${Date.now()}_${nomeSan}`;
  const upload = await uploadByKey(key, file, file.type);

  const [novo] = await db.insert(documentosHabilitacaoAnexos).values({
    documentoId:  doc.id,
    tipo,
    titulo,
    nomeArquivo:  file.name,
    blobUrl:      upload.url,
    blobKey:      upload.key,
    tamanhoBytes: file.size,
    contentType:  upload.contentType,
    uploadadoPor: session.user.id,
  }).returning();

  await db.insert(auditLog).values({
    userId: session.user.id,
    acao: "UPLOAD_ANEXO_DOCUMENTO",
    entidade: "documento_habilitacao",
    entidadeId: doc.id,
    detalhes: { anexoId: novo.id, tipo, nomeArquivo: novo.nomeArquivo, titulo },
  });
  return NextResponse.json(novo, { status: 201 });
}
