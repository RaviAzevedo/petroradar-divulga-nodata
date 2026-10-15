import { db } from "@/db";
import { auditLog, users } from "@/db/schema";
import { and, eq, desc, sql, type SQL } from "drizzle-orm";

/**
 * Registra uma ação no audit log. Função pequena, mas centraliza o padrão
 * (qualquer chamador pode esquecer um campo, aqui o tipo guia).
 *
 * Útil em: routes de mutação (POST/PATCH/DELETE), cron jobs, scripts.
 */
export async function registrarAuditoria(input: {
  userId:     string | null;
  acao:       string;
  entidade:   string;
  entidadeId: string;
  detalhes?:  Record<string, unknown>;
}): Promise<void> {
  await db.insert(auditLog).values({
    userId:     input.userId,
    acao:       input.acao,
    entidade:   input.entidade,
    entidadeId: input.entidadeId,
    detalhes:   input.detalhes ?? {},
  });
}

/**
 * Histórico de auditoria de uma entidade (envelope, contrato, documento, família).
 * Mais recente primeiro, com nome/email do usuário responsável quando disponível.
 */
export async function listarAuditoria(input: {
  entidade:   string;
  entidadeId: string;
  limit?:     number;
}) {
  return db
    .select({
      id:        auditLog.id,
      acao:      auditLog.acao,
      detalhes:  auditLog.detalhes,
      criadoEm:  auditLog.criadoEm,
      userId:    auditLog.userId,
      userNome:  users.nome,
      userEmail: users.email,
    })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.userId, users.id))
    .where(and(
      eq(auditLog.entidade, input.entidade),
      eq(auditLog.entidadeId, input.entidadeId),
    ))
    .orderBy(desc(auditLog.criadoEm))
    .limit(input.limit ?? 100);
}

/**
 * Lista todos os eventos de auditoria com filtros opcionais e paginação.
 * Pra dashboard /admin/audit-log.
 */
export async function listarTodaAuditoria(input: {
  entidade?:   string;
  userId?:     string;
  acao?:       string;
  limit?:      number;
  offset?:     number;
} = {}) {
  const where: SQL[] = [];
  if (input.entidade) where.push(eq(auditLog.entidade, input.entidade));
  if (input.userId)   where.push(eq(auditLog.userId,   input.userId));
  if (input.acao)     where.push(eq(auditLog.acao,     input.acao));

  const whereClause = where.length > 0 ? and(...where) : undefined;

  const [rows, [{ count }]] = await Promise.all([
    db
      .select({
        id:         auditLog.id,
        acao:       auditLog.acao,
        entidade:   auditLog.entidade,
        entidadeId: auditLog.entidadeId,
        detalhes:   auditLog.detalhes,
        criadoEm:   auditLog.criadoEm,
        userId:     auditLog.userId,
        userNome:   users.nome,
        userEmail:  users.email,
      })
      .from(auditLog)
      .leftJoin(users, eq(auditLog.userId, users.id))
      .where(whereClause)
      .orderBy(desc(auditLog.criadoEm))
      .limit(input.limit  ?? 50)
      .offset(input.offset ?? 0),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(whereClause),
  ]);

  return { rows, total: Number(count ?? 0) };
}
