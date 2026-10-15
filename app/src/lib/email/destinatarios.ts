/**
 * Resolução de destinatários de e-mail (0028) — ÚNICO lugar que decide quem
 * recebe o quê.
 *
 * Antes disso, cada cron redeclarava seu próprio `getDestinatarios*()` — o
 * mesmo SELECT copiado em 8 arquivos, sem nenhum ponto onde aplicar a
 * preferência do usuário. Este módulo substitui todos eles.
 *
 * As duas regras que governam tudo aqui:
 *   1. O PAPEL É O GATE. `papeisDoTipo()` decide quem é elegível ao broadcast;
 *      a preferência nunca amplia esse conjunto, só o reduz.
 *   2. AUSÊNCIA DE LINHA = HABILITADO. Daí o LEFT JOIN com
 *      `isNull(habilitado) OR habilitado = true`: um INNER JOIN silenciaria
 *      todos os usuários que o admin nunca tocou na tela.
 */

import { db } from "@/db";
import { users, preferenciasEmail } from "@/db/schema";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { papeisDoTipo, type TipoEmail } from "@/lib/email/tipos";

export interface DestinatarioEmail {
  id: string;
  email: string;
  nome: string | null;
}

/**
 * `true` quando o usuário não desligou o tipo — incluindo o caso "nunca
 * configurado", em que o LEFT JOIN não casa e `habilitado` vem NULL.
 * O tipo já foi fixado no ON do join; aqui só resta olhar o flag.
 */
const naoOptouPorSair = () =>
  or(isNull(preferenciasEmail.habilitado), eq(preferenciasEmail.habilitado, true));

/** LEFT JOIN da preferência DESTE tipo — nunca INNER (ver regra 2 no topo). */
const juntarPreferencia = (tipo: TipoEmail) =>
  and(eq(preferenciasEmail.userId, users.id), eq(preferenciasEmail.tipo, tipo));

/**
 * Broadcast por papel: todos os usuários ativos cujo papel é elegível ao tipo
 * e que não desligaram esse tipo.
 */
export async function destinatariosPorPapel(tipo: TipoEmail): Promise<DestinatarioEmail[]> {
  const papeis = papeisDoTipo(tipo);
  if (papeis.length === 0) return []; // tipo resolvido só por vínculo

  return db
    .select({ id: users.id, email: users.email, nome: users.nome })
    .from(users)
    .leftJoin(preferenciasEmail, juntarPreferencia(tipo))
    .where(and(
      eq(users.ativo, true),
      inArray(users.role, [...papeis]),
      naoOptouPorSair(),
    ));
}

/** Só os e-mails — assinatura dos helpers antigos que devolviam `string[]`. */
export async function emailsPorPapel(tipo: TipoEmail): Promise<string[]> {
  return (await destinatariosPorPapel(tipo)).map((d) => d.email);
}

/**
 * Filtra uma lista de usuários JÁ resolvida por vínculo (responsável técnico /
 * de orçamento / líder / propositor de uma participação), removendo os
 * inativos e quem desligou este tipo.
 *
 * O vínculo é que confere a elegibilidade aqui — o papel não entra, porque
 * quem é responsável por uma participação precisa saber do prazo dela seja
 * qual for o papel.
 */
export async function destinatariosPorVinculo(
  tipo: TipoEmail,
  userIds: readonly (string | null | undefined)[],
): Promise<DestinatarioEmail[]> {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return [];

  return db
    .select({ id: users.id, email: users.email, nome: users.nome })
    .from(users)
    .leftJoin(preferenciasEmail, juntarPreferencia(tipo))
    .where(and(
      inArray(users.id, ids),
      eq(users.ativo, true),
      naoOptouPorSair(),
    ));
}

/**
 * Responsável do registro + fallback por papel, deduplicado e na ordem certa
 * (o responsável primeiro). Usado pelo tipo de origem `AMBOS`
 * (CONTRATO_CRITICO: responsável de SGI do contrato + ADMIN/LIDER/SGI).
 */
export async function destinatariosComFallback(
  tipo: TipoEmail,
  responsavelId: string | null,
): Promise<DestinatarioEmail[]> {
  const [responsavel, fallback] = await Promise.all([
    destinatariosPorVinculo(tipo, [responsavelId]),
    destinatariosPorPapel(tipo),
  ]);

  const vistos = new Set(responsavel.map((d) => d.id));
  return [...responsavel, ...fallback.filter((d) => !vistos.has(d.id))];
}
