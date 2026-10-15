/**
 * Espelho 0035 — auditoria de download de documento RESTRITO (P7/D-7).
 *
 * O `audit_log` comum tem expurgo de 12 meses; esta tabela não tem expurgo e
 * não tem FK de propósito (a linha é prova: sobrevive ao DELETE do usuário e
 * do documento). Gravada por R16 (download) e R12 (ZIP), ALÉM do audit normal.
 * Homônimo no BFF: bff/app/routers/migrated/_restrito.py.
 */

import { db } from "@/db";
import { auditDownloadRestrito, type ViaDownloadRestrito } from "@/db/schema";

export type { ViaDownloadRestrito };

/**
 * P7: download de documento restrito é espelhado FORA do expurgo de 12 meses.
 * Best-effort ANTES de streamar o corpo (00-ARQUITETURA §1.4): o CHAMADOR
 * envolve em try/catch, loga a falha e o download segue (mesma política do
 * audit LGPD de download/route.ts).
 */
export async function registrarDownloadRestrito(p: {
  documentoId: string;
  titulo: string;
  operacaoCodigo: string | null;
  userId: string;
  userEmail: string;
  role: string;
  via: ViaDownloadRestrito;
}): Promise<void> {
  await db.insert(auditDownloadRestrito).values({
    documentoId:    p.documentoId,
    titulo:         p.titulo,
    operacaoCodigo: p.operacaoCodigo,
    userId:         p.userId,
    userEmail:      p.userEmail,
    role:           p.role,
    via:            p.via,
  });
}
