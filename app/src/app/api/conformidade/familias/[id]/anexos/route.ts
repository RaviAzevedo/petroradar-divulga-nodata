export const runtime = "nodejs";

/**
 * GET  /api/conformidade/familias/[id]/anexos — lista anexos da família
 * POST /api/conformidade/familias/[id]/anexos — multipart upload (certificado_crc / ata / outro)
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { familias, familiasAnexos, auditLog, type TipoAnexoFamilia } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { podeGerenciarFamilias } from "@/lib/permissions";
import { requireAuth, requireVisualizar, handleApiError } from "@/lib/api/guards";
import { uploadByKey, validarTipoArquivo, validarTamanhoArquivo, validarMagicBytes } from "@/lib/storage/upload";
import { getAnexosByFamilia } from "@/lib/conformidade/familias/queries";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    await requireVisualizar();
  } catch (e) {
    return handleApiError(e);
  }
  const { id } = await params;
  const lista = await getAnexosByFamilia(id);
  return NextResponse.json({ data: lista });
}

export async function POST(request: NextRequest, { params }: Params) {
  let session;
  try {
    ({ session } = await requireAuth());
  } catch (e) {
    return handleApiError(e);
  }
  if (!podeGerenciarFamilias(session.user.role)) {
    return NextResponse.json({ error: "Permissão negada" }, { status: 403 });
  }

  const { id } = await params;
  const [fam] = await db
    .select({ id: familias.id, codigoNormalizado: familias.codigoNormalizado })
    .from(familias)
    .where(and(eq(familias.id, id), isNull(familias.deletadoEm)))
    .limit(1);
  if (!fam) return NextResponse.json({ error: "Família não encontrada" }, { status: 404 });

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

  const tipoRaw = String(formData.get("tipo") ?? "OUTRO");
  const tipo: TipoAnexoFamilia =
    tipoRaw === "CERTIFICADO_CRC" || tipoRaw === "ATA_AUDITORIA" ? tipoRaw : "OUTRO";

  const validadeRaw = String(formData.get("validadeFim") ?? "").trim();
  const validadeFim = validadeRaw ? new Date(validadeRaw) : null;

  const nomeSan = file.name
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\.\./g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = `conformidade/familias/${fam.codigoNormalizado}/${Date.now()}_${nomeSan}`;
  const upload = await uploadByKey(key, file, file.type);

  const [novo] = await db.insert(familiasAnexos).values({
    familiaId:    fam.id,
    tipo,
    nomeArquivo:  file.name,
    blobUrl:      upload.url,
    blobKey:      upload.key,
    tamanhoBytes: file.size,
    contentType:  upload.contentType,
    validadeFim,
    uploadadoPor: session.user.id,
  }).returning();

  await db.insert(auditLog).values({
    userId: session.user.id,
    acao: "UPLOAD_ANEXO_FAMILIA",
    entidade: "familia",
    entidadeId: fam.id,
    detalhes: { anexoId: novo.id, tipo, nomeArquivo: novo.nomeArquivo },
  });
  return NextResponse.json(novo, { status: 201 });
}
