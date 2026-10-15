"""Envio de e-mail on-prem via SMTP relay corporativo (aiosmtplib).

Substitui o SDK Resend usado no Next. Replica o comportamento esperado pelos
crons/handlers migrados: ``send_email(to, subject, html, ...)`` assíncrono,
silenciosamente no-op se o SMTP não estiver configurado (igual ao app, que em
dev sem chave apenas loga) para não derrubar a rota.
"""
from __future__ import annotations

import logging
from email.message import EmailMessage

from app.core.config import get_settings

log = logging.getLogger("petro.email")


async def send_email(
    to: str | list[str],
    subject: str,
    html: str | None = None,
    text: str | None = None,
    *,
    from_email: str | None = None,
) -> dict:
    """Envia um e-mail HTML (e/ou texto) via SMTP. Retorna {ok, skipped?}.

    Sem ``SMTP_HOST`` configurado, faz no-op logado (paridade com dev sem chave).
    """
    settings = get_settings()
    destinatarios = [to] if isinstance(to, str) else list(to)

    if not settings.smtp_host:
        log.warning("SMTP não configurado — e-mail '%s' não enviado (no-op).", subject)
        return {"ok": False, "skipped": True}

    msg = EmailMessage()
    msg["From"] = from_email or settings.from_email
    msg["To"] = ", ".join(destinatarios)
    msg["Subject"] = subject
    if text:
        msg.set_content(text)
    else:
        msg.set_content("Este e-mail requer um cliente compatível com HTML.")
    if html:
        msg.add_alternative(html, subtype="html")

    import aiosmtplib

    # CONTRATO (espelha sendEmail de src/lib/email/resend.ts): NUNCA lança. Em
    # qualquer falha de transporte retorna {ok:false, error}. Crons dependem disso
    # para não abortar o lote inteiro por um e-mail que falhou.
    try:
        await aiosmtplib.send(
            msg,
            hostname=settings.smtp_host,
            port=settings.smtp_port,
            username=settings.smtp_user or None,
            password=settings.smtp_pass or None,
            use_tls=settings.smtp_secure,            # True p/ 465/SSL implícito
            start_tls=not settings.smtp_secure,      # STARTTLS p/ 587
        )
    except Exception as exc:  # noqa: BLE001 — transporte SMTP falhou
        log.error("Falha ao enviar e-mail '%s' -> %s: %s", subject, destinatarios, exc)
        return {"ok": False, "skipped": False, "error": str(exc)}
    log.info("E-mail enviado: '%s' -> %s", subject, destinatarios)
    return {"ok": True, "skipped": False}
