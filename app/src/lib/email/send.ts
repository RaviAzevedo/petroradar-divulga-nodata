/**
 * Saída ÚNICA de e-mail do Petro Radar — Microsoft Graph, no tenant da Proponente.
 *
 * Uso:
 *   import { sendEmail } from "@/lib/email/send"
 *   await sendEmail({ to, subject, html })
 *
 * Regra de produto: nenhum e-mail sai que não seja pela Microsoft, no tenant
 * da Proponente. Isso tem duas metades, e as duas são
 * aplicadas aqui, no gargalo por onde TODO e-mail passa:
 *
 *   TRANSPORTE — só Microsoft Graph (lib/email/graph-mail.ts), autenticado
 *     client-credentials no App Registration do SSO (AUTH_MICROSOFT_ENTRA_ID_*),
 *     enviando pela caixa GRAPH_MAIL_SENDER do tenant. Os transportes SMTP
 *     (nodemailer) e Resend FORAM REMOVIDOS — não há mais fallback nenhum.
 *     Sem GRAPH_MAIL_SENDER, o sistema simplesmente não envia (e diz isso no log).
 *
 *   DESTINATÁRIO — lib/email/tenant-guard.ts: o endereço precisa ser de um
 *     usuário ATIVO, cadastrado, em domínio do allow-list do tenant. Endereço
 *     que não passa é descartado e logado, e o envio segue só para o resto.
 *
 * Consequências que valem estar escritas:
 *   • AIR-GAP: sem egress para login.microsoftonline.com + graph.microsoft.com
 *     não sai e-mail NENHUM — não existe mais o fallback SMTP interno. Foi uma
 *     escolha consciente, não um esquecimento.
 *   • FROM_EMAIL não se aplica: no Graph, o remetente e o display name vêm do
 *     Exchange (a caixa GRAPH_MAIL_SENDER).
 *
 * Contrato preservado: os ~9 crons continuam chamando
 * sendEmail({ to, subject, html, text?, replyTo?, inlineImages? }) e recebendo
 * { ok, id?, error? }. NUNCA lança.
 */

import { logger } from "@/lib/observability/logger";
import { graphMailAtivo, sendEmailViaGraph } from "@/lib/email/graph-mail";
import { filtrarDestinatariosDoTenant } from "@/lib/email/tenant-guard";
import { LOGO_PROPONENTE_BASE64, LOGO_PROPONENTE_CID } from "@/lib/email/logo-proponente";

export interface SendEmailParams {
  to:      string | string[];
  subject: string;
  html:    string;
  text?:   string;
  replyTo?: string;
  /**
   * Imagens INLINE (0026): referenciadas no HTML via `cid:<contentId>` e
   * anexadas com isInline — único jeito confiável de logo no Outlook (o proxy
   * de imagens da Microsoft não alcança URLs internas do on-prem).
   */
  inlineImages?: Array<{
    contentId:     string;   // usado no HTML como cid:<contentId>
    nome:          string;   // filename do anexo (ex.: logo.png)
    contentType:   string;   // ex.: image/png
    contentBase64: string;   // conteúdo em base64
  }>;
}

export interface SendEmailResult {
  ok:    boolean;
  id?:   string;
  error?: string;
  /** Endereços descartados pela guarda de tenant (diagnóstico; não é erro). */
  bloqueados?: Array<{ email: string; motivo: string }>;
}

/**
 * Anexa o logo da marca AUTOMATICAMENTE sempre que o HTML referenciar
 * `cid:logo-proponente`.
 *
 * POR QUE AQUI, E NÃO NO CALL-SITE: o `cid:` só resolve no Outlook se a
 * mensagem carregar o anexo inline correspondente. Antes, isso dependia da
 * disciplina de cada chamador — e de 16 call-sites, exatamente UM
 * (lib/digest/licitacoes.ts) passava `inlineImages`. Com o layout único da
 * marca, todos os 14 templates referenciam o logo: confiar no call-site
 * produziria imagem quebrada em 13 e-mails. A anexação vive no gargalo, junto
 * da guarda de tenant e do transporte, onde é impossível esquecer.
 *
 * Idempotente: se o chamador já passou o logo (mesmo contentId), nada é
 * duplicado — o array do call-site vence.
 */
function comLogoDaMarca(params: SendEmailParams): SendEmailParams {
  const precisaLogo = params.html.includes(`cid:${LOGO_PROPONENTE_CID}`);
  if (!precisaLogo) return params;

  const jaTem = params.inlineImages?.some((i) => i.contentId === LOGO_PROPONENTE_CID) ?? false;
  if (jaTem) return params;

  return {
    ...params,
    inlineImages: [
      ...(params.inlineImages ?? []),
      {
        contentId:     LOGO_PROPONENTE_CID,
        nome:          "proponente.png",
        contentType:   "image/png",
        contentBase64: LOGO_PROPONENTE_BASE64,
      },
    ],
  };
}

/**
 * Envia um e-mail. Retorna { ok:false, error } em vez de lançar, sempre.
 *
 * Ordem: logo da marca → guarda de destinatário → transporte Graph. Se a guarda
 * barrar TODO mundo, devolve ok:false sem chamar o Graph (nada sai da rede).
 */
export async function sendEmail(paramsEntrada: SendEmailParams): Promise<SendEmailResult> {
  // ── Metade 0: o logo da marca nunca mais depende do call-site ───────────────
  const params = comLogoDaMarca(paramsEntrada);

  // ── Metade 1: o destinatário é do tenant Proponente? ──────────────────────────
  const { permitidos, bloqueados } = await filtrarDestinatariosDoTenant(params.to);

  if (bloqueados.length > 0) {
    logger.warn("Guarda de tenant descartou destinatário(s) fora da Proponente", {
      subject:    params.subject,
      bloqueados: bloqueados.map((b) => `${b.email} (${b.motivo})`),
    });
  }

  if (permitidos.length === 0) {
    return {
      ok:    false,
      error: "Nenhum destinatário válido: e-mail só é enviado para usuário ativo do tenant Proponente.",
      bloqueados,
    };
  }

  // ── Metade 2: transporte — só Microsoft Graph, sem fallback ─────────────────
  if (!graphMailAtivo()) {
    logger.warn("GRAPH_MAIL_SENDER ausente — transporte de e-mail desligado; nada será enviado", {
      subject: params.subject,
    });
    return {
      ok:    false,
      error: "Transporte de e-mail não configurado (defina GRAPH_MAIL_SENDER).",
      bloqueados,
    };
  }

  const resultado = await sendEmailViaGraph({ ...params, to: permitidos });
  await auditarEnvio(params.subject, permitidos, resultado.ok, resultado.error);
  return bloqueados.length > 0 ? { ...resultado, bloqueados } : resultado;
}

/**
 * Registra TODO envio na trilha de auditoria.
 *
 * Ate 06/08/2026 so o cron do digest auditava (`EMAIL_DIGEST_ENVIADO`). Os outros
 * 13 tipos saiam sem deixar rastro: nao havia como responder "esse alerta chegou
 * a ser enviado?" — nem no suporte, nem numa auditoria de LGPD.
 *
 * Best-effort de proposito: falha de auditoria NAO pode derrubar o envio nem
 * propagar para o cron que chamou. Assunto e destinatarios bastam; o corpo do
 * e-mail nao entra (evita copiar dado pessoal para a trilha).
 */
async function auditarEnvio(
  subject: string,
  destinatarios: string[],
  ok: boolean,
  erro?: string,
): Promise<void> {
  try {
    const { registrarAuditoria } = await import("@/lib/audit/queries");
    await registrarAuditoria({
      userId:     null,
      acao:       ok ? "EMAIL_ENVIADO" : "EMAIL_FALHOU",
      entidade:   "email",
      entidadeId: subject.slice(0, 120),
      detalhes:   {
        assunto: subject,
        para:    destinatarios,
        ...(ok ? {} : { erro: erro ?? "desconhecido" }),
      },
    });
  } catch (e) {
    logger.warn("nao foi possivel auditar o envio de e-mail", {
      subject,
      erro: e instanceof Error ? e.message : String(e),
    });
  }
}
