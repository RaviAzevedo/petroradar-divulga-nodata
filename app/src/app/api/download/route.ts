export const runtime = "nodejs";

/**
 * GET /api/download?phio=XXXXX&filename=documento.pdf
 *
 * Proxy de download dos anexos na fonte de origem. Esta versão pública não
 * inclui conector para portais externos (ver lib/fonte/anexo-fetch.ts), então
 * a rota responde 501 depois de autenticar.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireVisualizar, handleApiError } from "@/lib/api/guards";

export async function GET(_req: NextRequest) {
  try {
    await requireVisualizar();
    return NextResponse.json(
      { error: "Conector de anexos não configurado nesta instalação" },
      { status: 501 },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
