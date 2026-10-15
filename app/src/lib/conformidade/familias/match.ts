/**
 * Cálculo de Aderência — Módulo Famílias CRC
 *
 * Compara os itens de uma licitação com o catálogo de famílias ativas
 * da Proponente e calcula:
 *   - quantos itens estão cobertos
 *   - score de aderência (0..100)
 *   - quais famílias deram match
 *   - quais códigos faltam (gap analysis)
 *
 * Resultado é cacheado em `licitacoes_familias_match` (1:1 por licitação).
 */

import { db } from "@/db";
import { licitacoesFamiliasMatch } from "@/db/schema";
import { eq } from "drizzle-orm";
import { normalizarCodigoCrc } from "./validations";
import { getItensComFamiliaCadastrada } from "./queries";

export interface ResultadoMatch {
  totalItens: number;
  itensCobertos: number;
  scoreAderencia: number;
  familiasUsadas: { familiaId: string; codigoCrc: string; itensCobertos: number }[];
  familiasFaltantes: string[];
}

/**
 * Calcula aderência sem persistir.
 * Útil para previews ao vivo.
 */
export async function calcularAderencia(licitacaoId: string): Promise<ResultadoMatch> {
  const { itens, familias, aliases } = await getItensComFamiliaCadastrada(licitacaoId);

  // Mapa de código normalizado -> família
  const mapaFamilia = new Map<string, { id: string; codigoCrc: string }>();
  for (const f of familias) {
    mapaFamilia.set(f.codigoNormalizado, { id: f.id, codigoCrc: f.codigoCrc });
  }
  // Aliases também resolvem para a mesma família
  for (const a of aliases) {
    const fam = familias.find((f) => f.id === a.familiaId);
    if (fam) {
      mapaFamilia.set(a.codigoAlternativoNormalizado, {
        id: fam.id,
        codigoCrc: fam.codigoCrc,
      });
    }
  }

  const contadorPorFamilia = new Map<string, { codigoCrc: string; itensCobertos: number }>();
  const codigosFaltantes = new Set<string>();
  let itensCobertos = 0;

  for (const item of itens) {
    if (!item.familia) continue;
    const codigoNorm = normalizarCodigoCrc(item.familia);

    const match = mapaFamilia.get(codigoNorm);
    if (match) {
      itensCobertos++;
      const atual = contadorPorFamilia.get(match.id);
      if (atual) {
        atual.itensCobertos++;
      } else {
        contadorPorFamilia.set(match.id, {
          codigoCrc: match.codigoCrc,
          itensCobertos: 1,
        });
      }
    } else {
      codigosFaltantes.add(item.familia);
    }
  }

  const totalItens = itens.length;
  const scoreAderencia = totalItens > 0 ? (itensCobertos / totalItens) * 100 : 0;

  return {
    totalItens,
    itensCobertos,
    scoreAderencia: Math.round(scoreAderencia * 100) / 100,
    familiasUsadas: Array.from(contadorPorFamilia.entries()).map(([familiaId, info]) => ({
      familiaId,
      codigoCrc: info.codigoCrc,
      itensCobertos: info.itensCobertos,
    })),
    familiasFaltantes: Array.from(codigosFaltantes).slice(0, 50),
  };
}

/**
 * Calcula e persiste no cache (`licitacoes_familias_match`).
 * Sobrescreve cache existente.
 */
export async function calcularEPersistirAderencia(licitacaoId: string): Promise<ResultadoMatch> {
  const resultado = await calcularAderencia(licitacaoId);

  const existente = await db
    .select({ id: licitacoesFamiliasMatch.id })
    .from(licitacoesFamiliasMatch)
    .where(eq(licitacoesFamiliasMatch.licitacaoId, licitacaoId))
    .limit(1);

  if (existente.length > 0) {
    await db
      .update(licitacoesFamiliasMatch)
      .set({
        totalItens:        resultado.totalItens,
        itensCobertos:     resultado.itensCobertos,
        scoreAderencia:    resultado.scoreAderencia,
        familiasUsadas:    resultado.familiasUsadas,
        familiasFaltantes: resultado.familiasFaltantes,
        calculadoEm:       new Date(),
      })
      .where(eq(licitacoesFamiliasMatch.licitacaoId, licitacaoId));
  } else {
    await db.insert(licitacoesFamiliasMatch).values({
      licitacaoId,
      totalItens:        resultado.totalItens,
      itensCobertos:     resultado.itensCobertos,
      scoreAderencia:    resultado.scoreAderencia,
      familiasUsadas:    resultado.familiasUsadas,
      familiasFaltantes: resultado.familiasFaltantes,
    });
  }

  return resultado;
}

/**
 * Categoriza um score numérico em uma faixa qualitativa.
 */
function classificarScore(score: number): {
  faixa: "ALTA" | "MEDIA" | "BAIXA" | "NENHUMA";
  cor: string;
  label: string;
} {
  if (score >= 80) return { faixa: "ALTA",    cor: "text-green-700 bg-green-50 border-green-200",  label: "Alta aderência" };
  if (score >= 50) return { faixa: "MEDIA",   cor: "text-amber-700 bg-amber-50 border-amber-200",  label: "Média aderência" };
  if (score >= 20) return { faixa: "BAIXA",   cor: "text-orange-700 bg-orange-50 border-orange-200", label: "Baixa aderência" };
  return                { faixa: "NENHUMA", cor: "text-gray-500 bg-gray-50 border-gray-200",     label: "Sem cobertura" };
}
