"""Rota migrada (strangler-fig): GET /api/cron/relatorio-mensal.

Espelho 1:1 do handler GET de
``src/app/api/cron/relatorio-mensal/route.ts`` (Next.js).

Relatório executivo mensal por e-mail. Coleta os dados
(``coletarDadosRelatorio``) e notifica a gestão (ADMIN/LIDER) via
``templateRelatorioMensal``, com os KPIs do mês no corpo e botão para a
página de Resultados. Sem anexo e sem download: o hub /relatorios e o XLSX
executivo foram removidos (Next e BFF juntos).

⚠ DRIFT CONHECIDO: o template do Next foi redesenhado (layout único da marca);
este espelho mantém o HTML antigo. O beat chama o Next (CRON_TARGET=web).

AUTH (cron, sem sessão NextAuth):
  ``autorizarCron`` (réplica EXATA do helper LOCAL do route.ts, NÃO o
  ``verifyCronAuth`` compartilhado):

      const cronSecret = process.env.CRON_SECRET;
      if (cronSecret) {
        const authHeader = req.headers.get("authorization") ?? "";
        return authHeader === `Bearer ${cronSecret}`;   // igualdade simples
      }
      return req.headers.get("x-vercel-cron") === "1";

  Diferença vs. ``app.core.cron_auth``: o route.ts usa igualdade simples (``===``)
  e NÃO aceita o header ``x-cron-secret``. Replicamos o helper local fielmente.
  Falha → 401 ``{"error": "Não autorizado"}`` (mesmo shape/idioma do Next).

GATE gracioso:
  ``config.crons.relatorioMensal.habilitado`` =
  flag(``CRON_RELATORIO_MENSAL_ENABLED``, default True). Desabilitado →
  200 ``{"ok": true, "skipped": true, "motivo": "cron desabilitado"}``.

DESTINATÁRIOS (``getDestinatariosGestao``):
  ``SELECT email FROM users WHERE ativo = true AND role IN (ADMIN, LIDER)`` →
  ``rows.map(u => u.email).filter(Boolean)``. Vazio →
  200 ``{"ok": true, "enviado": false, "motivo": "sem destinatários"}``.

COLETA:
  Reusa ``_coletar_dados_relatorio`` de ``_relatorio_executivo_lib`` — réplica de
  ``coletarDadosRelatorio(12)``. Erro na coleta → 500
  ``{"error": "Falha ao gerar relatório"}``.

E-MAIL:
  ``send_email`` (app.core.email, aiosmtplib) — substitui ``sendEmail``
  (resend.ts). Retorna ``{ok}``; o JSON de resposta reflete ``enviado``.

Resposta de sucesso (paridade):
  ``{"ok": true, "enviado": <bool>, "mesLabel": <str>,
     "destinatarios": <int>}``.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.config import get_settings, settings
from app.core.cron_auth import safe_equal
from app.core.email import send_email
from app.db.session import SessionLocal

# Reusa a coleta de dados (espelho de coletarDadosRelatorio, executivo-dados.ts).
from app.routers.migrated._relatorio_executivo_lib import _coletar_dados_relatorio

# Réplica canônica de ``flag`` (config.ts) — consolidada em _shared.
from app.routers.migrated._shared import flag as _flag

router = APIRouter()


# ── baseUrl (templates.ts): process.env.NEXTAUTH_URL ?? "http://localhost:3000" ─
BASE_URL = settings.nextauth_url or "http://localhost:3000"


# ── config.crons.relatorioMensal.habilitado (config.ts) ───────────────────────
def _relatorio_mensal_habilitado() -> bool:
    return _flag(settings.cron_relatorio_mensal_enabled, True)


# ── autorizarCron (helper LOCAL do route.ts — sem x-cron-secret) ──────────────
def _autorizar_cron(request: Request) -> bool:
    # Constant-time (safe_equal): mesmo resultado booleano da igualdade simples,
    # sem canal de timing (hardening 02/07).
    settings = get_settings()
    cron_secret = settings.cron_secret
    if cron_secret:
        auth_header = request.headers.get("authorization") or ""
        return safe_equal(auth_header, f"Bearer {cron_secret}")
    return request.headers.get("x-vercel-cron") == "1"


# ── getDestinatariosGestao ────────────────────────────────────────────────────
async def _get_destinatarios_gestao(db) -> list[str]:
    """Réplica de getDestinatariosGestao:

        db.select({ email })
          .from(users)
          .where(and(eq(ativo, true), inArray(role, [ADMIN, LIDER])))
        → rows.map(u => u.email).filter(Boolean)
    """
    sql = text(
        """
        SELECT email
        FROM users
        WHERE ativo = true
          AND role IN ('ADMIN', 'LIDER')
        """
    )
    rows = (await db.execute(sql)).mappings().all()
    # .filter(Boolean): descarta None e string vazia (falsy no JS).
    return [r["email"] for r in rows if r["email"]]


# ── fmtBRL: v.toLocaleString("pt-BR", {style:"currency", currency:"BRL"}) ──────
def _fmt_brl(v: float) -> str:
    """Replica o agrupamento pt-BR de moeda: "R$ 1.234.567,89"."""
    neg = v < 0
    inteiro = int(abs(v) * 100 + 0.5)  # centavos arredondados (half-up p/ +∞)
    centavos = inteiro % 100
    reais = inteiro // 100
    s = str(reais)
    partes = []
    while len(s) > 3:
        partes.insert(0, s[-3:])
        s = s[:-3]
    partes.insert(0, s)
    inteiro_fmt = ".".join(partes)
    sinal = "-" if neg else ""
    return f"{sinal}R$\xa0{inteiro_fmt},{centavos:02d}"


# ── MESES (label do mês de referência) ────────────────────────────────────────
MESES = [
    "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
]


# ── Template: templateRelatorioMensal (email/templates.ts) ────────────────────
def _layout(conteudo: str) -> str:
    """Replica ``layout`` de templates.ts."""
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


def _button(href: str, texto: str) -> str:
    """Replica ``button`` de templates.ts."""
    return (
        f'<a href="{href}" style="display:inline-block;background:#0f172a;'
        f"color:#f8fafc;padding:12px 24px;border-radius:6px;text-decoration:none;"
        f'font-weight:600;font-size:14px;margin-top:20px;">{texto}</a>'
    )


def _kpi_card(k: dict) -> str:
    """Replica ``kpiCard`` de templates.ts."""
    tendencia = k.get("tendencia")
    cor_var = (
        "#16a34a"
        if tendencia == "up"
        else "#dc2626"
        if tendencia == "down"
        else "#64748b"
    )
    variacao = k.get("variacao")
    bloco_var = (
        f'<p style="margin:4px 0 0;color:{cor_var};font-size:12px;font-weight:600;">{variacao}</p>'
        if variacao
        else ""
    )
    return (
        '<td style="padding:8px;width:50%;vertical-align:top;">\n'
        '    <div style="border:1px solid #e2e8f0;border-radius:6px;padding:14px;">\n'
        f'      <p style="margin:0 0 4px;color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:.3px;">{k["rotulo"]}</p>\n'
        f'      <p style="margin:0;color:#0f172a;font-size:22px;font-weight:700;">{k["valor"]}</p>\n'
        f"      {bloco_var}\n"
        "    </div>\n"
        "  </td>"
    )


def _kpi_grid(kpis: list[dict]) -> str:
    """Replica ``kpiGrid`` de templates.ts."""
    if len(kpis) == 0:
        return ""
    rows: list[str] = []
    i = 0
    while i < len(kpis):
        a = _kpi_card(kpis[i])
        b = _kpi_card(kpis[i + 1]) if i + 1 < len(kpis) else '<td style="width:50%;"></td>'
        rows.append(f"<tr>{a}{b}</tr>")
        i += 2
    return (
        '<table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:24px;">'
        + "".join(rows)
        + "</table>"
    )


def _template_relatorio_mensal(
    mes_label: str, kpis: list[dict], observacoes: list[str]
) -> dict:
    """Replica ``templateRelatorioMensal`` de templates.ts → {subject, html, text}."""
    subject = f"Relatório Executivo Petro Radar — {mes_label}"

    if observacoes and len(observacoes) > 0:
        itens = "".join(
            f'<li style="color:#0f172a;font-size:13px;margin-bottom:6px;">{o}</li>'
            for o in observacoes
        )
        bloco_obs = (
            '\n    <p style="margin:0 0 8px;color:#0f172a;font-size:15px;font-weight:600;">Destaques do mês</p>\n'
            '    <ul style="margin:0 0 24px;padding-left:20px;">\n'
            f"      {itens}\n"
            "    </ul>"
        )
    else:
        bloco_obs = ""

    html = _layout(
        f"""
    <h2 style="margin:0 0 4px;color:#0f172a;font-size:22px;">Relatório Executivo Mensal</h2>
    <p style="margin:0 0 24px;color:#64748b;font-size:14px;">Referência: <strong>{mes_label}</strong></p>

    {_kpi_grid(kpis)}
    {bloco_obs}

    {_button(f"{BASE_URL}/resultados", "Abrir os Resultados →")}
  """
    )

    text_kpis = "\n".join(
        f"- {k['rotulo']}: {k['valor']}" + (f" ({k['variacao']})" if k.get("variacao") else "")
        for k in kpis
    )
    text_obs = (
        "\nDestaques do mês:\n"
        + "\n".join(f"  • {o}" for o in observacoes)
        if observacoes and len(observacoes) > 0
        else ""
    )

    text = "\n".join(
        [
            f"Relatório Executivo Petro Radar — {mes_label}",
            text_kpis,
            text_obs,
            f"\nAcesse: {BASE_URL}/resultados",
        ]
    )

    return {"subject": subject, "html": html, "text": text}


# ── Handler ───────────────────────────────────────────────────────────────────
@router.get("/api/cron/relatorio-mensal")
async def relatorio_mensal(request: Request):
    """GET /api/cron/relatorio-mensal — espelho 1:1 do handler GET do Next."""
    if not _autorizar_cron(request):
        return JSONResponse({"error": "Não autorizado"}, status_code=401)

    if not _relatorio_mensal_habilitado():
        return JSONResponse({"ok": True, "skipped": True, "motivo": "cron desabilitado"})

    async with SessionLocal() as db:
        destinatarios = await _get_destinatarios_gestao(db)
        if len(destinatarios) == 0:
            # log.warn("nenhum destinatário de gestão")
            return JSONResponse(
                {"ok": True, "enviado": False, "motivo": "sem destinatários"}
            )

        # Mês de referência = mês anterior ao corrente.
        agora = datetime.now()
        ano_ref = agora.year
        mes_ref = agora.month - 1  # 1..12; pode virar 0
        if mes_ref < 1:
            # new Date(ano, -1, 1) → dezembro do ano anterior (paridade JS).
            mes_ref += 12
            ano_ref -= 1
        mes_label = f"{MESES[mes_ref - 1]}/{ano_ref}"

        # coletarDadosRelatorio(12) — erro → 500 JSON.
        try:
            dados = await _coletar_dados_relatorio(db, 12)
        except Exception:
            # log.error("falha ao gerar relatório mensal", e)
            return JSONResponse({"error": "Falha ao gerar relatório"}, status_code=500)

    r = dados["performance"]["resumo"]
    delta = r["delta"]
    tendencia = "up" if delta > 0 else "down" if delta < 0 else "neutral"
    kpis: list[dict] = [
        {
            "rotulo": "Taxa de sucesso",
            "valor": f"{_num(r['taxaSucessoAtual'])}%",
            "variacao": f"{'+' if delta >= 0 else ''}{_num(delta)} p.p.",
            "tendencia": tendencia,
        },
        {"rotulo": "Valor ganho (12m)", "valor": _fmt_brl(r["valorGanho12m"])},
        {"rotulo": "Participações (12m)", "valor": str(dados["participacoes"]["totais"]["total"])},
        {"rotulo": "Vitórias (12m)", "valor": str(dados["participacoes"]["totais"]["ganhou"])},
    ]

    lacunas_com_demanda = [l for l in dados["lacunasCrc"] if l["demandaRecente"] > 0]
    observacoes: list[str] = []
    if len(lacunas_com_demanda) > 0:
        observacoes.append(
            f"{len(lacunas_com_demanda)} família(s) CRC sem aprovação com demanda recente — priorizar renovação."
        )
        for l in lacunas_com_demanda[:3]:
            observacoes.append(
                f"{l['codigoCrc']} — {l['nome']}: {l['demandaRecente']} licitação(ões) recente(s)."
            )
    tpl = _template_relatorio_mensal(
        mes_label=mes_label,
        kpis=kpis,
        observacoes=observacoes,
    )

    resultado = await send_email(
        to=destinatarios,
        subject=tpl["subject"],
        html=tpl["html"],
        text=tpl["text"],
    )

    # log.info("relatório mensal enviado", {...})

    return JSONResponse(
        {
            "ok": True,
            "enviado": bool(resultado.get("ok")),
            "mesLabel": mes_label,
            "destinatarios": len(destinatarios),
        }
    )


def _num(v: float) -> object:
    """Espelha o ``String(n)`` do JS para números: inteiro sem ".0"."""
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v
