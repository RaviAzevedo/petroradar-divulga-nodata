/**
 * Helpers de Download — Cloudflare R2.
 *
 * Usa streaming (passa o body do GetObject direto pra response) — não carrega
 * o arquivo inteiro em memória. Resolve o bug de OOM em arquivos grandes
 * (DFP/PPU em XLSX podem ter dezenas de MB) e o erro 502 do download anterior
 * (Vercel Blob privado + getDownloadUrl + fetch sem token).
 */

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getR2Client, getR2Bucket } from "./r2";
import type { Readable } from "node:stream";

export interface DownloadStream {
  body: ReadableStream<Uint8Array>;
  contentType: string | undefined;
  contentLength: number | undefined;
}

/**
 * Retorna stream + metadata do objeto. O caller (rota Next.js) coloca em
 * NextResponse com os headers apropriados (Content-Disposition etc.).
 *
 * Throws se o objeto não existe ou se há erro de auth.
 */
export async function streamFromR2(key: string): Promise<DownloadStream> {
  const client = getR2Client();
  const bucket = getR2Bucket();

  const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

  if (!r.Body) {
    throw new Error("R2 retornou objeto sem body");
  }

  // r.Body é um SdkStream<Readable | ReadableStream | Blob>. No runtime nodejs
  // do Next.js, é Readable. Convertemos pra Web ReadableStream pra dar de
  // body em NextResponse.
  const body = (typeof (r.Body as Readable).pipe === "function")
    ? webStreamFromNode(r.Body as Readable)
    : (r.Body as unknown as ReadableStream<Uint8Array>);

  return {
    body,
    contentType:   r.ContentType,
    contentLength: typeof r.ContentLength === "number" ? r.ContentLength : undefined,
  };
}

/** Converte Node Readable em Web ReadableStream sem buffer intermediário. */
function webStreamFromNode(node: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      node.on("data", (chunk: Buffer | Uint8Array) => {
        const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        controller.enqueue(data);
      });
      node.on("end", () => controller.close());
      node.on("error", (err) => controller.error(err));
    },
    cancel() {
      node.destroy();
    },
  });
}

/**
 * Lê um objeto inteiro como Buffer (útil quando precisa do conteúdo na memória,
 * ex.: empacotar num ZIP). Use streamFromR2 sempre que possível.
 */
export async function getR2ObjectBuffer(key: string): Promise<Buffer> {
  const client = getR2Client();
  const bucket = getR2Bucket();
  const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!r.Body) throw new Error("R2 retornou objeto sem body");

  // No nodejs runtime, transformToByteArray existe no SdkStream
  const bytes = await (r.Body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
  return Buffer.from(bytes);
}
