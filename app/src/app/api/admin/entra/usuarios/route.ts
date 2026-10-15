export const runtime = "nodejs";

/**
 * GET /api/admin/entra/usuarios?q=<busca> — pesquisa pessoas no diretório
 * Microsoft do tenant (Graph, app-only) para o pré-cadastro do Admin Center.
 * Marca quem já está cadastrado na plataforma (jaCadastrado) p/ a UI. Falha do
 * Graph NUNCA quebra o fluxo — devolve `{error, code}` e a UI cai no manual.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { inArray } from "drizzle-orm";
import { requireAdmin, handleApiError } from "@/lib/api/guards";
import { buscarUsuariosTenant, GraphError } from "@/lib/entra/graph";

export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
  } catch (e) {
    return handleApiError(e, req);
  }

  const q = new URL(req.url).searchParams.get("q") ?? "";
  if (q.trim().length < 2) return NextResponse.json({ usuarios: [] });

  try {
    const encontrados = await buscarUsuariosTenant(q);

    // Marca os que já existem na plataforma (por e-mail) p/ a UI desabilitar.
    const emails = encontrados.map((u) => u.email).filter((e): e is string => !!e);
    const existentes = emails.length
      ? await db.select({ email: users.email }).from(users).where(inArray(users.email, emails))
      : [];
    const jaTem = new Set(existentes.map((u) => u.email));

    return NextResponse.json({
      usuarios: encontrados.map((u) => ({ ...u, jaCadastrado: !!u.email && jaTem.has(u.email) })),
    });
  } catch (e) {
    if (e instanceof GraphError) {
      // 200 com erro tipado: a busca é opcional; a UI mostra o aviso e segue.
      return NextResponse.json({ usuarios: [], error: e.message, code: e.code });
    }
    return handleApiError(e, req);
  }
}
