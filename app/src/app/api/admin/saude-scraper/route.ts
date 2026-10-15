export const runtime = "nodejs";

/**
 * GET /api/admin/saude-scraper
 *
 * Dashboard de observabilidade do scraper: snapshot por tipo de sync (última
 * execução, gap em horas vs. limite, erros) + status global. Consome
 * getSaudeScraper (lib observability/scraper-health).
 *
 * Auth: requireAdmin. Read-only.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, handleApiError } from "@/lib/api/guards";
import { getSaudeScraper } from "@/lib/observability/scraper-health";
import { loggerFor } from "@/lib/observability/logger";

export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
  } catch (e) {
    return handleApiError(e);
  }

  const log = loggerFor(req, { route: "admin/saude-scraper" });

  try {
    const saude = await getSaudeScraper();
    return NextResponse.json({ data: saude });
  } catch (e) {
    log.error("falha ao consolidar saúde do scraper", e);
    return NextResponse.json({ error: "Falha ao consolidar saúde do scraper" }, { status: 500 });
  }
}
