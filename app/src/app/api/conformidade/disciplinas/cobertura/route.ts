export const runtime = "nodejs";

/**
 * GET /api/conformidade/disciplinas/cobertura — C3: "o que temos provado, por
 *     disciplina". Uma linha por disciplina do catálogo, INCLUSIVE as com zero
 *     operações — "não temos nada provado em Telecom" é a resposta que este
 *     relatório existe para dar, e ela sumiria com INNER JOIN (§4.3).
 *
 * Query (todo recorte é explícito e volta ecoado em `filtros`):
 *  - `cliente?`: casa nome OU grupo, ILIKE com o termo escapado (um `%` cru
 *    vindo de URL compartilhável viraria filtro escondido);
 *  - `de?` / `ate?`: janela sobre o PERÍODO DA OPERAÇÃO, AAAA-MM-DD validada
 *    por calendário (`ehDataIso`) — "2020-13-01" passa em regex e o Postgres
 *    devolveria 22008, isto é, 500 no lugar de 422;
 *  - `incluirInativas?`: lido FORA do zod (`"1"`/`"true"`), default `false`.
 *
 * Resposta 200: `{ filtros, linhas: LinhaCoberturaDisciplina[], totais }`.
 * `totais.semDisciplina` e `totais.semPeriodo` existem para o número FECHAR:
 * sem eles a soma das colunas não bate com o total de obras e ninguém explica
 * a diferença (Q10.3).
 *
 * 422 (e não 400) para parâmetro inválido: é o precedente aberto na onda 2
 * §1f para parâmetro que descreve RECORTE — a tela renderiza `detalhes` campo
 * a campo, do mesmo jeito que faz com o 422 de um formulário.
 *
 * Guard: `requireConformidade` (403 COM `code`, §1j). O `role` desce até a
 * query porque `restricaoVisivel(role)` entra no ON dos documentos (ADR-05,
 * defesa em profundidade) — a contagem não pode denunciar o documento oculto.
 *
 * Sem espelho BFF: rota web-only no NGINX (§5.9).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireConformidade, handleApiError } from "@/lib/api/guards";
import { formatZodErrors } from "@/lib/conformidade/cofre/validations";
import { CoberturaQuerySchema } from "@/lib/conformidade/disciplinas/validations";
import { coberturaPorDisciplina } from "@/lib/conformidade/disciplinas/queries";

export async function GET(request: NextRequest) {
  let user: Awaited<ReturnType<typeof requireConformidade>>["user"];
  try {
    ({ user } = await requireConformidade());
  } catch (e) {
    return handleApiError(e);
  }

  const { searchParams } = new URL(request.url);

  // Flag booleana fora do zod (padrão do `semOperacao` do cofre): "1" e "true"
  // ligam, qualquer outra coisa — inclusive ausente — desliga.
  const incluirInativasRaw = searchParams.get("incluirInativas");

  const parsed = CoberturaQuerySchema.safeParse({
    cliente: searchParams.get("cliente") ?? undefined,
    de:      searchParams.get("de")      ?? undefined,
    ate:     searchParams.get("ate")     ?? undefined,
    incluirInativas: incluirInativasRaw === "1" || incluirInativasRaw === "true",
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dados inválidos", detalhes: formatZodErrors(parsed.error) },
      { status: 422 }
    );
  }

  const resposta = await coberturaPorDisciplina(parsed.data, user.role);
  return NextResponse.json(resposta);
}
