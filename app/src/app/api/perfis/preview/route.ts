export const runtime = "nodejs";

/**
 * POST /api/perfis/preview — PROXY fino para o BFF.
 *
 * A antiga "lógica SQL simplificada" em TypeScript foi eliminada: o motor
 * de classificação é ÚNICO e vive em Python (shared/classificacao), servido
 * pelo BFF. A resposta agora traz {count, abertas, distribuicao, sample}
 * calculados pelo motor real (não mais uma estimativa SQL divergente).
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
    const res = await fetch(`${BFF}/api/perfis/preview`, {
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
