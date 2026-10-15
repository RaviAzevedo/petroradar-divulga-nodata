/**
 * Cliente Cloudflare R2 (S3-compatible).
 *
 * Usa @aws-sdk/client-s3 contra o endpoint R2 da conta Proponente.
 * Egress GRÁTIS, 10 GB de storage incluso no plano Forever Free.
 *
 * Env vars necessárias:
 *   R2_ENDPOINT           — Endpoint S3 explícito (on-prem MinIO: http://minio:9000).
 *                           Alias aceito: S3_ENDPOINT. Se setado, R2_ACCOUNT_ID é dispensável.
 *   R2_ACCOUNT_ID         — ID da conta Cloudflare (32 chars hex). Só usado para
 *                           derivar o endpoint quando R2_ENDPOINT/S3_ENDPOINT ausentes.
 *   R2_ACCESS_KEY_ID      — Access Key (R2 API Tokens ou credencial MinIO)
 *   R2_SECRET_ACCESS_KEY  — Secret correspondente
 *   R2_BUCKET             — Nome do bucket (ex.: "petro-radar")
 */

import { S3Client } from "@aws-sdk/client-s3";

let _client: S3Client | null = null;

/**
 * Resolve o endpoint S3 alvo. Prioridade:
 *   1. R2_ENDPOINT (ou S3_ENDPOINT) explícito (on-prem: http://minio:9000)
 *   2. derivado de R2_ACCOUNT_ID (nuvem Cloudflare R2)
 * Mantém paridade com a produção em nuvem (sem endpoint explícito, comporta-se igual).
 */
function resolveEndpoint(): string {
  // Aceita R2_ENDPOINT ou o alias genérico S3_ENDPOINT (compatibilidade MinIO/S3).
  const explicit = process.env.R2_ENDPOINT ?? process.env.S3_ENDPOINT;
  if (explicit) return explicit;
  const accountId = process.env.R2_ACCOUNT_ID;
  if (!accountId) {
    throw new Error(
      "Storage não configurado: defina R2_ENDPOINT (on-prem, ex.: http://minio:9000) " +
        "ou R2_ACCOUNT_ID (Cloudflare R2)",
    );
  }
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

export function getR2Client(): S3Client {
  if (_client) return _client;

  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  // R2_ACCOUNT_ID NÃO é mais exigido aqui: o endpoint vem de resolveEndpoint()
  // (R2_ENDPOINT/S3_ENDPOINT no on-prem, ou derivado do account-id na nuvem).
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "Storage não configurado: setar R2_ACCESS_KEY_ID e R2_SECRET_ACCESS_KEY",
    );
  }

  _client = new S3Client({
    region: "auto",
    endpoint: resolveEndpoint(),
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true, // MinIO EXIGE path-style; R2 também aceita
  });

  return _client;
}

export function getR2Bucket(): string {
  const b = process.env.R2_BUCKET;
  if (!b) throw new Error("R2_BUCKET não configurado");
  return b;
}

/**
 * Constrói uma URL S3 canônica pro objeto (pra armazenar no banco como referência).
 * NÃO é uma URL pública — só funciona com Authorization header.
 * O app sempre serve via proxy autenticado.
 *
 * Usa o endpoint resolvido (path-style), então on-prem vira
 * http://minio:9000/<bucket>/<key>; na nuvem permanece a URL R2 da conta.
 */
export function getR2ObjectUrl(key: string): string {
  const bucket = getR2Bucket();
  return `${resolveEndpoint()}/${bucket}/${key}`;
}
