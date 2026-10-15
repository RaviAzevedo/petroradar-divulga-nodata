import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { licitacoes } from "@/db/schema";
import { sql, or, ilike, SQL } from "drizzle-orm";
import { requireVisualizar, handleApiError } from "@/lib/api/guards";

export const runtime = "nodejs";

// Flag SEARCH_TRGM (E12): "1" liga a busca acento-insensível + ranking trigram
// (migration 0018: f_unaccent + índices GIN de expressão). Default DESLIGADA =
// comportamento byte-a-byte atual (ILIKE literal, sem ORDER BY). Lida por
// request direto de process.env (sem passar por @/lib/config) para espelhar
// exatamente o os.environ.get("SEARCH_TRGM") == "1" do BFF
// (bff/app/routers/migrated/licitacoes_search.py) — as DUAS implementações
// devem decidir a flag da mesma forma.
const searchTrgmHabilitada = () => process.env.SEARCH_TRGM === "1";

// RBAC hardening (FRENTE D): busca global é leitura INTERNA → requireVisualizar
// (barra EXTERNO). Antes era requireAuth (qualquer autenticado, inclusive EXTERNO).
// Antes também buscava participações; o módulo foi removido.
export async function GET(request: NextRequest) {
  try {
    await requireVisualizar();
  } catch (e) {
    return handleApiError(e);
  }

  const q = request.nextUrl.searchParams.get("q")?.trim();
  if (!q || q.length < 2) {
    return NextResponse.json({ licitacoes: [] });
  }

  const termo = `%${q}%`;
  const trgm = searchTrgmHabilitada();

  // Flag ON: WHERE acento-insensível (f_unaccent dos DOIS lados — usa os índices
  // idx_lic_*_unaccent_trgm da 0018) + ranking primário por similaridade trigram
  // GREATEST(similarity(...)) DESC. A rota atual NÃO tem ORDER BY (ordem default
  // do banco), então não há desempate herdado a preservar — empates seguem na
  // ordem default, como hoje. Flag OFF: SQL idêntico ao de antes.
  // Nesta rota SEMPRE há termo (guarda len<2 acima) — o ranking só existe aqui.
  const licsWhere = trgm
    ? sql`(
        f_unaccent(${licitacoes.numero}) ILIKE f_unaccent(${termo}) OR
        f_unaccent(${licitacoes.objeto}) ILIKE f_unaccent(${termo}) OR
        f_unaccent(${licitacoes.empresa}) ILIKE f_unaccent(${termo})
      )`
    : or(
        ilike(licitacoes.numero, termo),
        ilike(licitacoes.objeto, termo),
        ilike(licitacoes.empresa, termo),
      );

  // similarity() recebe o termo CRU (sem %): os curingas poluiriam os trigramas.
  const licsRanking: SQL[] = trgm
    ? [
        sql`GREATEST(
          similarity(f_unaccent(${licitacoes.numero}), f_unaccent(${q})),
          similarity(f_unaccent(${licitacoes.objeto}), f_unaccent(${q})),
          similarity(f_unaccent(${licitacoes.empresa}), f_unaccent(${q}))
        ) DESC`,
      ]
    : [];

  const licsResult = await db
    .select({
      id: licitacoes.id,
      numero: licitacoes.numero,
      objeto: licitacoes.objeto,
      empresa: licitacoes.empresa,
      relevancia: licitacoes.relevancia,
    })
    .from(licitacoes)
    .where(licsWhere)
    .orderBy(...licsRanking)
    .limit(5);

  return NextResponse.json({ licitacoes: licsResult });
}
