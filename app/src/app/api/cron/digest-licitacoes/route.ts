export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * GET /api/cron/digest-licitacoes — Digest de e-mail de licitações por FILTRO
 * DE E-MAIL (migration 0026).
 *
 * Para cada assinatura ATIVA (usuário ativo, filtro ativo) cuja cadência
 * "venceu" (tempo-real = toda rodada; diario ≥20h; semanal ≥6,5d), seleciona
 * as licitações novas que casam com os critérios do filtro (SQL puro —
 * independente dos perfis_interesse do sistema), descontando as já enviadas a
 * ESTA assinatura (ledger), e envia UM e-mail personalizado (resumido ou
 * completo) via sendEmail (Microsoft Graph — transporte único).
 *
 * Sem novidades → não envia nem carimba. Falha de envio → nada é gravado
 * (retry natural na próxima rodada). Beat: 10:45/15:45/19:45 UTC (após as
 * janelas do scraper de 12/18 UTC).
 *
 * Auth: Bearer ${CRON_SECRET} ou x-vercel-cron: 1.
 * Gate gracioso por config.crons.digestLicitacoes.habilitado — e também quando
 * não há transporte de e-mail configurado (200 {ok:true, skipped:true}),
 * contrato esperado pela suíte e2e de crons (gate G8).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { assinaturasEmail, filtrosEmail, users, perfisInteresse } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { config } from "@/lib/config";
import { loggerFor } from "@/lib/observability/logger";
import { registrarAuditoria } from "@/lib/audit/queries";
import { verifyCronAuth } from "@/lib/security/secrets";
import {
  cadenciaVencida,
  enviarDigestUsuario,
  normalizarCriterios,
  type AssinaturaDoUsuario,
} from "@/lib/digest/licitacoes";

/**
 * O transporte está configurado? Microsoft Graph é o ÚNICO — SMTP e Resend
 * foram removidos (lib/email/send.ts). Sem GRAPH_MAIL_SENDER não há como enviar,
 * então o cron sai cedo em vez de varrer as assinaturas à toa.
 */
function transporteConfigurado(): boolean {
  return Boolean(process.env.GRAPH_MAIL_SENDER);
}

export async function GET(req: NextRequest) {
  const log = loggerFor(req, { route: "/api/cron/digest-licitacoes" });

  // verifyCronAuth = comparação timing-safe do Bearer (padrão da casa).
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }
  if (!config.crons.digestLicitacoes.habilitado) {
    return NextResponse.json({ ok: true, skipped: true, motivo: "cron desabilitado" });
  }
  if (!transporteConfigurado()) {
    log.warn("digest-licitacoes: nenhum transporte de e-mail configurado — skip");
    return NextResponse.json({ ok: true, skipped: true, motivo: "transporte de e-mail não configurado" });
  }

  const maxItens = config.crons.digestLicitacoes.maxItensPorEmail;

  // Assinaturas elegíveis: assinatura ativa ∩ usuário ativo ∩ filtro ativo.
  const assinaturas = await db
    .select({
      id:            assinaturasEmail.id,
      formato:       assinaturasEmail.formato,
      relevanciaMinima: assinaturasEmail.relevanciaMinima,
      frequencia:    assinaturasEmail.frequencia,
      ultimoEnvioEm: assinaturasEmail.ultimoEnvioEm,
      email:         users.email,
      filtroNome:    filtrosEmail.nome,
      criterios:     filtrosEmail.criterios,
      perfilNome:    perfisInteresse.nome,
      perfilAtivo:   perfisInteresse.ativo,
    })
    .from(assinaturasEmail)
    .innerJoin(users, and(eq(assinaturasEmail.userId, users.id), eq(users.ativo, true)))
    // LEFT nos DOIS: a assinatura tem exatamente uma origem (CHECK do banco), e
    // o INNER anterior em filtros_email fazia toda assinatura por PERFIL sumir
    // silenciosamente da rodada.
    .leftJoin(filtrosEmail, and(eq(assinaturasEmail.filtroId, filtrosEmail.id), eq(filtrosEmail.ativo, true)))
    .leftJoin(perfisInteresse, eq(assinaturasEmail.perfilId, perfisInteresse.id))
    .where(eq(assinaturasEmail.ativo, true));

  let devidas = 0;
  let enviados = 0;
  let falhas = 0;
  const detalhes: Array<{ filtro: string; itens: number; ok: boolean }> = [];

  // ── Agrupa por PESSOA ───────────────────────────────────────────────────────
  // Um e-mail por pessoa, nao por assinatura: quem assina 3 perfis recebia 3
  // e-mails na mesma manha, com a mesma cara. Agora as licitacoes dos perfis dela
  // vao juntas, deduplicadas e ordenadas pelo score.
  const porUsuario = new Map<string, { email: string; assinaturas: AssinaturaDoUsuario[] }>();

  for (const ass of assinaturas) {
    if (!cadenciaVencida(ass.frequencia, ass.ultimoEnvioEm)) continue;

    // Perfil INATIVO nao envia: ele saiu do motor, entao perfis_match parou de
    // ser alimentado e o digest so mandaria dado velho.
    const porPerfil = ass.perfilNome !== null;
    if (porPerfil && !ass.perfilAtivo) {
      log.info(`digest-licitacoes: perfil "${ass.perfilNome}" inativo — assinatura pulada`);
      continue;
    }
    const rotulo = porPerfil ? ass.perfilNome! : ass.filtroNome;
    if (!rotulo) continue;   // assinatura orfa (filtro desativado/apagado)

    const criterios = porPerfil
      ? normalizarCriterios({ perfil: ass.perfilNome, min_relevancia: ass.relevanciaMinima })
      // Caminho legado: o FILTRO pode ter piso proprio. Vale o mais restritivo —
      // sobrescrever direto rebaixaria um filtro "so ALTA" para o default TODAS.
      : normalizarCriterios({
          ...(ass.criterios as object),
          min_relevancia: pisoMaisRestritivo(
            (ass.criterios as { min_relevancia?: string } | null)?.min_relevancia,
            ass.relevanciaMinima,
          ),
        });

    devidas++;
    const reg = porUsuario.get(ass.email) ?? { email: ass.email, assinaturas: [] };
    reg.assinaturas.push({
      id:        ass.id,
      rotulo,
      formato:   ass.formato as "resumido" | "completo",
      criterios,
    });
    porUsuario.set(ass.email, reg);
  }

  for (const { email, assinaturas: doUsuario } of porUsuario.values()) {
    try {
      const r = await enviarDigestUsuario(email, doUsuario, maxItens);
      const rotulo = r.perfis.join(" · ");

      if (r.enviado) {
        enviados++;
        detalhes.push({ filtro: rotulo, itens: r.itens, ok: true });
        await registrarAuditoria({
          userId:     null,
          acao:       "EMAIL_DIGEST_ENVIADO",
          entidade:   "assinaturas_email",
          entidadeId: doUsuario.map((a) => a.id).join(","),
          detalhes:   { perfis: r.perfis, para: email, itens: r.itens, total: r.total },
        }).catch(() => {});
      } else if (r.erro) {
        falhas++;
        detalhes.push({ filtro: rotulo, itens: r.itens, ok: false });
        log.warn(`digest-licitacoes: falha ao enviar p/ ${email} (${rotulo}): ${r.erro}`);
      }
      // r.enviado=false sem erro = sem novidades → silêncio (não carimba).
    } catch (err) {
      // Uma pessoa com problema nunca derruba o lote das demais.
      falhas++;
      log.error(`digest-licitacoes: exceção no digest de ${email}`, err);
    }
  }

  log.info(
    `digest-licitacoes: ${assinaturas.length} assinaturas, ${devidas} devidas, ${enviados} enviados, ${falhas} falhas`,
  );
  return NextResponse.json({
    ok: true,
    assinaturasAvaliadas: assinaturas.length,
    devidas,
    enviados,
    falhas,
    detalhes,
  });
}

/** Devolve o piso de relevância mais restritivo entre dois (ALTA > MEDIA > TODAS). */
function pisoMaisRestritivo(a: string | undefined | null, b: string | undefined | null): string {
  const ordem: Record<string, number> = { TODAS: 0, MEDIA: 1, ALTA: 2 };
  const va = ordem[(a ?? "TODAS").toUpperCase()] ?? 0;
  const vb = ordem[(b ?? "TODAS").toUpperCase()] ?? 0;
  return va >= vb ? (a ?? "TODAS").toUpperCase() : (b ?? "TODAS").toUpperCase();
}
