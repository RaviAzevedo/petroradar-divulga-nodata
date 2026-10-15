"""
Adapter de e-mail on-premise — transporte SMTP via ``aiosmtplib``.

PORTA de ``app/src/lib/email/resend.ts`` (neste repo). Espelha 1:1 o
CONTRATO de transporte:

  - ``send_email(EmailMessage) -> SendEmailResult`` (equivalente a ``sendEmail``);
  - ``send_email_batch([...]) -> list[SendEmailResult]`` (sequencial, respeita
    rate-limit do relay — equivalente a ``sendEmailBatch``);
  - NUNCA lanca excecao: retorna ``{ok, id?, error?}`` (igual ao resend.ts);
  - se ``SMTP_HOST`` (e o transporte) nao estiver configurado, loga ``warning`` e
    devolve ``ok=False`` (modo dev/offline — e-mails silenciosamente ignorados),
    exatamente como o resend.ts faz quando falta ``RESEND_API_KEY``.

PARIDADE DE CONTEUDO (assunto/HTML/text): este modulo NAO gera templates. Os 23
templates ``{subject, html, text}`` (``src/lib/email/templates.ts`` +
``templates-circular.ts``) permanecem no app Next e sao INTACTOS (ver
a spec de integracoes, secao 3.2). O BFF/worker so PRECISA do transporte
quando uma rota de e-mail for portada para o FastAPI; ate la, os crons de e-mail
continuam saindo pelo container ``web``. Este adapter existe para quando a Onda de
migracao trouxer uma rota que envie e-mail a partir do BFF — recebendo o
``subject``/``html``/``text`` JA RENDERIZADOS (idem aos templates do Next) e apenas
entregando-os via SMTP corporativo.

Por que SMTP e nao Resend (Decisao de paridade, INTEGRACOES.md secao 3.1): o
transporte Resend (egress HTTPS ``api.resend.com``) e trocado pelo relay SMTP
interno da Proponente (ou Office 365) — egress dentro da rede corporativa, sem
internet publica. A interface e a semantica permanecem identicas.

────────────────────────────────────────────────────────────────────────────────
WIRING NECESSARIO
────────────────────────────────────────────────────────────────────────────────
1. Dependencia em ``bff/requirements.txt`` (NAO editar agora — adicionar quando
   esta lane for fiada):
       aiosmtplib>=3.0,<4
   (stdlib ``email.message.EmailMessage`` ja vem com o Python 3.12 — sem dep.)

2. Variaveis de ambiente (consolidadas em ``.env.onprem`` — ver INTEGRACOES.md
   secao 8.2). Adicionar os campos correspondentes em
   ``bff/app/core/config.py`` (classe ``Settings``) — diff abaixo, NAO aplicar
   agora:

       # ── E-mail (SMTP corporativo — troca Resend por SMTP) ──────────────────
       mail_transport: str = Field(default="smtp", alias="MAIL_TRANSPORT")
       smtp_host: str = Field(default="", alias="SMTP_HOST")
       smtp_port: int = Field(default=587, alias="SMTP_PORT")
       smtp_secure: bool = Field(default=False, alias="SMTP_SECURE")        # True=465/SSL
       smtp_user: str = Field(default="", alias="SMTP_USER")
       smtp_pass: str = Field(default="", alias="SMTP_PASS")
       smtp_from: str = Field(
           default="Petro Radar <no-reply@example.com>", alias="SMTP_FROM"
       )
       smtp_tls_reject_unauthorized: bool = Field(
           default=True, alias="SMTP_TLS_REJECT_UNAUTHORIZED"
       )

   Bloco de .env (relay interno OU Office 365):
       MAIL_TRANSPORT=smtp
       SMTP_HOST=smtp.example.local        # ou smtp.office365.com
       SMTP_PORT=587
       SMTP_SECURE=false                    # true => porta 465 (SSL implicito)
       SMTP_USER=petroradar@example.com
       SMTP_PASS=<segredo>
       SMTP_FROM=Petro Radar <no-reply@example.com>
       SMTP_TLS_REJECT_UNAUTHORIZED=false   # se o relay usa cert interno self-signed
       # RESEND_API_KEY: VAZIO on-prem (nao usado)

3. Egress: do container que envia ate ``SMTP_HOST:587/465``. Se o relay for
   interno a LAN Proponente, NAO e egress de internet (rede ``frontend`` ate o
   relay). Office 365 => liberar ``smtp.office365.com:587`` na allowlist.

────────────────────────────────────────────────────────────────────────────────
NOTA DE CONFIG (graceful, ate o WIRING acima ser aplicado)
────────────────────────────────────────────────────────────────────────────────
Enquanto os campos SMTP nao existirem em ``Settings``, este modulo le os valores
via ``getattr(settings, ..., default)`` com fallback para ``os.environ``. Assim ele
compila e funciona ANTES e DEPOIS do WIRING, sem editar arquivos existentes do
scaffold.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr, parseaddr
from typing import Sequence

import aiosmtplib

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger("petro_radar_bff.email")


# ── Resolucao de config (compativel com Settings com ou sem campos SMTP) ──────
def _cfg(nome: str, default: str = "") -> str:
    """Le ``settings.<nome>`` se existir; senao cai para ``os.environ``.

    Mantem o adapter funcional antes do WIRING (campos ainda nao em ``Settings``)
    e depois dele (passa a ler do singleton tipado). Espelha o fallback de
    config.py (AUTH_SECRET -> NEXTAUTH_SECRET).
    """
    valor = getattr(settings, nome, None)
    if valor is not None and valor != "":
        return str(valor)
    return os.environ.get(nome.upper(), default)


def _cfg_bool(nome: str, default: bool = False) -> bool:
    valor = getattr(settings, nome, None)
    if isinstance(valor, bool):
        return valor
    bruto = os.environ.get(nome.upper())
    if bruto is None:
        return default
    return bruto.strip().lower() in {"1", "true", "yes", "on"}


def _cfg_int(nome: str, default: int) -> int:
    valor = getattr(settings, nome, None)
    if isinstance(valor, int):
        return valor
    bruto = os.environ.get(nome.upper())
    if bruto is None:
        return default
    try:
        return int(bruto)
    except ValueError:
        return default


def _from_email() -> str:
    """Remetente padrao — espelha a precedencia do resend.ts/INTEGRACOES.md.

    SMTP_FROM ?? RESEND_FROM_EMAIL ?? FROM_EMAIL ?? default Proponente.
    """
    return (
        _cfg("smtp_from")
        or os.environ.get("RESEND_FROM_EMAIL", "")
        or os.environ.get("FROM_EMAIL", "")
        or "Petro Radar <no-reply@example.com>"
    )


# ── Tipos (espelham SendEmailParams / SendEmailResult do resend.ts) ───────────
@dataclass(slots=True)
class EmailMessageParams:
    """Equivale a ``SendEmailParams`` do resend.ts.

    ``to`` aceita str unica ou lista (igual ao ``string | string[]`` do TS).
    """

    to: str | Sequence[str]
    subject: str
    html: str
    text: str | None = None
    reply_to: str | None = None


@dataclass(slots=True)
class SendEmailResult:
    """Equivale a ``SendEmailResult`` do resend.ts (``{ ok, id?, error? }``)."""

    ok: bool
    id: str | None = None
    error: str | None = None


def transport_enabled() -> bool:
    """Indica se o transporte SMTP esta configurado (gate gracioso).

    Espelha o gate ``if (!client)`` do resend.ts: sem ``SMTP_HOST`` (ou com
    ``MAIL_TRANSPORT != smtp``) os envios sao no-op silencioso (``ok=False``).
    """
    if _cfg("mail_transport", "smtp").lower() != "smtp":
        return False
    return bool(_cfg("smtp_host"))


def _build_message(params: EmailMessageParams) -> EmailMessage:
    """Monta o ``EmailMessage`` MIME (html + text alternativo, igual ao Resend)."""
    msg = EmailMessage()

    # ``from`` com nome amigavel preservado ("Petro Radar <no-reply@...>").
    nome, addr = parseaddr(_from_email())
    msg["From"] = formataddr((nome, addr)) if nome else addr

    destinos = [params.to] if isinstance(params.to, str) else list(params.to)
    msg["To"] = ", ".join(destinos)
    msg["Subject"] = params.subject
    if params.reply_to:
        msg["Reply-To"] = params.reply_to

    # Corpo: text como fallback + html como alternativa rica (multipart/alternative).
    if params.text:
        msg.set_content(params.text)
        msg.add_alternative(params.html, subtype="html")
    else:
        # Sem text explicito: HTML como conteudo principal (mesma escolha do Resend,
        # que aceita html sem text). Mantem um content-type text/html legivel.
        msg.set_content(params.html, subtype="html")

    return msg


async def send_email(params: EmailMessageParams) -> SendEmailResult:
    """Envia um e-mail via SMTP (porta de ``sendEmail`` do resend.ts).

    NUNCA lanca: retorna ``SendEmailResult(ok=True, id=...)`` em sucesso ou
    ``SendEmailResult(ok=False, error=...)`` em falha. Sem transporte configurado,
    loga ``warning`` e devolve ``ok=False`` (modo dev — espelha o resend.ts).
    """
    if not transport_enabled():
        log.warning(
            "SMTP nao configurado (SMTP_HOST/MAIL_TRANSPORT) — e-mail nao enviado",
            extra={"subject": params.subject},
        )
        return SendEmailResult(ok=False, error="SMTP nao configurado")

    host = _cfg("smtp_host")
    port = _cfg_int("smtp_port", 587)
    secure = _cfg_bool("smtp_secure", False)  # True => 465 (TLS implicito)
    user = _cfg("smtp_user")
    senha = _cfg("smtp_pass")
    # SMTP_TLS_REJECT_UNAUTHORIZED=false => aceitar cert interno self-signed.
    validar_cert = _cfg_bool("smtp_tls_reject_unauthorized", True)

    msg = _build_message(params)

    # Contexto TLS: relaxa verificacao quando o relay interno usa cert self-signed.
    tls_context = None
    if not validar_cert:
        import ssl

        tls_context = ssl.create_default_context()
        tls_context.check_hostname = False
        tls_context.verify_mode = ssl.CERT_NONE

    try:
        # secure=True  -> conexao TLS implicita (porta 465);
        # secure=False -> STARTTLS oportunista (porta 587), padrao corporativo.
        await aiosmtplib.send(
            msg,
            hostname=host,
            port=port,
            username=user or None,
            password=senha or None,
            use_tls=secure,
            start_tls=not secure,
            tls_context=tls_context,
            timeout=30,
        )
        # SMTP nao retorna um id de provider (como o Resend). Usamos o Message-ID
        # gerado pelo ``aiosmtplib.send`` ao montar o envelope, quando presente.
        return SendEmailResult(ok=True, id=msg.get("Message-ID"))
    except aiosmtplib.SMTPException as e:
        msg_err = str(e)
        log.error(
            "SMTP retornou erro",
            extra={"subject": params.subject, "erro": msg_err},
        )
        return SendEmailResult(ok=False, error=msg_err)
    except (OSError, TimeoutError) as e:  # falha de rede/conexao com o relay
        msg_err = str(e)
        log.error(
            "Excecao de rede ao enviar e-mail",
            extra={"subject": params.subject, "erro": msg_err},
        )
        return SendEmailResult(ok=False, error=msg_err)


async def send_email_batch(
    emails: Sequence[EmailMessageParams],
) -> list[SendEmailResult]:
    """Envia e-mails em lote SEQUENCIAL (porta de ``sendEmailBatch``).

    Sequencial de proposito — respeita o rate-limit do relay, igual ao resend.ts.
    """
    resultados: list[SendEmailResult] = []
    for email in emails:
        resultados.append(await send_email(email))
    return resultados


__all__ = [
    "EmailMessageParams",
    "SendEmailResult",
    "send_email",
    "send_email_batch",
    "transport_enabled",
]
