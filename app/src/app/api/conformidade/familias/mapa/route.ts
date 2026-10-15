export const runtime = "nodejs";

/**
 * GET /api/conformidade/familias/mapa — o mercado observado cruzado com o cadastro.
 *
 * A rota irmã (`../route.ts`) lista o NOSSO CADASTRO de famílias. Esta lista o
 * MAPA: o cadastro em FULL OUTER JOIN com o catálogo de famílias que apareceram
 * nas licitações coletadas (migração 0040).
 *
 * A diferença é o ponto: a listagem de cadastro não consegue mostrar uma família
 * exigida com frequência nas licitações da base e que não está cadastrada —
 * justamente a que explica uma decisão de não participar.
 *
 * Somente leitura. O catálogo é derivado (reconstruído a cada `make migrate`) e
 * não tem writer humano — por isso não há POST/PATCH aqui.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireVisualizar, handleApiError } from "@/lib/api/guards";
import { mapaFamilias, resumirMapa, type Quadrante } from "@/lib/conformidade/familias/mapa";

const SEGMENTOS = ["MATERIAL", "SERVICO", "OUTRO"] as const;
const QUADRANTES = [
  "NUCLEO", "RISCO", "OPORTUNIDADE", "FORA_DE_ALCANCE", "A_APURAR",
] as const;

/** Lista separada por vírgula → array validado; string vazia vira undefined. */
const listaDe = <T extends readonly [string, ...string[]]>(vals: T) =>
  z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(vals)).nonempty().optional());

const FiltrosMapaSchema = z.object({
  // Default SERVICO no schema, não só na query: a maior parte das famílias do
  // catálogo é MATERIAL (válvula, transmissor), fora do foco de uma prestadora
  // de serviços. Sem esse default a primeira coisa que a tela mostra é ruído.
  segmento:       listaDe(SEGMENTOS),
  quadrante:      listaDe(QUADRANTES),
  demandaMinima:  z.coerce.number().int().min(0).max(1000).optional(),
  desde:          z.coerce.number().int().min(1990).max(2100).optional(),
  somenteComNome: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
  revisao:        z.enum(["PENDENTE", "REVISADA"]).optional(),
  busca:          z.string().trim().max(120).optional(),
  limite:         z.coerce.number().int().min(1).max(2000).optional(),
});

export async function GET(request: NextRequest) {
  try {
    await requireVisualizar();
  } catch (e) {
    return handleApiError(e);
  }

  const { searchParams } = new URL(request.url);
  const parsed = FiltrosMapaSchema.safeParse({
    segmento:       searchParams.get("segmento")       ?? undefined,
    quadrante:      searchParams.get("quadrante")      ?? undefined,
    demandaMinima:  searchParams.get("demandaMinima")  ?? undefined,
    desde:          searchParams.get("desde")          ?? undefined,
    somenteComNome: searchParams.get("somenteComNome") ?? undefined,
    revisao:        searchParams.get("revisao")        ?? undefined,
    busca:          searchParams.get("busca")          ?? undefined,
    limite:         searchParams.get("limite")         ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { code: "VALIDACAO", error: "Filtros inválidos", campos: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }

  try {
    const linhas = await mapaFamilias({
      segmento:       parsed.data.segmento,
      quadrante:      parsed.data.quadrante as Quadrante[] | undefined,
      demandaMinima:  parsed.data.demandaMinima,
      desde:          parsed.data.desde,
      somenteComNome: parsed.data.somenteComNome,
      revisao:        parsed.data.revisao,
      busca:          parsed.data.busca,
      limite:         parsed.data.limite,
    });

    // Aviso de truncamento: se voltou exatamente o teto, provavelmente cortou.
    // Sem isto a tela mostra uma lista completa que nao e completa.
    const teto = parsed.data.limite ?? 1000;
    return NextResponse.json({
      linhas,
      truncado: linhas.length >= teto,
      resumo: resumirMapa(linhas),
      // A tela PRECISA dizer isto ao usuário, não só o código: o catálogo é o
      // mercado que nós observamos, não o catálogo oficial da Petrobras. Há
      // famílias cadastradas que não aparecem em licitação nenhuma da base —
      // existem, só nunca foram exigidas no que foi coletado.
      ressalva: {
        catalogoParcial: true,
        texto:
          "Demanda observada nas licitações coletadas pelo Petro Radar — não é o " +
          "catálogo oficial da Petrobras. Ausência aqui não significa que a família não existe.",
        provaIndisponivel: false,
        textoProva:
          "INDÍCIO é apontamento da máquina sobre o texto do acervo, ainda sem " +
          "revisão humana — não sustenta um NO-GO. Só uma parte das famílias do " +
          "catálogo já entrou no vocabulário da classificação; as demais " +
          "aparecem como 'a apurar', que é ninguém ter perguntado " +
          "por elas — diferente de não termos.",
      },
    });
  } catch (e) {
    return handleApiError(e);
  }
}
