/**
 * Helpers de Upload — Cloudflare R2 (S3-compatible).
 *
 * Arquivos vão pro bucket privado R2. Pra servir, sempre via proxy autenticado
 * em /api/.../[id]/download (vê `lib/blob/download.ts`).
 *
 * Migrado em 2026-05-05 do Vercel Blob para resolver:
 *   - Bug do download (getDownloadUrl + fetch sem token)
 *   - Custo crescente do egress (R2 tem egress grátis)
 *   - Limite de 1 GB do Vercel Blob Hobby
 */

import { PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getR2Client, getR2Bucket, getR2ObjectUrl } from "./r2";

export interface UploadResult {
  /** URL canônica S3 (pra debug). Servir via proxy autenticado, nunca diretamente. */
  url: string;
  /** Key no bucket (path-like). Single source of truth pra recuperar o objeto. */
  key: string;
  contentType: string;
  size: number;
}

function sanitizeName(nomeOriginal: string): string {
  return nomeOriginal
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\.\./g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function uploadKey(
  key: string,
  file: File | Buffer,
  contentType?: string,
): Promise<UploadResult> {
  const client = getR2Client();
  const bucket = getR2Bucket();

  // Converter File pra Buffer (R2 SDK aceita Buffer/Uint8Array/Stream)
  const body: Buffer = file instanceof File
    ? Buffer.from(await file.arrayBuffer())
    : file;

  const ct = contentType ?? (file instanceof File ? file.type : undefined) ?? "application/octet-stream";

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: ct,
  }));

  return {
    url:         getR2ObjectUrl(key),
    key,
    contentType: ct,
    size:        body.length,
  };
}

/**
 * Faz upload de um documento de COFRE/HABILITAÇÃO pro R2.
 * Path: habilitacao/<categoria>/<subcategoria>/<timestamp>_<nome>
 */
export async function uploadHabilitacao(
  file: File | Buffer,
  categoria: string,
  subcategoria: string,
  nomeOriginal: string,
): Promise<UploadResult> {
  const nomeSanitizado = sanitizeName(nomeOriginal);
  const timestamp = Date.now();
  const key = `habilitacao/${categoria}/${subcategoria}/${timestamp}_${nomeSanitizado}`;
  const contentType = file instanceof File ? file.type : undefined;
  return uploadKey(key, file, contentType);
}

/**
 * Upload genérico em key arbitrária — usado pelo /api/conformidade/import/scan
 * (CLI petro-radar-sync) que já decide o path.
 */
export async function uploadByKey(
  key: string,
  file: File | Buffer,
  contentType?: string,
): Promise<UploadResult> {
  return uploadKey(key, file, contentType);
}

/**
 * Remove um documento do R2.
 * Recebe a key (não a URL) — caller normalmente passa `documento.blobKey`.
 */
export async function deleteDocumento(keyOrUrl: string): Promise<void> {
  // Tolera tanto key quanto URL completa S3
  let key = keyOrUrl;
  const urlMatch = keyOrUrl.match(/r2\.cloudflarestorage\.com\/[^/]+\/(.+)$/);
  if (urlMatch) key = urlMatch[1];

  const client = getR2Client();
  const bucket = getR2Bucket();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

// ── Validações de arquivo (mantidas idênticas — não dependem de storage) ───

/** PDF: começa com %PDF (25 50 44 46) */
function isPDF(bytes: Uint8Array): boolean {
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

/** ZIP-based (XLSX, DOCX): começa com PK (50 4B 03 04) */
function isZIP(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** OLE2 (XLS, DOC): começa com D0 CF 11 E0 */
function isOLE2(bytes: Uint8Array): boolean {
  return bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0;
}

export async function validarMagicBytes(file: File): Promise<{ valido: boolean; erro?: string }> {
  try {
    const buffer = await file.slice(0, 8).arrayBuffer();
    const bytes  = new Uint8Array(buffer);
    if (isPDF(bytes) || isZIP(bytes) || isOLE2(bytes)) return { valido: true };
    return {
      valido: false,
      erro: "O conteúdo do arquivo não corresponde ao tipo declarado. Apenas PDF, XLS, XLSX, DOC e DOCX são permitidos.",
    };
  } catch {
    return { valido: false, erro: "Não foi possível verificar o conteúdo do arquivo." };
  }
}

export function validarTipoArquivo(file: File): { valido: boolean; erro?: string } {
  const tiposPermitidos = [
    "application/pdf",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/zip",
    "application/octet-stream",
  ];
  const extensoesPermitidas = [".pdf", ".xls", ".xlsx", ".doc", ".docx"];
  const extensao = "." + (file.name.split(".").pop()?.toLowerCase() ?? "");

  if (!tiposPermitidos.includes(file.type) && !extensoesPermitidas.includes(extensao)) {
    return { valido: false, erro: "Tipo de arquivo não permitido. Use: PDF, XLS, XLSX, DOC ou DOCX." };
  }
  return { valido: true };
}

export function validarTamanhoArquivo(file: File, maxMb = 50): { valido: boolean; erro?: string } {
  const maxBytes = maxMb * 1024 * 1024;
  if (file.size > maxBytes) {
    return {
      valido: false,
      erro: `Arquivo muito grande. Máximo: ${maxMb} MB. Tamanho atual: ${(file.size / 1024 / 1024).toFixed(1)} MB.`,
    };
  }
  return { valido: true };
}
