/**
 * Cobertura de famílias CRC por licitação — o sinal "Habilitamos?".
 *
 * MÓDULO CANÔNICO. A lógica nasceu embutida em
 * `app/src/app/api/licitacoes/route.ts` (o `habMap` que alimenta a coluna
 * "Habilitamos?" do Explorar) e foi extraída aqui para poder ser usada também no
 * digest de e-mail — sem uma segunda cópia da SQL, que é como sinais assim
 * começam a divergir entre a tela e o e-mail.
 *
 * CÓPIAS QUE EXISTEM E PRECISAM ACOMPANHAR (não dá para importar):
 *   - `app/src/app/api/licitacoes/route.ts:85-122` — a rota do Explorar ainda tem
 *     a sua. Refatorar para chamar daqui ficou para um PR próprio: é a tela mais
 *     usada do produto e não vale arrastar junto com uma feature de e-mail.
 *   - `bff/app/routers/migrated/licitacoes_list.py:253-299` — espelho em Python,
 *     idêntico (mesmo CASE, mesma normalização, mesmo default SEM_ITENS).
 *
 * REGRA: cruza `itens.familia` com as famílias **ATIVAS e não deletadas**,
 * normalizando os dois lados (maiúsculas, só A-Z0-9) — é a mesma normalização de
 * `normalizarCodigoCrc`, porque o código vem do portal com pontuação instável.
 */

import { db } from "@/db";
import { sql } from "drizzle-orm";

/** Os quatro estados possíveis. Espelha `_HABILITACOES` em tests/e2e/licitacoes_api.py. */
export type CoberturaCrc = "SEM_ITENS" | "COBERTO" | "PARCIAL" | "NENHUM";

/**
 * Cobertura por licitação, para um conjunto de ids.
 *
 * Licitação **sem nenhum item** não aparece no GROUP BY e por isso não entra no
 * Map — quem chama resolve o ausente como `SEM_ITENS`. Isso é deliberado: não
 * saber é diferente de não cobrir, e o e-mail precisa dizer coisas diferentes
 * nos dois casos.
 */
export async function coberturaCrcPorLicitacao(
  ids: string[],
): Promise<Map<string, CoberturaCrc>> {
  const mapa = new Map<string, CoberturaCrc>();
  if (ids.length === 0) return mapa;

  const res = await db.execute(sql`
    SELECT i.licitacao_id AS id,
      CASE
        WHEN COUNT(*) FILTER (WHERE i.familia IS NOT NULL AND i.familia <> '') = 0 THEN 'SEM_ITENS'
        WHEN COUNT(*) FILTER (WHERE m.ok) = COUNT(*) FILTER (WHERE i.familia IS NOT NULL AND i.familia <> '') THEN 'COBERTO'
        WHEN COUNT(*) FILTER (WHERE m.ok) = 0 THEN 'NENHUM'
        ELSE 'PARCIAL'
      END AS habilitacao
    FROM itens i
    LEFT JOIN LATERAL (
      SELECT EXISTS(
        SELECT 1 FROM familias f
        WHERE f.status = 'ATIVA'
          AND f.deletado_em IS NULL
          AND regexp_replace(upper(f.codigo_crc), '[^A-Z0-9]', '', 'g') = regexp_replace(upper(i.familia), '[^A-Z0-9]', '', 'g')
      ) AS ok
    ) m ON true
    WHERE i.licitacao_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    GROUP BY i.licitacao_id
  `);

  const linhas = (Array.isArray(res)
    ? res
    : (res as { rows?: unknown[] }).rows ?? []) as { id: string; habilitacao: CoberturaCrc }[];
  for (const l of linhas) mapa.set(l.id, l.habilitacao);
  return mapa;
}

/** Quantas famílias CRC ativas a Proponente tem — contexto do rodapé do e-mail. */
export async function contarFamiliasAtivas(): Promise<number> {
  const res = await db.execute(sql`
    SELECT count(*)::int AS n FROM familias WHERE status = 'ATIVA' AND deletado_em IS NULL
  `);
  const linhas = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows ?? []) as { n: number }[];
  return Number(linhas[0]?.n ?? 0);
}
