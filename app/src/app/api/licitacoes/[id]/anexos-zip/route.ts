export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * GET /api/licitacoes/[id]/anexos-zip — Baixa TUDO da licitação num ZIP:
 * todos os anexos (Petronect, via phio_objid) + as circulares (texto
 * consolidado cronológico + anexos das circulares). Botão "Baixar tudo (ZIP)"
 * da página da licitação — facilita a análise offline antes de propor.
 *
 * Falha em UM anexo NUNCA derruba o pacote: vira um <nome>.ERRO.txt no ZIP
 * com o motivo (padrão best-effort do produtor de texto). Teto de 150MB no
 * agregado (anexos além disso viram aviso). Web-only (JSZip + egress
 * Petronect) — exceção regex no nginx como briefing/baixar-anexos.
 */

import { NextRequest, NextResponse } from "next/server";
import JSZip from "jszip";
import { db } from "@/db";
import { licitacoes, anexos, circulares } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { requireVisualizar, handleApiError } from "@/lib/api/guards";
import { baixarAnexoFonte } from "@/lib/fonte/anexo-fetch";
import { loggerFor } from "@/lib/observability/logger";

type Params = { params: Promise<{ id: string }> };

/** Teto do agregado (soma dos binários) — evita ZIP patológico. */
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;

/**
 * Nome seguro p/ entrada de ZIP: sem path traversal/chars proibidos e SEM
 * acentos - extratores antigos do Windows leem CP437 e corrompem UTF-8 no
 * nome do arquivo (o conteudo fica intacto).
 */
function nomeSeguro(s: string): string {
  return s
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/\s+/g, " ")
    .trim().slice(0, 140) || "arquivo";
}

/** Extensão pelo content-type (fallback: mantém a do nome, senão .bin). */
function comExtensao(nome: string, contentType: string): string {
  if (/\.[a-z0-9]{2,5}$/i.test(nome)) return nome;
  const mapa: Record<string, string> = {
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "application/x-zip-compressed": ".zip",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "text/plain": ".txt",
    "image/png": ".png",
    "image/jpeg": ".jpg",
  };
  const ext = mapa[contentType.split(";")[0].trim().toLowerCase()] ?? ".bin";
  return nome + ext;
}

const fmtData = (d: Date | null) =>
  d ? d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—";

export async function GET(req: NextRequest, { params }: Params) {
  const log = loggerFor(req, { route: "/api/licitacoes/[id]/anexos-zip" });
  try {
    await requireVisualizar();
  } catch (e) {
    return handleApiError(e, req);
  }

  const { id } = await params;

  const [lic] = await db
    .select({ id: licitacoes.id, numero: licitacoes.numero, objeto: licitacoes.objetoResumido })
    .from(licitacoes)
    .where(eq(licitacoes.id, id))
    .limit(1);
  if (!lic) return NextResponse.json({ error: "Licitação não encontrada" }, { status: 404 });

  const [listaAnexos, listaCirculares] = await Promise.all([
    db
      .select({ descricao: anexos.descricao, phio: anexos.phioObjid })
      .from(anexos)
      .where(eq(anexos.licitacaoId, id))
      .orderBy(asc(anexos.descricao)),
    db
      .select({
        tipo: circulares.tipo,
        autor: circulares.autor,
        mensagem: circulares.mensagem,
        dataPublicacao: circulares.dataPublicacao,
        anexoPhio: circulares.anexoPhioObjid,
        anexoDescricao: circulares.anexoDescricao,
      })
      .from(circulares)
      .where(eq(circulares.licitacaoId, id))
      .orderBy(asc(circulares.dataPublicacao)),
  ]);

  const zip = new JSZip();
  let totalBytes = 0;
  let baixados = 0;
  let erros = 0;
  const avisos: string[] = [];

  /** Baixa um phio e adiciona ao ZIP na pasta indicada (best-effort). */
  async function adicionar(pasta: string, nomeBase: string, phio: string | null) {
    const nome = nomeSeguro(nomeBase);
    if (!phio) {
      erros++;
      zip.file(`${pasta}/${nome}.ERRO.txt`, "Anexo sem phio_objid — indisponível para download automático.");
      return;
    }
    if (totalBytes >= MAX_TOTAL_BYTES) {
      avisos.push(`${pasta}/${nome} — pulado (pacote atingiu o teto de 150MB)`);
      return;
    }
    try {
      const { bytes, contentType } = await baixarAnexoFonte(phio);
      totalBytes += bytes.byteLength;
      baixados++;
      zip.file(`${pasta}/${comExtensao(nome, contentType)}`, bytes);
    } catch (e) {
      erros++;
      const msg = e instanceof Error ? e.message : String(e);
      zip.file(`${pasta}/${nome}.ERRO.txt`, `Falha ao baixar do Petronect: ${msg}`);
      log.warn(`anexos-zip: falha em ${nome} (${phio}): ${msg}`);
    }
  }

  // ── Anexos da licitação (sequencial — mesmo ritmo gentil do produtor) ──────
  for (const [i, a] of listaAnexos.entries()) {
    await adicionar("anexos", a.descricao ?? `anexo-${i + 1}`, a.phio);
  }

  // ── Circulares: texto consolidado + anexos delas ───────────────────────────
  if (listaCirculares.length > 0) {
    const texto = listaCirculares
      .map((c, i) =>
        [
          `━━━ Circular ${String(i + 1).padStart(2, "0")} · ${c.tipo} · ${fmtData(c.dataPublicacao)}`,
          c.autor ? `Autor: ${c.autor}` : null,
          c.anexoDescricao ? `Anexo: ${c.anexoDescricao}` : null,
          "",
          c.mensagem?.trim() || "(sem texto — ver anexo)",
        ]
          .filter((l): l is string => l !== null)
          .join("\n"),
      )
      .join("\n\n");
    zip.file(
      "circulares/circulares.txt",
      `Licitação ${lic.numero} — ${listaCirculares.length} circulares (ordem cronológica)\n\n${texto}\n`,
    );

    for (const [i, c] of listaCirculares.entries()) {
      if (!c.anexoPhio) continue;
      await adicionar(
        "circulares/anexos",
        c.anexoDescricao ?? `circular-${String(i + 1).padStart(2, "0")}-anexo`,
        c.anexoPhio,
      );
    }
  }

  if (avisos.length) zip.file("AVISO-teto-150MB.txt", avisos.join("\n"));
  if (baixados === 0 && listaAnexos.length === 0 && listaCirculares.length === 0) {
    return NextResponse.json({ error: "Esta licitação não tem anexos nem circulares" }, { status: 404 });
  }

  const conteudo = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  log.info(
    `anexos-zip: ${lic.numero} — ${baixados} baixados, ${erros} erros, ${listaCirculares.length} circulares, ${Math.round(conteudo.byteLength / 1024)}KB`,
  );

  return new NextResponse(Buffer.from(conteudo), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="licitacao-${nomeSeguro(lic.numero)}-completa.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
