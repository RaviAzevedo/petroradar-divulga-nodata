/**
 * Queries Reutilizáveis — Módulo Famílias CRC
 */

import { db } from "@/db";
import {
  familias,
  familiasAliases,
  familiasAnexos,
  licitacoesFamiliasMatch,
  itens,
  users,
  type Familia,
  type StatusFamilia,
} from "@/db/schema";
import { eq, and, or, ilike, isNull, desc, asc, count, lt, gte, type SQL } from "drizzle-orm";
import type { FiltrosFamiliaInput } from "./validations";

// ── Tipos compostos ──────────────────────────────────────────────────────────

type FamiliaListItem = Familia & {
  totalAliases: number;
  totalAnexos: number;
  totalDocumentos: number;
  itensCobertos: number;
  criadoPorNome: string | null;
};

// ── Buscar por ID ────────────────────────────────────────────────────────────

export async function getFamiliaById(id: string): Promise<Familia | null> {
  const [row] = await db
    .select()
    .from(familias)
    .where(and(eq(familias.id, id), isNull(familias.deletadoEm)))
    .limit(1);
  return row ?? null;
}

async function getFamiliaByCodigoNormalizado(codigoNormalizado: string): Promise<Familia | null> {
  const [row] = await db
    .select()
    .from(familias)
    .where(
      and(
        eq(familias.codigoNormalizado, codigoNormalizado),
        isNull(familias.deletadoEm)
      )
    )
    .limit(1);
  return row ?? null;
}

// ── Listagem com filtros ─────────────────────────────────────────────────────

export async function listFamilias(filtros: FiltrosFamiliaInput) {
  const conditions: SQL[] = [isNull(familias.deletadoEm)];

  if (filtros.status) {
    conditions.push(eq(familias.status, filtros.status));
  }

  if (filtros.statusFluxoCrc) {
    conditions.push(eq(familias.statusFluxoCrc, filtros.statusFluxoCrc));
  }

  if (filtros.segmentoPetrobras) {
    conditions.push(eq(familias.segmentoPetrobras, filtros.segmentoPetrobras));
  }

  if (filtros.nivel) {
    conditions.push(eq(familias.nivel, filtros.nivel));
  }

  if (filtros.parentId) {
    conditions.push(eq(familias.parentId, filtros.parentId));
  }

  if (filtros.busca) {
    const termo = `%${filtros.busca}%`;
    conditions.push(
      or(
        ilike(familias.codigoCrc, termo),
        ilike(familias.nome, termo),
        ilike(familias.descricao, termo)
      )!
    );
  }

  if (filtros.vencendoEm) {
    const limite = new Date();
    limite.setDate(limite.getDate() + filtros.vencendoEm);
    conditions.push(
      and(
        gte(familias.validadeFim, new Date()),
        lt(familias.validadeFim, limite)
      )!
    );
  }

  const where = and(...conditions);

  const orderCol =
    filtros.order === "nome" ? familias.nome :
    filtros.order === "status" ? familias.status :
    filtros.order === "validade" ? familias.validadeFim :
    filtros.order === "criado_em" ? familias.criadoEm :
    familias.codigoCrc;

  const orderFn = filtros.dir === "desc" ? desc : asc;
  const offset = (filtros.page - 1) * filtros.limit;

  const [rows, [totalRow]] = await Promise.all([
    db
      .select()
      .from(familias)
      .where(where)
      .orderBy(orderFn(orderCol))
      .limit(filtros.limit)
      .offset(offset),

    db.select({ total: count() }).from(familias).where(where),
  ]);

  return {
    data: rows,
    total: totalRow?.total ?? 0,
    page: filtros.page,
    limit: filtros.limit,
    pages: Math.ceil((totalRow?.total ?? 0) / filtros.limit),
  };
}

// ── Aliases ──────────────────────────────────────────────────────────────────

export async function getAliasesByFamilia(familiaId: string) {
  return db
    .select()
    .from(familiasAliases)
    .where(eq(familiasAliases.familiaId, familiaId))
    .orderBy(desc(familiasAliases.criadoEm));
}

// ── Anexos ───────────────────────────────────────────────────────────────────

export async function getAnexosByFamilia(familiaId: string) {
  return db
    .select({
      id:           familiasAnexos.id,
      familiaId:    familiasAnexos.familiaId,
      tipo:         familiasAnexos.tipo,
      nomeArquivo:  familiasAnexos.nomeArquivo,
      blobUrl:      familiasAnexos.blobUrl,
      blobKey:      familiasAnexos.blobKey,
      tamanhoBytes: familiasAnexos.tamanhoBytes,
      contentType:  familiasAnexos.contentType,
      validadeFim:  familiasAnexos.validadeFim,
      uploadadoPor: familiasAnexos.uploadadoPor,
      uploadadoPorNome: users.nome,
      criadoEm:     familiasAnexos.criadoEm,
    })
    .from(familiasAnexos)
    .leftJoin(users, eq(familiasAnexos.uploadadoPor, users.id))
    .where(eq(familiasAnexos.familiaId, familiaId))
    .orderBy(desc(familiasAnexos.criadoEm));
}

// ── Métricas ─────────────────────────────────────────────────────────────────

async function getMetricasFamilias() {
  const [porStatus, total, vencendo] = await Promise.all([
    db
      .select({
        status: familias.status,
        total: count(),
      })
      .from(familias)
      .where(isNull(familias.deletadoEm))
      .groupBy(familias.status),

    db
      .select({ total: count() })
      .from(familias)
      .where(isNull(familias.deletadoEm)),

    // Vencendo nos próximos 60 dias
    (async () => {
      const limite = new Date();
      limite.setDate(limite.getDate() + 60);
      const [row] = await db
        .select({ total: count() })
        .from(familias)
        .where(
          and(
            isNull(familias.deletadoEm),
            gte(familias.validadeFim, new Date()),
            lt(familias.validadeFim, limite)
          )
        );
      return row?.total ?? 0;
    })(),
  ]);

  const mapaStatus = {} as Record<StatusFamilia, number>;
  for (const r of porStatus) {
    mapaStatus[r.status as StatusFamilia] = r.total;
  }

  return {
    total: total[0]?.total ?? 0,
    porStatus: mapaStatus,
    vencendoEm60Dias: vencendo,
  };
}

// ── Match com licitação (cache) ──────────────────────────────────────────────

async function getMatchByLicitacao(licitacaoId: string) {
  const [row] = await db
    .select()
    .from(licitacoesFamiliasMatch)
    .where(eq(licitacoesFamiliasMatch.licitacaoId, licitacaoId))
    .limit(1);
  return row ?? null;
}

// ── Itens de uma licitação cobertos por famílias da Proponente ────────────────

export async function getItensComFamiliaCadastrada(licitacaoId: string) {
  // Busca todos os itens da licitação e cruza com famílias cadastradas (status ATIVA)
  // via codigoNormalizado. Implementação direta sem cache.
  const itensLic = await db
    .select({
      id:        itens.id,
      familia:   itens.familia,
      descricao: itens.descricao,
    })
    .from(itens)
    .where(eq(itens.licitacaoId, licitacaoId));

  const familiasAtivas = await db
    .select({
      id:                familias.id,
      codigoCrc:         familias.codigoCrc,
      codigoNormalizado: familias.codigoNormalizado,
      nome:              familias.nome,
    })
    .from(familias)
    .where(
      and(
        isNull(familias.deletadoEm),
        eq(familias.status, "ATIVA" as StatusFamilia)
      )
    );

  const aliasesAtivos = await db
    .select({
      familiaId:                   familiasAliases.familiaId,
      codigoAlternativoNormalizado: familiasAliases.codigoAlternativoNormalizado,
    })
    .from(familiasAliases);

  return { itens: itensLic, familias: familiasAtivas, aliases: aliasesAtivos };
}
