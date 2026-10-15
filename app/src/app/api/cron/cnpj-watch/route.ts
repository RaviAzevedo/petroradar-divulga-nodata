export const runtime = "nodejs";

/**
 * GET /api/cron/cnpj-watch — Vercel Cron semanal (segunda 09:00 UTC)
 *
 * Consulta a situação cadastral do CNPJ Proponente na Receita Federal
 * via BrasilAPI (https://brasilapi.com.br/api/cnpj/v1/{cnpj}) — gratuita,
 * sem cadastro. Detecta mudança de situação (ATIVA → SUSPENSA / INAPTA)
 * e dispara alerta crítico via Microsoft Graph, pois Petrobras suspende automaticamente
 * fornecedores com CNPJ irregular.
 *
 * Auth: Bearer ${CRON_SECRET} ou x-vercel-cron: 1.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { cnpjStatusLog, type SituacaoCadastralCnpj } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { sendEmail } from "@/lib/email/send";
import { emailsPorPapel } from "@/lib/email/destinatarios";
import { templateCnpjSituacao } from "@/lib/email/templates";
import { config } from "@/lib/config";
import { formatCNPJ } from "@/lib/format";
import { loggerFor } from "@/lib/observability/logger";
import { verifyCronAuth } from "@/lib/security/secrets";

interface BrasilApiCnpj {
  cnpj: string;
  razao_social?: string;
  nome_fantasia?: string;
  descricao_situacao_cadastral?: string;
  motivo_situacao_cadastral?: number | string;
  data_situacao_cadastral?: string;
  // ... outros campos
}

function normalizarSituacao(s: string | undefined): SituacaoCadastralCnpj {
  const x = (s ?? "").toUpperCase();
  if (x.includes("ATIVA")) return "ATIVA";
  if (x.includes("SUSPENS")) return "SUSPENSA";
  if (x.includes("INAPTA")) return "INAPTA";
  if (x.includes("BAIXA")) return "BAIXADA";
  if (x.includes("NULA")) return "NULA";
  return "DESCONHECIDA";
}

/** ADMIN/LIDER/SGI ativos que não desligaram "Situação cadastral do CNPJ mudou". */
const getDestinatariosCriticos = () => emailsPorPapel("CNPJ_SITUACAO");

export async function GET(req: NextRequest) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const log = loggerFor(req, { route: "cron/cnpj-watch" });

  const cnpj = config.proponente.cnpj.replace(/\D/g, "");
  if (cnpj.length !== 14) {
    return NextResponse.json({ error: "CNPJ Proponente inválido em config" }, { status: 500 });
  }

  let res: Response;
  try {
    res = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, {
      // User-Agent OBRIGATORIO: a BrasilAPI responde 403/429 ao UA default do
      // fetch do Node, e o cron falhava 4x e terminava FAILURE em silencio desde
      // sempre (cnpj_status_log = 0 linhas). Qualquer UA nao-vazio resolve.
      headers: {
        Accept: "application/json",
        "User-Agent": "PetroRadar/1.0 (+https://github.com/petro-radar)",
      },
      // BrasilAPI tem rate limit baixo — sem retry pesado
    });
  } catch (e) {
    log.error("BrasilAPI falha de rede", e, { cnpj });
    return NextResponse.json({ ok: false, error: "Falha de rede ao consultar BrasilAPI" }, { status: 502 });
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    log.error("BrasilAPI retornou erro", null, { cnpj, status: res.status, body: txt.slice(0, 200) });
    return NextResponse.json({ ok: false, error: `BrasilAPI HTTP ${res.status}` }, { status: 502 });
  }

  const dados = (await res.json()) as BrasilApiCnpj;
  const situacao = normalizarSituacao(dados.descricao_situacao_cadastral);
  const motivoStr = dados.motivo_situacao_cadastral != null ? String(dados.motivo_situacao_cadastral) : null;
  const ultimaAtualizacao = dados.data_situacao_cadastral ? new Date(dados.data_situacao_cadastral) : null;

  // Último registro
  const [ultimo] = await db
    .select()
    .from(cnpjStatusLog)
    .where(eq(cnpjStatusLog.cnpj, cnpj))
    .orderBy(desc(cnpjStatusLog.checadoEm))
    .limit(1);

  const mudou = !ultimo || ultimo.situacao !== situacao;
  let alertado = false;

  // LGPD: QSA não persistido — remove o quadro societário (nome_socio etc.)
  // do snapshot antes de gravar em cnpj_status_log (espelho do BFF F4-bff).
  const { qsa: _qsa, ...dadosPersistir } = dados as unknown as Record<string, unknown>;

  // Insere o snapshot atual sempre (auditoria)
  const [novo] = await db
    .insert(cnpjStatusLog)
    .values({
      cnpj,
      situacao,
      motivoSituacao:    motivoStr,
      razaoSocial:       dados.razao_social ?? null,
      ultimaAtualizacao,
      fonte:             "BrasilAPI",
      dadosBrutos:       dadosPersistir,
      mudou,
      alertado:          false,
    })
    .returning();

  // Alerta apenas quando mudou pra estado pior (deixa de ser ATIVA)
  if (mudou && situacao !== "ATIVA") {
    const destinatarios = await getDestinatariosCriticos();
    if (destinatarios.length > 0) {
      const tpl = templateCnpjSituacao({
        // O template só EXIBE o CNPJ (numeroEdital) — manda formatado.
        // A persistência acima continua usando os 14 dígitos crus.
        cnpj:              formatCNPJ(cnpj),
        // A razão social vai para o ASSUNTO via assunto(): "—" produziria
        // "URGENTE: CNPJ mudou para SUSPENSA — —". A razão social canônica da
        // Proponente (config) é o fallback certo quando a BrasilAPI omite o campo.
        razaoSocial:       dados.razao_social ?? config.proponente.razaoSocial,
        situacaoAnterior:  ultimo?.situacao ?? "DESCONHECIDA",
        situacaoAtual:     situacao,
        motivo:            motivoStr,
        ultimaAtualizacao,
      });
      const r = await sendEmail({ to: destinatarios, subject: tpl.subject, html: tpl.html, text: tpl.text });
      if (r.ok) {
        alertado = true;
        await db.update(cnpjStatusLog).set({ alertado: true }).where(eq(cnpjStatusLog.id, novo.id));
      }
    }
  }

  return NextResponse.json({ ok: true, cnpj, situacao, mudou, alertado });
}
