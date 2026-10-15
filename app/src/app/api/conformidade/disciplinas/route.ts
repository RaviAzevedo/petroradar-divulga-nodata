export const runtime = "nodejs";

/**
 * GET /api/conformidade/disciplinas — O catálogo de disciplinas (B1, migration
 *     0043). É o que popula o `<select>` do cofre, o modal da ficha (D3) e o
 *     filtro da tela de operações.
 *
 * Query:
 *  - `ativas?`: lido FORA do zod (padrão do `semOperacao` do cofre e do
 *    `comProva` de R1): `"0"`/`"false"` desligam; ausente ou qualquer outro
 *    valor cai no default `true`.
 *
 * Resposta 200: `{ disciplinas: DisciplinaCatalogo[], filtros: { ativas } }`.
 * O eco de `filtros` não é enfeite: o default É um corte (o catálogo tem
 * linhas `ativo = false`) e corte que não aparece é corte escondido (Q10.3) —
 * quem vê a lista sabe que está vendo só as ativas.
 *
 * Guard: `requireConformidade` (403 COM `code`) — spec ONDA-4 §1j: o catálogo
 * é o vocabulário do acervo e fica no mesmo piso das demais rotas desta onda.
 *
 * Sem espelho BFF: rota web-only no NGINX (§5.9); a dívida está registrada em
 * §10 — nenhum código de disciplina é hard-coded em TS nem em Python (§1g).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireConformidade, handleApiError } from "@/lib/api/guards";
import { FiltrosDisciplinaSchema } from "@/lib/conformidade/disciplinas/validations";
import { listDisciplinas } from "@/lib/conformidade/disciplinas/queries";

export async function GET(request: NextRequest) {
  try {
    await requireConformidade();
  } catch (e) {
    return handleApiError(e);
  }

  const { searchParams } = new URL(request.url);

  // O valor passa pelo `FiltrosDisciplinaSchema` de propósito, mesmo sendo
  // lido fora do zod: assim o default `true` mora num lugar só — o schema que
  // o teste de §8.4 trava —, em vez de ser reescrito aqui e divergir amanhã.
  const bruto = searchParams.get("ativas");
  const { ativas } = FiltrosDisciplinaSchema.parse(
    bruto === null ? {} : { ativas: !(bruto === "0" || bruto === "false") }
  );

  const catalogo = await listDisciplinas(ativas);

  return NextResponse.json({ disciplinas: catalogo, filtros: { ativas } });
}
