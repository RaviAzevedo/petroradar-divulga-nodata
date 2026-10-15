"""Rota MIGRADA (estrangulador / strangler-fig):
    GET /api/cron/prazos

Espelho 1:1 de ``src/app/api/cron/prazos/route.ts`` — job diário (10h BRT pela
Vercel Cron) que também pode ser disparado manualmente com o header correto.

Responsabilidades:
  0. Atualiza fases de licitações vencidas → "Prazo Encerrado".
  1. Alertas de prazo crítico — licitações ALTA/MÉDIA perto do vencimento.

Os alertas de prazo de PARTICIPAÇÃO (portal/interno) e o reenvio de
notificações in-app saíram com o módulo Participações,
nos dois lados.

⚠️ DRIFT CONHECIDO: o alerta de prazo crítico do Next foi reescrito para UM
e-mail consolidado com dedup por banda (7/3/1/0 dias); este espelho ainda
manda um e-mail por licitação. O beat chama o Next (CRON_TARGET=web), então
este espelho não é o caminho efetivo.

──────────────────────────────────────────────────────────────────────────────
AUTENTICAÇÃO (réplica de ``verifyCronAuth(req)``)
──────────────────────────────────────────────────────────────────────────────
O Next:

    if (!verifyCronAuth(req)) {
      return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
    }

``verifyCronAuth`` (src/lib/security/secrets.ts):
  - se ``CRON_SECRET`` configurado → exige ``Authorization: Bearer <CRON_SECRET>``
    (comparação constant-time SHA-256 + timingSafeEqual);
  - sem ``CRON_SECRET`` (dev) → aceita ``x-vercel-cron: 1``.

Réplica: :func:`app.core.cron_auth.verify_cron_auth` (mesma lógica). Quando NÃO
autorizado, retornamos **401 ``{"error": "Não autorizado"}``** — exatamente o
body do Next (NÃO "Unauthorized" de ``require_cron``).

──────────────────────────────────────────────────────────────────────────────
PARIDADE DE QUERIES
──────────────────────────────────────────────────────────────────────────────
O Next mistura ``db.execute(sql...)`` (UPDATE da seção 0 — verbatim) com o
query-builder do Drizzle. Aqui TODAS as queries são reescritas em SQL bruto via
``sqlalchemy.text``. O ``hojeBrasilia()`` é replicado com ``zoneinfo`` (-03:00 civil).

Os templates de e-mail (``src/lib/email/templates.ts``) são portados inline com
o MESMO subject/HTML/text. O ``baseUrl`` lê ``NEXTAUTH_URL`` direto do ambiente
(paridade com o template do Next, que faz ``process.env.NEXTAUTH_URL ?? ...``).
O envio usa :func:`app.core.email.send_email` (SMTP on-prem; ``{ok, skipped?}``).
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.cron_auth import verify_cron_auth
from app.core.email import send_email
from app.db.session import SessionLocal

router = APIRouter()

# Roles de gestão (ROLES.ADMIN / ROLES.LIDER em src/lib/permissions.ts).
ROLE_ADMIN = "ADMIN"
ROLE_LIDER = "LIDER"

_SAO_PAULO = ZoneInfo("America/Sao_Paulo")

# baseUrl do template (NEXTAUTH_URL ?? "http://localhost:3000", via settings).
_BASE_URL = settings.nextauth_url or "http://localhost:3000"


# ── hojeBrasilia(): YYYY-MM-DD no fuso America/Sao_Paulo ──────────────────────


def _hoje_brasilia(agora: datetime | None = None) -> str:
    """Réplica de ``hojeBrasilia()``: data civil de Brasília no formato ISO."""
    base = agora if agora is not None else datetime.now(timezone.utc)
    return base.astimezone(_SAO_PAULO).strftime("%Y-%m-%d")


def _data_sp(d: datetime) -> str:
    """``en-CA`` (YYYY-MM-DD) da data ``d`` no fuso de Brasília."""
    return d.astimezone(_SAO_PAULO).strftime("%Y-%m-%d")


# ── Helpers de formatação (réplica de templates.ts) ──────────────────────────

_MESES_PT = [
    "janeiro", "fevereiro", "março", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
]


def _format_date_str(date_str: str) -> str:
    """``formatDateStr``: "DD de <mês> de YYYY" a partir de uma string YYYY-MM-DD."""
    partes = date_str.split("-")
    y, m, d = int(partes[0]), int(partes[1]), int(partes[2])
    return f"{d:02d} de {_MESES_PT[m - 1]} de {y}"


def _link_licitacao(lid: str) -> str:
    return f"{_BASE_URL}/licitacoes/{lid}"


def _layout(conteudo: str) -> str:
    ano = datetime.now().year
    return f"""<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>Petro Radar</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.12);">
          <!-- Header -->
          <tr>
            <td style="background:#0f172a;padding:20px 32px;">
              <span style="color:#f8fafc;font-size:20px;font-weight:700;letter-spacing:-0.5px;">
                Petro Radar
              </span>
              <span style="color:#94a3b8;font-size:13px;margin-left:12px;">Petro Radar</span>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              {conteudo}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0;">
              <p style="margin:0;color:#94a3b8;font-size:12px;text-align:center;">
                Este é um e-mail automático do sistema Petro Radar. Não responda este e-mail.<br/>
                © {ano} Petro Radar
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""


def _badge(cor: str, texto: str) -> str:
    return (
        f'<span style="display:inline-block;background:{cor};color:#fff;'
        f'padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;">{texto}</span>'
    )


def _button(href: str, texto: str) -> str:
    return (
        f'<a href="{href}" style="display:inline-block;background:#0f172a;color:#f8fafc;'
        f'padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;'
        f'font-size:14px;margin-top:20px;">{texto}</a>'
    )


def _info_row(label: str, value: str) -> str:
    return (
        '<tr>\n'
        f'    <td style="padding:6px 0;color:#64748b;font-size:13px;width:140px;vertical-align:top;">{label}</td>\n'
        f'    <td style="padding:6px 0;color:#0f172a;font-size:13px;font-weight:500;">{value}</td>\n'
        '  </tr>'
    )


# ── Template: Alerta de Prazo Crítico (Licitação) ────────────────────────────


def _template_prazo_critico_licitacao(
    licitacao_id: str,
    numero: str,
    objeto: str,
    empresa: str,
    relevancia: str,
    data_fim: str,
    hora_fim: str | None,
    dias_restantes: int,
) -> dict:
    cor_relevancia = "#dc2626" if relevancia == "ALTA" else "#d97706"
    urgencia = "URGENTE" if dias_restantes <= 1 else "ATENÇÃO"
    cor_urgencia = "#dc2626" if dias_restantes <= 1 else "#d97706"
    if dias_restantes == 0:
        prazo_label = "hoje"
    elif dias_restantes == 1:
        prazo_label = "amanhã"
    else:
        prazo_label = f"em {dias_restantes} dias"
    hora_str = f" às {hora_fim}" if hora_fim else ""

    subject = f"{urgencia}: Licitação {numero} vence {prazo_label} — Relevância {relevancia}"

    objeto_val = (objeto[:120] + "…" if len(objeto) > 120 else objeto) if objeto else "—"

    html = _layout(f"""
    <h2 style="margin:0 0 4px;color:#0f172a;font-size:22px;">Prazo Crítico de Licitação</h2>
    <p style="margin:0 0 24px;color:#64748b;font-size:14px;">
      {_badge(cor_urgencia, urgencia)} {_badge(cor_relevancia, relevancia)} Prazo encerra <strong>{prazo_label}{hora_str}</strong>
    </p>

    <table cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #e2e8f0;border-radius:6px;padding:16px;margin-bottom:24px;">
      {_info_row("Número", numero)}
      {_info_row("Empresa", empresa or "—")}
      {_info_row("Objeto", objeto_val)}
      {_info_row("Relevância", relevancia)}
      {_info_row("Data Fim", _format_date_str(data_fim) + hora_str)}
      {_info_row("Dias Restantes", str(dias_restantes))}
    </table>

    <p style="color:#64748b;font-size:14px;margin:0 0 8px;">
      Esta licitação está na fase <strong>"Recebendo Propostas"</strong> e possui relevância <strong>{relevancia}</strong>.
      Verifique se há interesse em participar antes do encerramento do prazo.
    </p>

    {_button(_link_licitacao(licitacao_id), "Ver Licitação →")}
  """)

    txt = (
        f"{urgencia}: Licitação {numero} vence {prazo_label}\n\n"
        f"Número: {numero}\nEmpresa: {empresa or '—'}\nObjeto: {objeto or '—'}\n"
        f"Relevância: {relevancia}\nData Fim: {data_fim}{hora_str}\n\n"
        f"Acesse: {_link_licitacao(licitacao_id)}"
    )

    return {"subject": subject, "html": html, "text": txt}




# ── Handler principal ─────────────────────────────────────────────────────────


@router.get("/api/cron/prazos")
async def cron_prazos(req: Request):
    if not verify_cron_auth(req):
        return JSONResponse({"error": "Não autorizado"}, status_code=401)

    agora = datetime.now(timezone.utc)
    stats = {
        "fasesAtualizadas": 0,
        "prazoCriticoAlerts": 0,
        "emailsEnviados": 0,
        "emailsFalhos": 0,
    }

    # Try/catch de topo: falha inesperada loga stats parciais e retorna 500.
    try:
        async with SessionLocal() as db:  # type: AsyncSession
            # ── 0. Atualizar fases de licitações vencidas ────────────────────
            hoje = _hoje_brasilia(agora)

            update_result = await db.execute(
                text(
                    """
                    UPDATE licitacoes
                    SET fase = 'Prazo Encerrado', atualizado_em = NOW()
                    WHERE fase IN ('Recebendo Propostas', 'Agendada (Futura)')
                      AND data_fim IS NOT NULL
                      AND data_fim != ''
                      AND data_fim < :hoje
                    """
                ),
                {"hoje": hoje},
            )
            await db.commit()

            stats["fasesAtualizadas"] = int(update_result.rowcount or 0)

            # ── 1. Alertas de prazo crítico — Licitações ALTA/MÉDIA ──────────
            hoje_str = _hoje_brasilia(agora)
            tres_dias = _data_sp(agora + timedelta(days=3))

            lics_proximas = (
                await db.execute(
                    text(
                        """
                        SELECT id, numero, objeto, empresa, relevancia, data_fim, hora_fim
                        FROM licitacoes
                        WHERE fase = 'Recebendo Propostas'
                          AND relevancia = ANY(:relevancias)
                          AND data_fim IS NOT NULL
                          AND data_fim >= :hoje
                          AND data_fim < :tres_dias
                        """
                    ),
                    {"relevancias": ["ALTA", "MÉDIA"], "hoje": hoje_str, "tres_dias": tres_dias},
                )
            ).mappings().all()

            if len(lics_proximas) > 0:
                destinatarios_lic = (
                    await db.execute(
                        text(
                            """
                            SELECT id, email, nome FROM users
                            WHERE role = ANY(:roles) AND ativo = true
                            """
                        ),
                        {"roles": ["ADMIN", "LIDER"]},
                    )
                ).mappings().all()

                for lic in lics_proximas:
                    if not lic["data_fim"]:
                        continue

                    # Fim do dia no fuso de Brasília (-03:00).
                    fim_date = datetime.fromisoformat(lic["data_fim"] + "T23:59:59-03:00")
                    dias_restantes = max(
                        0,
                        math.ceil((fim_date - agora).total_seconds() / (24 * 60 * 60)),
                    )

                    ja_notificado = (
                        await db.execute(
                            text(
                                """
                                SELECT id FROM historico_alteracoes
                                WHERE licitacao_id = :lid
                                  AND campo = 'alerta_prazo_critico'
                                  AND notificado = true
                                  AND detectado_em >= NOW() - INTERVAL '24 hours'
                                LIMIT 1
                                """
                            ),
                            {"lid": lic["id"]},
                        )
                    ).mappings().first()

                    if ja_notificado:
                        continue

                    template = _template_prazo_critico_licitacao(
                        licitacao_id=str(lic["id"]),
                        numero=lic["numero"],
                        objeto=lic["objeto"] or "",
                        empresa=lic["empresa"] or "",
                        relevancia=lic["relevancia"] or "ALTA",
                        data_fim=lic["data_fim"],
                        hora_fim=lic["hora_fim"] if lic["hora_fim"] is not None else None,
                        dias_restantes=dias_restantes,
                    )

                    emails = [u["email"] for u in destinatarios_lic if u["email"]]

                    if len(emails) == 0:
                        continue

                    resultado = await send_email(
                        to=emails,
                        subject=template["subject"],
                        html=template["html"],
                        text=template["text"],
                    )

                    await db.execute(
                        text(
                            """
                            INSERT INTO historico_alteracoes
                                (licitacao_id, campo, valor_anterior, valor_novo, notificado)
                            VALUES (:lid, 'alerta_prazo_critico', NULL, :valor_novo, true)
                            """
                        ),
                        {
                            "lid": lic["id"],
                            "valor_novo": f"{dias_restantes}d — enviado para {len(emails)} destinatário(s)",
                        },
                    )
                    await db.commit()

                    if resultado.get("ok"):
                        stats["emailsEnviados"] += 1
                    else:
                        stats["emailsFalhos"] += 1
                    stats["prazoCriticoAlerts"] += 1


            return JSONResponse(
                {"ok": True, "stats": stats, "executadoEm": agora.isoformat()}
            )
    except Exception:
        return JSONResponse({"error": "Erro interno"}, status_code=500)
