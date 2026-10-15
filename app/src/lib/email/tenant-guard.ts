/**
 * Guarda de destinatário (2026-07-13) — NENHUM e-mail sai para um endereço que
 * não seja de um usuário ATIVO da Proponente.
 *
 * Regra de produto: nenhum e-mail sai que não seja pela Microsoft, no tenant
 * da Proponente. A metade do TRANSPORTE está em send.ts (só Graph, no
 * tenant do App Registration do SSO); esta aqui é a metade do DESTINATÁRIO.
 *
 * Um endereço só é aceito se as TRÊS coisas valerem:
 *   1. existe em `users` (é gente cadastrada no Petro Radar, não texto solto);
 *   2. `users.ativo = true` (desligado/bloqueado não recebe mais nada);
 *   3. o domínio está em AUTH_ALLOWED_EMAIL_DOMAINS (default example.com) —
 *      o MESMO allow-list que o login SSO usa para barrar convidado B2B do
 *      tenant (auth.ts::dominioPermitido).
 *
 * Por que aqui e não só nos crons: `lib/email/destinatarios.ts` já resolve
 * destinatário a partir da tabela `users`, mas ele não é o único caminho —
 * o digest por assinatura e o "enviar teste" do admin também chamam sendEmail.
 * Esta guarda roda DENTRO do sendEmail, o gargalo único: mesmo que um cron
 * futuro monte a lista errada, ou alguém escreva um endereço à mão, não passa.
 *
 * Sem esta guarda, e-mail real pode sair para caixas de fixture
 * `*.e2e@example.com` (inexistentes no Exchange) e gerar bounce na caixa
 * remetente.
 */

import { db } from "@/db";
import { users } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { logger } from "@/lib/observability/logger";

/** Mesmo allow-list do login SSO (auth.ts) — fonte única via env. */
const DOMINIOS_PERMITIDOS = (process.env.AUTH_ALLOWED_EMAIL_DOMAINS ?? "example.com")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

function dominioPermitido(email: string): boolean {
  const dominio = email.split("@")[1]?.toLowerCase();
  return Boolean(dominio) && DOMINIOS_PERMITIDOS.includes(dominio);
}

export interface FiltroDestinatarios {
  permitidos: string[];
  /** endereço → por que foi barrado (para log/auditoria). */
  bloqueados: Array<{ email: string; motivo: string }>;
}

/**
 * Filtra a lista de destinatários, devolvendo só quem pode receber.
 * Nunca lança: um erro de banco barra TODO mundo (falha fechada) — deixar um
 * e-mail escapar por indisponibilidade do Postgres seria pior que não enviar.
 */
export async function filtrarDestinatariosDoTenant(
  to: string | string[],
): Promise<FiltroDestinatarios> {
  const brutos = (Array.isArray(to) ? to : [to])
    .map((e) => e?.trim().toLowerCase())
    .filter(Boolean);

  const enderecos = [...new Set(brutos)];
  if (enderecos.length === 0) return { permitidos: [], bloqueados: [] };

  const bloqueados: Array<{ email: string; motivo: string }> = [];

  // 1ª barreira (sem tocar no banco): domínio fora do allow-list do tenant.
  const candidatos = enderecos.filter((email) => {
    if (dominioPermitido(email)) return true;
    bloqueados.push({ email, motivo: "dominio_fora_do_tenant" });
    return false;
  });

  if (candidatos.length === 0) return { permitidos: [], bloqueados };

  // 2ª barreira: precisa ser usuário ATIVO cadastrado.
  let ativos: string[];
  try {
    const rows = await db
      .select({ email: users.email })
      .from(users)
      .where(and(inArray(users.email, candidatos), eq(users.ativo, true)));
    ativos = rows.map((r) => r.email.toLowerCase());
  } catch (err) {
    // Falha FECHADA: sem conseguir provar que o destinatário é do tenant,
    // não envia para ninguém.
    logger.error("Guarda de destinatário: falha ao consultar users — bloqueando TODOS os envios desta chamada", err);
    return {
      permitidos: [],
      bloqueados: enderecos.map((email) => ({ email, motivo: "verificacao_indisponivel" })),
    };
  }

  const permitidos = candidatos.filter((email) => {
    if (ativos.includes(email)) return true;
    bloqueados.push({ email, motivo: "nao_e_usuario_ativo" });
    return false;
  });

  return { permitidos, bloqueados };
}
