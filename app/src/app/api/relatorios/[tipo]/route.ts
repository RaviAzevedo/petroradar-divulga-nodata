export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * GET /api/relatorios/[tipo]?formato=xlsx|pdf&periodo=12
 *
 * Handler ÚNICO dos relatórios: resolve o slug contra o registry, aplica o
 * guard declarado pelo relatório, gera o arquivo e devolve o download. Hoje
 * serve o relatório do acervo (curriculo-rt);
 * o hub /relatorios e seus 8 relatórios gerenciais foram removidos.
 *
 * Todos os relatórios são web-only (exceljs/pdf-lib no Next) — o strangler roteia
 * o prefixo /api/relatorios/ para petro_web; o BFF não registra estas rotas.
 *
 * A query string inteira vai a `def.gerar` como terceiro argumento: relatório
 * parametrizado (ex.: `curriculo-rt`, com o id do profissional) lê o
 * que precisa dali; os demais a ignoram. Parâmetro inválido nesse caso sobe
 * como `ApiError(422, "VALIDATION", …)` e sai pelo `handleApiError` — não é o
 * 500 genérico de "falha ao gerar".
 */

import { NextRequest, NextResponse } from "next/server";
import { ApiError, handleApiError } from "@/lib/api/guards";
import { loggerFor } from "@/lib/observability/logger";
import { getRelatorio, type Formato } from "@/lib/relatorios/registry";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ tipo: string }> },
) {
  const { tipo } = await params;
  const def = getRelatorio(tipo);
  if (!def) {
    return NextResponse.json({ error: "Relatório não encontrado" }, { status: 404 });
  }

  try {
    await def.guard();
  } catch (e) {
    return handleApiError(e);
  }

  const log = loggerFor(req, { route: `relatorios/${def.slug}` });
  const url = new URL(req.url);
  let formato = (url.searchParams.get("formato") ?? "xlsx").toLowerCase() as Formato;
  if (!def.formatos.includes(formato)) formato = def.formatos[0]; // ex.: pediu pdf mas só há xlsx
  const periodoRaw = Number(url.searchParams.get("periodo") ?? "12");
  const periodoMeses = Number.isFinite(periodoRaw) && periodoRaw > 0 ? Math.min(periodoRaw, 60) : 12;

  let arquivo;
  try {
    arquivo = await def.gerar(periodoMeses, formato, url.searchParams);
  } catch (e) {
    // Parâmetro inválido de relatório parametrizado: 422 { error, code } — o
    // mesmo canal de `app/api/acervo/buscar`; só o inesperado vira 500 logado.
    if (e instanceof ApiError) return handleApiError(e);
    log.error("falha ao gerar relatório", e);
    return NextResponse.json({ error: "Falha ao gerar o relatório" }, { status: 500 });
  }

  const dataSlug = new Date().toISOString().slice(0, 10);
  return new NextResponse(new Uint8Array(arquivo.buffer), {
    headers: {
      "Content-Type":        arquivo.contentType,
      // `arquivo.nome ?? …`: relatório que não passa o campo sai com o nome
      // padrão por slug e data.
      "Content-Disposition": `attachment; filename="${arquivo.nome ?? `relatorio-${def.slug}-${dataSlug}`}.${arquivo.ext}"`,
      "Cache-Control":       "no-store",
    },
  });
}
