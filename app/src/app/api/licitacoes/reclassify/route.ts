export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/licitacoes/reclassify — PROXY fino para o BFF.
 *
 * O motor de classificação é ÚNICO e vive em Python (shared/classificacao),
 * servido pelo BFF. A cópia antiga em TypeScript (first-match, divergente)
 * foi eliminada — este handler apenas encaminha a requisição.
 *
 * Por que o proxy existe: em produção o nginx já roteia esta rota direto
 * para o BFF, mas os testes de rota batem no web:3000 DIRETO. O proxy
 * garante paridade Next↔BFF: mesmo comportamento por qualquer caminho.
 * A auth continua nos guards do BFF (o cookie da sessão é encaminhado).
 */

import { NextRequest, NextResponse } from "next/server";

const BFF = process.env.BFF_INTERNAL_URL ?? "http://bff:8000";

export async function POST(request: NextRequest) {
  const body = await request.text();
  try {
    const res = await fetch(`${BFF}/api/licitacoes/reclassify`, {
      method: "POST",
      headers: {
        cookie: request.headers.get("cookie") ?? "",
        "content-type": request.headers.get("content-type") ?? "application/json",
        "x-forwarded-for": request.headers.get("x-forwarded-for") ?? "",
      },
      body,
    });
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch {
    return NextResponse.json({ error: "BFF indisponível" }, { status: 502 });
  }
}
