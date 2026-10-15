/**
 * Transporte Microsoft Graph — envia e-mail pela caixa GRAPH_MAIL_SENDER usando
 * o MESMO App Registration do login SSO (client credentials, app-only; o token
 * com cache vem de lib/entra/graph.ts).
 *
 * Exige no Azure/Exchange:
 *   • permissão de APLICAÇÃO `Mail.Send` com admin consent;
 *   • shared mailbox remetente (ex.: no-reply@example.com);
 *   • Application Access Policy restringindo o app a ESSA caixa.
 *
 * A PRESENÇA de GRAPH_MAIL_SENDER ativa este transporte como Transporte 0 da
 * cadeia de sendEmail (resend.ts) — antes do SMTP. Contrato espelhado: NUNCA
 * lança; retorna { ok, id?, error? }.
 *
 * Egress: login.microsoftonline.com (token) + graph.microsoft.com (sendMail).
 * Limites: Exchange 30 msgs/min e 10k destinatários/dia por caixa; Graph
 * devolve 429 com Retry-After quando estoura (tratado como {ok:false}).
 */

import { logger } from "@/lib/observability/logger";
import { obterToken, GraphError } from "@/lib/entra/graph";
import type { SendEmailParams, SendEmailResult } from "@/lib/email/send";

// UPN (ou object id) da caixa remetente. A PRESENÇA desta env ativa o transporte.
const SENDER    = process.env.GRAPH_MAIL_SENDER;
const SAVE_SENT = process.env.GRAPH_MAIL_SAVE_SENT === "1"; // 1 = grava em Itens Enviados

export function graphMailAtivo(): boolean {
  return Boolean(SENDER);
}

/**
 * POST /v1.0/users/{remetente}/sendMail — sucesso = 202 Accepted, corpo vazio.
 * sendMail não devolve message-id: `id` é o header request-id (correlação).
 * O display name do remetente vem do Exchange (a env FROM_EMAIL não se aplica).
 */
export async function sendEmailViaGraph(params: SendEmailParams): Promise<SendEmailResult> {
  if (!SENDER) return { ok: false, error: "GRAPH_MAIL_SENDER não configurado" };
  try {
    const token = await obterToken();
    const destinatarios = (Array.isArray(params.to) ? params.to : [params.to])
      .map((address) => ({ emailAddress: { address } }));

    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(SENDER)}/sendMail`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            subject: params.subject,
            // body é único no Graph — o HTML vence; params.text fica sem uso aqui.
            body: { contentType: "HTML", content: params.html },
            toRecipients: destinatarios,
            ...(params.replyTo
              ? { replyTo: [{ emailAddress: { address: params.replyTo } }] }
              : {}),
            // Imagens inline (cid:) — anexo fileAttachment com isInline, o
            // caminho nativo do Outlook/Exchange p/ logo embutida (0026).
            ...(params.inlineImages?.length
              ? {
                  attachments: params.inlineImages.map((img) => ({
                    "@odata.type": "#microsoft.graph.fileAttachment",
                    name:          img.nome,
                    contentType:   img.contentType,
                    contentBytes:  img.contentBase64,
                    contentId:     img.contentId,
                    isInline:      true,
                  })),
                }
              : {}),
          },
          saveToSentItems: SAVE_SENT,
        }),
      },
    );

    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After") ?? "?";
      logger.warn(`Graph sendMail throttled (429), Retry-After=${retryAfter}s — assunto: ${params.subject}`);
      return { ok: false, error: `Graph throttling (429); aguardar ${retryAfter}s` };
    }
    if (res.status === 403) {
      // Padrão da casa (lib/entra/graph.ts): 403 = mensagem acionável ao admin.
      return {
        ok: false,
        error:
          "App sem permissão de aplicação Mail.Send (admin consent) ou caixa fora da Application Access Policy.",
      };
    }
    if (res.status !== 202) {
      const corpo = await res.text().catch(() => "");
      logger.error(`Graph sendMail falhou (${res.status}): ${corpo.slice(0, 300)} — assunto: ${params.subject}`);
      return { ok: false, error: `Graph sendMail HTTP ${res.status}` };
    }
    return { ok: true, id: res.headers.get("request-id") ?? undefined };
  } catch (err) {
    const msg = err instanceof GraphError || err instanceof Error ? err.message : String(err);
    logger.error("Exceção ao enviar e-mail via Graph", err);
    return { ok: false, error: msg };
  }
}
