/**
 * Construtor do WHERE de `licitacoes` — compartilhado entre a listagem
 * (`/api/licitacoes`) e o export (`/api/licitacoes/export`).
 *
 * Extraído de `app/api/licitacoes/route.ts` em 2026-08-05 SEM mudança de
 * comportamento: mesmas condições, mesma ordem, mesma semântica.
 *
 * Motivo: o export ignorava os 18 filtros que `/explorar` monta na URL — o
 * usuário filtrava a tela, clicava em "Exportar" e levava a base inteira achando
 * que levava a seleção (auditoria de produção de 2026-08-05). Com um único
 * construtor, filtrar e exportar concordam por construção.
 */
import { licitacoes } from "@/db/schema";
import { sql, eq, and, or, ilike, gte, type SQL } from "drizzle-orm";

export function construirFiltrosLicitacoes(searchParams: URLSearchParams): SQL[] {
  const conditions: SQL[] = [];

  const search = searchParams.get("search") ?? "";
  const empresa = searchParams.get("empresa") ?? "";
  const fonteFiltro = searchParams.get("fonte") ?? "";

  const relevancia = searchParams.get("relevancia")?.split(",").filter(Boolean) ?? [];
  const natureza   = searchParams.get("natureza")?.split(",").filter(Boolean) ?? [];
  const fase       = searchParams.get("fase")?.split(",").filter(Boolean) ?? [];
  const segmento   = searchParams.get("segmento")?.split(",").filter(Boolean) ?? [];

  const scoreMin    = Math.max(0, parseInt(searchParams.get("score_min") ?? "0") || 0);
  const estado      = searchParams.get("estado") ?? "";
  const abrangencia = searchParams.get("abrangencia") ?? "";
  const perfil      = searchParams.get("perfil") ?? "";

  const dataFimDe  = searchParams.get("data_fim_de") ?? "";
  const dataFimAte = searchParams.get("data_fim_ate") ?? "";
  const dataPubDe    = searchParams.get("data_pub_de")    ?? "";
  const dataPubAte   = searchParams.get("data_pub_ate")   ?? "";
  const dataInicioDe = searchParams.get("data_inicio_de") ?? "";
  const dataInicioAte= searchParams.get("data_inicio_ate")?? "";

  const prazo = searchParams.get("prazo") ?? "";

  if (search) {
    conditions.push(
      or(
        ilike(licitacoes.objeto, `%${search}%`),
        ilike(licitacoes.numero, `%${search}%`),
        ilike(licitacoes.regioes, `%${search}%`),
        ilike(licitacoes.empresa, `%${search}%`),
      )!
    );
  }

  if (empresa) {
    conditions.push(ilike(licitacoes.empresa, `%${empresa}%`));
  }

  // Fonte da licitação: petronect (scraper nativo) | transparencia (descoberta)
  if (fonteFiltro) {
    conditions.push(eq(licitacoes.fonte, fonteFiltro));
  }

  if (relevancia.length > 0) {
    conditions.push(sql`${licitacoes.relevancia} IN (${sql.join(relevancia.map(r => sql`${r}`), sql`, `)})`);
  }

  if (natureza.length > 0) {
    conditions.push(sql`${licitacoes.natureza} IN (${sql.join(natureza.map(n => sql`${n}`), sql`, `)})`);
  }

  if (fase.length > 0) {
    conditions.push(sql`${licitacoes.fase} IN (${sql.join(fase.map(f => sql`${f}`), sql`, `)})`);
  }

  if (segmento.length > 0) {
    conditions.push(sql`${licitacoes.segmento} IN (${sql.join(segmento.map(s => sql`${s}`), sql`, `)})`);
  }

  // Score mínimo de interesse (0..100)
  if (scoreMin > 0) {
    conditions.push(gte(licitacoes.scoreInteresse, scoreMin));
  }

  // Estado/UF de atuação — regioes é uma lista textual de estados (ILIKE parcial)
  if (estado) {
    conditions.push(ilike(licitacoes.regioes, `%${estado}%`));
  }

  // Abrangência: 'N'/'Nacional' ou 'I'/'Internacional' (frontend envia o prefixo)
  if (abrangencia) {
    conditions.push(ilike(licitacoes.abrangencia, `${abrangencia}%`));
  }

  // Perfil de interesse — perfis_match é lista textual de perfis (ILIKE parcial)
  if (perfil) {
    conditions.push(ilike(licitacoes.perfisMatch, `%${perfil}%`));
  }

  // Prazo rápido (tem prioridade sobre datas manuais)
  if (prazo === "hoje") {
    conditions.push(
      and(
        sql`${licitacoes.dataFim} != ''`,
        sql`${licitacoes.dataFim} IS NOT NULL`,
        sql`${licitacoes.dataFim} = CURRENT_DATE::text`,
      )!
    );
  } else if (prazo === "7d") {
    conditions.push(
      and(
        sql`${licitacoes.dataFim} != ''`,
        sql`${licitacoes.dataFim} IS NOT NULL`,
        sql`${licitacoes.dataFim} >= CURRENT_DATE::text`,
        sql`${licitacoes.dataFim} <= (CURRENT_DATE + INTERVAL '7 days')::text`,
      )!
    );
  } else if (prazo === "30d") {
    conditions.push(
      and(
        sql`${licitacoes.dataFim} != ''`,
        sql`${licitacoes.dataFim} IS NOT NULL`,
        sql`${licitacoes.dataFim} >= CURRENT_DATE::text`,
        sql`${licitacoes.dataFim} <= (CURRENT_DATE + INTERVAL '30 days')::text`,
      )!
    );
  } else if (prazo === "vencidas") {
    conditions.push(
      and(
        sql`${licitacoes.dataFim} != ''`,
        sql`${licitacoes.dataFim} IS NOT NULL`,
        sql`${licitacoes.dataFim} < CURRENT_DATE::text`,
      )!
    );
  } else {
    // Datas manuais
    if (dataFimDe) {
      conditions.push(
        and(
          sql`${licitacoes.dataFim} IS NOT NULL`,
          sql`${licitacoes.dataFim} != ''`,
          sql`${licitacoes.dataFim} >= ${dataFimDe}`,
        )!
      );
    }
    if (dataFimAte) {
      conditions.push(
        and(
          sql`${licitacoes.dataFim} IS NOT NULL`,
          sql`${licitacoes.dataFim} != ''`,
          sql`${licitacoes.dataFim} <= ${dataFimAte}`,
        )!
      );
    }
  }

  // Filtro por data de início do período de cotação
  if (dataInicioDe) {
    conditions.push(
      and(
        sql`${licitacoes.dataInicio} IS NOT NULL`,
        sql`${licitacoes.dataInicio} != ''`,
        sql`${licitacoes.dataInicio} >= ${dataInicioDe}`,
      )!
    );
  }
  if (dataInicioAte) {
    conditions.push(
      and(
        sql`${licitacoes.dataInicio} IS NOT NULL`,
        sql`${licitacoes.dataInicio} != ''`,
        sql`${licitacoes.dataInicio} <= ${dataInicioAte}`,
      )!
    );
  }

  // Filtro por data de publicação
  if (dataPubDe) {
    conditions.push(
      and(
        sql`${licitacoes.dataPublicacao} IS NOT NULL`,
        sql`${licitacoes.dataPublicacao} != ''`,
        sql`${licitacoes.dataPublicacao} >= ${dataPubDe}`,
      )!
    );
  }
  if (dataPubAte) {
    conditions.push(
      and(
        sql`${licitacoes.dataPublicacao} IS NOT NULL`,
        sql`${licitacoes.dataPublicacao} != ''`,
        sql`${licitacoes.dataPublicacao} <= ${dataPubAte}`,
      )!
    );
  }

  if (searchParams.get("novas") === "1") {
    conditions.push(sql`${licitacoes.criadoEm} >= NOW() - INTERVAL '24 hours'`);
  }

  if (searchParams.get("com_circulares") === "1") {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM circulares WHERE circulares.licitacao_id = ${licitacoes.id})`
    );
  }

  return conditions;
}
