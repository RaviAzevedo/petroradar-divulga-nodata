"""Rota MIGRADA (estrangulador / strangler-fig):

    GET  /api/cron/sync-monitor — Vercel Cron a cada 2h
    POST /api/cron/sync-monitor — GitHub Actions on failure

Espelho 1:1 de ``src/app/api/cron/sync-monitor/route.ts`` (Next.js) + as libs que
ele importa (``@/lib/email/resend`` → :func:`app.core.email.send_email`,
``@/lib/email/templates`` → :func:`_template_sync_falhou` inlinado abaixo,
``@/lib/security/secrets`` → ``verifyCronAuth``/``verifyBearer`` replicados,
``@/lib/observability/logger`` → ``logging`` stdlib).

Monitora a saúde do pipeline de sync (GitHub Actions → DB). Envia alertas por
e-mail para admins quando:
  - Sync não roda há mais de 6 horas
  - Último sync registrou erros
  - Último sync encontrou 0 licitações

──────────────────────────────────────────────────────────────────────────────
AUTENTICAÇÃO
──────────────────────────────────────────────────────────────────────────────
GET  → ``verifyCronAuth(req)``: se ``CRON_SECRET`` configurado, exige
       ``Authorization: Bearer <CRON_SECRET>`` (constant-time); senão aceita o
       header ``x-vercel-cron: 1``. Sem auth → 401 ``{"error": "Não autorizado"}``.
POST → se ``CRON_SECRET`` configurado, exige ``verifyBearer(req, CRON_SECRET)``
       (constant-time); sem secret (dev) o POST passa direto. Sem auth →
       401 ``{"error": "Não autorizado"}``.

Tanto ``verifyCronAuth`` quanto ``verifyBearer``/``safeEqual`` aplicam SHA-256 nos
dois lados antes do ``timingSafeEqual`` (aqui ``hmac.compare_digest``). O segredo
é ``settings.cron_secret`` (alias ``CRON_SECRET``).

──────────────────────────────────────────────────────────────────────────────
DETALHES DE PARIDADE
──────────────────────────────────────────────────────────────────────────────
  - ``executado_em`` é ``timestamp WITHOUT TIME ZONE`` (Drizzle). O lado Next roda
    com ``TZ=America/Sao_Paulo`` e usa node-postgres (``pg``), que interpreta o
    naive como wall-clock NO FUSO DO PROCESSO (São Paulo). ``getTime()`` então dá
    o instante UTC correspondente. Replicamos via :func:`_to_utc` (naive de São
    Paulo → aware-UTC), igual ao ``admin/saude-scraper``.
  - ``GITHUB_REPO``: o Next o lê de ``process.env`` →
    aqui lemos via ``settings`` (campos-espelho, default "" = ausente; mesmos
    fallbacks aplicados aqui).
  - O ``revalidateTag(...)`` das páginas de analytics é um efeito de cache do
    Next App Router. No BFF on-prem não há esse cache de página; replicamos como no-op
    logado (apenas o ``log.info`` correspondente), preservando o restante do fluxo.
  - ``getAdminEmails()``: ``SELECT email FROM users WHERE role='ADMIN' AND ativo``
    (verbatim), filtrando emails vazios/None (``.filter(Boolean)``).
  - O e-mail é enviado via :func:`app.core.email.send_email` (SMTP/aiosmtplib),
    que devolve ``{"ok": bool, ...}`` — usamos ``["ok"]`` como o ``resultado.ok``.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import math
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.config import settings
from app.core.email import send_email
from app.db.session import SessionLocal

router = APIRouter()

log = logging.getLogger("petro.cron.sync-monitor")


# ── Constantes espelhadas de route.ts ─────────────────────────────────────────

#: process.env.GITHUB_REPOSITORY ?? "org/repo"
GITHUB_REPO: str = settings.github_repository or "org/repo"

#: 14h cobre a janela noturna do calendario de sync. Era 6h — resquicio de
#: quando o sync rodava de 30 em 30 min; com janelas diarias, fazia o
#: monitor acusar parada TODA madrugada. MESMO valor do Next.
MAX_HORAS_SEM_SYNC: int = 14

#: Limite de horas sem sync por tipo (espelha MAX_HORAS_POR_TIPO).
#: Os limites ficam ~30% acima da maior janela real entre execucoes de cada
#: tipo (um limite folgado demais esconde parada). MESMOS valores do Next.
MAX_HORAS_POR_TIPO: dict[str, int] = {
    "todas": 18,
    "abertas": 24,
    "andamento": 24,
    "concluidas": 24,
    "resultados": 20,
    "circulares": 24,
    "transparencia": 30,
    "concluidas_historico": 24 * 60,
    "petronect_v2": 20,
}


# ── Fuso do processo Next (paridade de TIMEZONE) ──────────────────────────────
#
# ``executado_em`` é ``timestamp WITHOUT TIME ZONE``. O lado Next roda com
# ``TZ=America/Sao_Paulo`` e usa node-postgres: o naive vira ``Date`` no fuso do
# processo (São Paulo) e ``getTime()`` dá o instante UTC. Replicamos: anexamos o
# fuso de São Paulo ao naive e convertemos para UTC.
_TZ_SAO_PAULO_FIXO = timezone(timedelta(hours=-3))
try:  # pragma: no cover - depende da presença de tzdata no ambiente
    from zoneinfo import ZoneInfo

    TZ_SAO_PAULO = ZoneInfo("America/Sao_Paulo")
except Exception:  # ZoneInfoNotFoundError / ImportError → offset fixo (-03:00).
    TZ_SAO_PAULO = _TZ_SAO_PAULO_FIXO


def _und(v: Any) -> Any:
    """Réplica da renderização JS de campos ``undefined`` em template strings.

    No Next, ``const { evento, modo, erro } = body`` deixa campos ausentes como
    ``undefined``; interpolados em ``` `${evento} (${modo})` ``` o JS renderiza o
    literal ``"undefined"``. No BFF os campos ausentes vêm como ``None``; aqui os
    normalizamos para a string ``"undefined"`` antes de interpolar, restaurando a
    paridade 1:1 (``"None"`` → ``"undefined"``).
    """
    return "undefined" if v is None else v


def _to_utc(executado_em: Optional[datetime]) -> Optional[datetime]:
    """Naive de São Paulo → ``datetime`` aware-UTC (paridade com ``new Date(...)``).

    O ``pg`` (node-postgres) lê o ``timestamp without time zone`` como wall-clock
    no fuso do processo Next (``America/Sao_Paulo``). Anexamos o fuso de São Paulo
    ao naive e convertemos para UTC. Se já vier aware (defensivo), normalizamos.
    """
    if executado_em is None:
        return None
    if executado_em.tzinfo is None:
        return executado_em.replace(tzinfo=TZ_SAO_PAULO).astimezone(timezone.utc)
    return executado_em.astimezone(timezone.utc)


# ── Réplica de safeEqual / verifyCronAuth / verifyBearer (secrets.ts) ─────────


def _safe_equal(a: Optional[str], b: Optional[str]) -> bool:
    """Réplica de ``safeEqual``: SHA-256 nos dois lados + compare_digest.

    Retorna ``False`` se qualquer lado for ``None`` (``if (a == null || b == null)``).
    """
    if a is None or b is None:
        return False
    ha = hashlib.sha256(a.encode("utf-8")).digest()
    hb = hashlib.sha256(b.encode("utf-8")).digest()
    return hmac.compare_digest(ha, hb)


def _verify_cron_auth(request: Request) -> bool:
    """Réplica de ``verifyCronAuth(req)``.

    Se ``CRON_SECRET`` configurado → SEMPRE exige ``Authorization: Bearer <secret>``
    (constant-time). Senão → aceita ``x-vercel-cron: 1``.
    """
    cron_secret = settings.cron_secret
    if cron_secret:
        auth_header = request.headers.get("authorization") or request.headers.get(
            "Authorization"
        ) or ""
        return _safe_equal(auth_header, f"Bearer {cron_secret}")
    return request.headers.get("x-vercel-cron") == "1"


def _verify_bearer(request: Request, expected_secret: Optional[str]) -> bool:
    """Réplica de ``verifyBearer(req, expectedSecret)``.

    Retorna ``False`` se ``expected_secret`` for vazio/None. Senão compara
    constant-time o header ``Authorization`` (ou "") contra ``"Bearer " + secret``.
    """
    if not expected_secret:
        return False
    auth_header = request.headers.get("authorization") or request.headers.get(
        "Authorization"
    ) or ""
    return _safe_equal(auth_header, f"Bearer {expected_secret}")


# ── Réplica dos helpers de template (templates.ts) ────────────────────────────


def _layout(conteudo: str) -> str:
    """Réplica de ``layout(conteudo)`` — wrapper HTML do e-mail."""
    ano = datetime.now().year
    return (
        """<!DOCTYPE html>
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
              """
        + conteudo
        + """
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0;">
              <p style="margin:0;color:#94a3b8;font-size:12px;text-align:center;">
                Este é um e-mail automático do sistema Petro Radar. Não responda este e-mail.<br/>
                © """
        + str(ano)
        + """ Petro Radar
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""
    )


def _badge(cor: str, texto: str) -> str:
    """Réplica de ``badge(cor, texto)``."""
    return (
        f'<span style="display:inline-block;background:{cor};color:#fff;'
        f'padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;">'
        f"{texto}</span>"
    )


def _button(href: str, texto: str) -> str:
    """Réplica de ``button(href, texto)``."""
    return (
        f'<a href="{href}" style="display:inline-block;background:#0f172a;'
        f'color:#f8fafc;padding:12px 24px;border-radius:6px;text-decoration:none;'
        f'font-weight:600;font-size:14px;margin-top:20px;">{texto}</a>'
    )


def _info_row(label: str, value: str) -> str:
    """Réplica de ``infoRow(label, value)``."""
    return (
        f'<tr>\n'
        f'    <td style="padding:6px 0;color:#64748b;font-size:13px;width:140px;'
        f'vertical-align:top;">{label}</td>\n'
        f'    <td style="padding:6px 0;color:#0f172a;font-size:13px;'
        f'font-weight:500;">{value}</td>\n'
        f"  </tr>"
    )


def _template_sync_falhou(dados: dict[str, Any]) -> dict[str, str]:
    """Réplica de ``templateSyncFalhou(dados)`` → ``{subject, html, text}``.

    ``dados`` contém: tipo, executadoEm, erros, totalEncontradas, detalhes,
    horasSemSync? (None se ausente), githubRepo?.
    """
    horas_sem_sync = dados.get("horasSemSync")
    # const desatualizado = (dados.horasSemSync ?? 0) > 0;
    desatualizado = (horas_sem_sync if horas_sem_sync is not None else 0) > 0

    erros = dados.get("erros")
    if desatualizado:
        subject = (
            f"[Petro Radar] Alerta: Sync desatualizado "
            f"({horas_sem_sync}h sem execução)"
        )
    else:
        subject = f"[Petro Radar] Alerta: Sync falhou — {erros} erro(s)"

    cor_badge = "#d97706" if desatualizado else "#dc2626"
    label_badge = "DESATUALIZADO" if desatualizado else "FALHA"

    github_repo = dados.get("githubRepo")
    actions_link = (
        f"https://github.com/{github_repo}/actions" if github_repo else None
    )

    tipo = dados.get("tipo")
    executado_em = dados.get("executadoEm")
    total_encontradas = dados.get("totalEncontradas")
    detalhes = dados.get("detalhes")

    # ${dados.horasSemSync ? infoRow("Horas sem sync", `${...}h`) : ""}
    linha_horas = (
        _info_row("Horas sem sync", f"{horas_sem_sync}h") if horas_sem_sync else ""
    )

    # ${dados.detalhes ? `<div ...>` : ""}
    if detalhes:
        detalhes_truncado = (
            detalhes[:500] + "…" if len(detalhes) > 500 else detalhes
        )
        bloco_detalhes = (
            '\n    <div style="background:#fef2f2;border:1px solid #fecaca;'
            'border-radius:6px;padding:16px;margin-bottom:24px;">\n'
            '      <p style="margin:0 0 4px;color:#991b1b;font-size:13px;'
            'font-weight:600;">Detalhes</p>\n'
            '      <p style="margin:0;color:#991b1b;font-size:13px;'
            f'white-space:pre-wrap;">{detalhes_truncado}</p>\n'
            "    </div>\n    "
        )
    else:
        bloco_detalhes = ""

    if desatualizado:
        paragrafo = (
            "O sync não é executado há mais de 6 horas. Verifique se o GitHub "
            "Actions está rodando corretamente."
        )
    else:
        paragrafo = (
            "A última execução do sync registrou erros. Verifique os logs do "
            "GitHub Actions para mais detalhes."
        )

    botao = _button(actions_link, "Ver GitHub Actions →") if actions_link else ""

    html = _layout(
        f"""
    <h2 style="margin:0 0 4px;color:#0f172a;font-size:22px;">Alerta de Sincronização</h2>
    <p style="margin:0 0 24px;color:#64748b;font-size:14px;">
      {_badge(cor_badge, label_badge)} Tipo: <strong>{tipo}</strong>
    </p>

    <table cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #e2e8f0;border-radius:6px;padding:16px;margin-bottom:24px;">
      {_info_row("Tipo", str(tipo))}
      {_info_row("Executado em", str(executado_em))}
      {_info_row("Total encontradas", str(total_encontradas))}
      {_info_row("Erros", str(erros))}
      {linha_horas}
    </table>

    {bloco_detalhes}

    <p style="color:#64748b;font-size:14px;margin:0 0 8px;">
      {paragrafo}
    </p>

    {botao}
  """
    )

    text = "\n".join(
        [
            p
            for p in [
                f"ALERTA: Sync {'desatualizado' if desatualizado else 'falhou'}",
                f"Tipo: {tipo}",
                f"Executado em: {executado_em}",
                f"Total encontradas: {total_encontradas}",
                f"Erros: {erros}",
                f"Horas sem sync: {horas_sem_sync}h" if horas_sem_sync else "",
                f"Detalhes: {detalhes}" if detalhes else "",
                f"GitHub Actions: {actions_link}" if actions_link else "",
            ]
            if p
        ]
    )

    return {"subject": subject, "html": html, "text": text}


# ── getAdminEmails (route.ts) ─────────────────────────────────────────────────


async def _get_admin_emails(db) -> list[str]:
    """Réplica de ``getAdminEmails()``.

    ``SELECT email FROM users WHERE role='ADMIN' AND ativo=true`` →
    ``.map(u => u.email).filter(Boolean)`` (descarta vazios/None).
    """
    result = await db.execute(
        text(
            "SELECT email FROM users WHERE role = :role AND ativo = :ativo"
        ),
        {"role": "ADMIN", "ativo": True},
    )
    rows = result.all()
    return [r._mapping["email"] for r in rows if r._mapping["email"]]


# ── formatTimestamp (route.ts) ────────────────────────────────────────────────


def _format_timestamp(date: datetime) -> str:
    """Réplica de ``formatTimestamp(date)``.

    ``date.toLocaleString("pt-BR", {day,month,year,hour,minute,
    timeZone:"America/Sao_Paulo"})`` → "DD/MM/YYYY HH:MM".

    O Next recebe um ``Date`` (instante UTC) e o formata NO FUSO de São Paulo.
    Aqui ``date`` já é aware-UTC (vem de :func:`_to_utc` ou ``datetime.now(utc)``);
    convertemos para São Paulo e formatamos como o ``Intl`` pt-BR (vírgula entre
    data e hora).
    """
    if date.tzinfo is None:
        date = date.replace(tzinfo=timezone.utc)
    local = date.astimezone(TZ_SAO_PAULO)
    return (
        f"{local.day:02d}/{local.month:02d}/{local.year:04d}, "
        f"{local.hour:02d}:{local.minute:02d}"
    )


# ══════════════════════════════════════════════════════════════════════════════
# GET: Vercel Cron — verifica saúde do sync a cada 2h
# ══════════════════════════════════════════════════════════════════════════════


@router.get("/api/cron/sync-monitor")
async def get_sync_monitor(request: Request) -> JSONResponse:
    """GET /api/cron/sync-monitor (réplica verbatim do Next)."""
    # if (!verifyCronAuth(req)) → 401 { error: "Não autorizado" }
    if not _verify_cron_auth(request):
        return JSONResponse(content={"error": "Não autorizado"}, status_code=401)

    # const agora = new Date();
    agora = datetime.now(tz=timezone.utc)

    async with SessionLocal() as db:
        # ── Última execução por tipo (MAX(executado_em) GROUP BY tipo) ─────────
        # C1 (paridade com o Next e com o catch-up A1): gap por tipo sobre o
        # ultimo run que NAO foi FALHA de task. Linhas de falha
        # (_grava_sync_log_falha grava detalhes 'FALHA na task do worker: ...'
        # com executado_em=NOW()) refrescariam o MAX -> scraper que roda-e-sempre
        # -falha nunca dispararia o alerta de gap. (erros e contador por-item.)
        result = await db.execute(
            text(
                "SELECT tipo, MAX(executado_em) FILTER ("
                "  WHERE COALESCE(detalhes, '') NOT LIKE :falha_prefix"
                ") AS max_executado_em "
                "FROM sync_log GROUP BY tipo"
            ),
            {"falha_prefix": "FALHA na task do worker:%"},
        )
        ultimos_por_tipo = [dict(r._mapping) for r in result.all()]

        # if (ultimosPorTipo.length === 0) → { ok, alerta:false, motivo }
        if len(ultimos_por_tipo) == 0:
            return JSONResponse(
                content={
                    "ok": True,
                    "alerta": False,
                    "motivo": "Nenhum sync_log encontrado",
                }
            )

        # ── Detecta tipos críticos com gap excedente ───────────────────────────
        tipos_em_atraso: list[dict[str, Any]] = []
        for linha in ultimos_por_tipo:
            max_executado_em = linha["max_executado_em"]
            if not max_executado_em:
                continue
            limite = MAX_HORAS_POR_TIPO.get(linha["tipo"])
            if not limite:  # tipo desconhecido — ignora
                continue
            ultima = _to_utc(max_executado_em)
            horas = math.floor(
                (agora.timestamp() - ultima.timestamp()) / (60 * 60)
            )
            if horas >= limite:
                tipos_em_atraso.append(
                    {"tipo": linha["tipo"], "horasSemSync": horas, "limite": limite}
                )

        # ── Último sync_log global (detecta erros e legacy) ────────────────────
        result_ultimo = await db.execute(
            text(
                "SELECT id, tipo, total_encontradas, novas, atualizadas, erros, "
                "detalhes, executado_em "
                "FROM sync_log ORDER BY executado_em DESC LIMIT 1"
            )
        )
        ultimo_row = result_ultimo.first()
        ultimo_sync = dict(ultimo_row._mapping) if ultimo_row is not None else None

        # const executadoEm = ultimoSync?.executadoEm ?? agora;
        if ultimo_sync is not None and ultimo_sync.get("executado_em") is not None:
            executado_em = _to_utc(ultimo_sync["executado_em"])
        else:
            executado_em = agora

        horas_sem_sync_global = math.floor(
            (agora.timestamp() - executado_em.timestamp()) / (60 * 60)
        )

        motivo: Optional[str] = None

        ultimo_erros = (ultimo_sync.get("erros") if ultimo_sync else None) or 0
        ultimo_total = (
            ultimo_sync.get("total_encontradas") if ultimo_sync else None
        ) or 0
        ultimo_tipo = ultimo_sync.get("tipo") if ultimo_sync else None
        ultimo_detalhes = (ultimo_sync.get("detalhes") if ultimo_sync else None) or ""
        ultimo_id = ultimo_sync.get("id") if ultimo_sync else None

        if len(tipos_em_atraso) > 0:
            motivo = "Tipos de sync com gap excedido: " + "; ".join(
                f"{g['tipo']} ({g['horasSemSync']}h, limite {g['limite']}h)"
                for g in tipos_em_atraso
            )
        elif horas_sem_sync_global >= MAX_HORAS_SEM_SYNC:
            motivo = (
                f"Sync global não roda há {horas_sem_sync_global}h "
                f"(limite: {MAX_HORAS_SEM_SYNC}h)"
            )
        elif ultimo_erros > 0:
            motivo = f"Último sync registrou {ultimo_erros} erro(s)"
        elif ultimo_total == 0 and ultimo_tipo == "todas":
            motivo = "Último sync 'todas' encontrou 0 licitações"

        if not motivo:
            # Sync OK + recente → invalida cache de analytics (no-op no on-prem).
            if horas_sem_sync_global < 1:
                # Next 16: revalidateTag(...) das páginas de analytics. No BFF on-prem não
                # há cache de página App Router; replicamos como no-op logado.
                log.info("cache de analytics invalidado (sync recente)")
            return JSONResponse(
                content={
                    "ok": True,
                    "alerta": False,
                    "ultimoSync": ultimo_id,
                    "horasSemSyncGlobal": horas_sem_sync_global,
                    "tiposVerificados": len(ultimos_por_tipo),
                }
            )

        # ── Idempotência ───────────────────────────────────────────────────────
        if len(tipos_em_atraso) > 0:
            chave_idempotencia = (
                "[ALERTED-GAP:"
                + ",".join(sorted(t["tipo"] for t in tipos_em_atraso))
                + "]"
            )
        else:
            chave_idempotencia = "[ALERTED]"

        ja_alertado = chave_idempotencia in ultimo_detalhes
        if ja_alertado:
            return JSONResponse(
                content={
                    "ok": True,
                    "alerta": False,
                    "motivo": "Alerta já enviado",
                    "ultimoSync": ultimo_id,
                }
            )

        emails = await _get_admin_emails(db)
        if len(emails) == 0:
            log.warning("nenhum admin com email encontrado")
            return JSONResponse(
                content={
                    "ok": True,
                    "alerta": True,
                    "motivo": motivo,
                    "emailEnviado": False,
                    "razao": "Sem admins",
                }
            )

        # ── Monta e envia o template ───────────────────────────────────────────
        if len(tipos_em_atraso) > 0:
            template_tipo = "gap por tipo: " + ", ".join(
                t["tipo"] for t in tipos_em_atraso
            )
        else:
            template_tipo = ultimo_tipo if ultimo_tipo is not None else "?"

        if len(tipos_em_atraso) > 0:
            horas_sem_sync_template = max(t["horasSemSync"] for t in tipos_em_atraso)
        elif horas_sem_sync_global >= MAX_HORAS_SEM_SYNC:
            horas_sem_sync_template = horas_sem_sync_global
        else:
            horas_sem_sync_template = None

        template = _template_sync_falhou(
            {
                "tipo": template_tipo,
                "executadoEm": _format_timestamp(executado_em),
                "erros": ultimo_erros,
                "totalEncontradas": ultimo_total,
                "detalhes": motivo,
                "horasSemSync": horas_sem_sync_template,
                "githubRepo": GITHUB_REPO,
            }
        )

        resultado = await send_email(
            to=emails,
            subject=template["subject"],
            html=template["html"],
            text=template["text"],
        )
        resultado_ok = bool(resultado.get("ok"))

        # if (resultado.ok && ultimoSync) → grava a chave de idempotência.
        if resultado_ok and ultimo_sync is not None:
            novo_detalhe = " ".join(
                p for p in [ultimo_sync.get("detalhes") or "", chave_idempotencia] if p
            )
            await db.execute(
                text("UPDATE sync_log SET detalhes = :detalhes WHERE id = :id"),
                {"detalhes": novo_detalhe, "id": ultimo_id},
            )
            await db.commit()

        log.info(
            "alerta enviado",
            extra={
                "motivo": motivo,
                "tiposEmAtraso": tipos_em_atraso,
                "destinatarios": len(emails),
                "emailOk": resultado_ok,
            },
        )

        return JSONResponse(
            content={
                "ok": True,
                "alerta": True,
                "motivo": motivo,
                "tiposEmAtraso": tipos_em_atraso,
                "emailEnviado": resultado_ok,
                "destinatarios": len(emails),
            }
        )


# ══════════════════════════════════════════════════════════════════════════════
# POST: GitHub Actions on failure
# ══════════════════════════════════════════════════════════════════════════════


@router.post("/api/cron/sync-monitor")
async def post_sync_monitor(request: Request) -> JSONResponse:
    """POST /api/cron/sync-monitor (réplica verbatim do Next).

    Em produção (``CRON_SECRET`` configurado) exige ``verifyBearer``; em dev/local
    (sem secret) o POST do GitHub Actions passa direto.
    """
    cron_secret = settings.cron_secret
    if cron_secret and not _verify_bearer(request, cron_secret):
        return JSONResponse(content={"error": "Não autorizado"}, status_code=401)

    # let body: PostBody; try { body = await req.json() } catch → 400
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 — espelha o catch → 400 "Body inválido"
        return JSONResponse(content={"error": "Body inválido"}, status_code=400)

    # `const { evento, modo, erro } = body;` — FORA do try/catch no Next.
    # Se o corpo for o literal JSON `null`, `req.json()` retorna null (sem lançar)
    # e o destructuring de `null` LANÇA TypeError não tratado → HTTP 500. Replicamos:
    # `body is None` → levanta (o handler global do main.py devolve 500), igual ao Next.
    # Para os demais não-objetos (array/primitivo), o destructuring NÃO lança no JS:
    # os campos viram `undefined`; tratamos como dict vazio (campos → None → "undefined").
    if body is None:
        raise TypeError(
            "Cannot destructure property 'evento' of 'body' as it is null."
        )
    if not isinstance(body, dict):
        body = {}

    evento = body.get("evento")
    modo = body.get("modo")
    erro = body.get("erro")

    async with SessionLocal() as db:
        emails = await _get_admin_emails(db)
        if len(emails) == 0:
            log.warning("nenhum admin com email encontrado")
            return JSONResponse(content={"ok": True, "emailEnviado": False})

        template = _template_sync_falhou(
            {
                "tipo": f"{_und(evento)} ({_und(modo)})",
                "executadoEm": _format_timestamp(datetime.now(tz=timezone.utc)),
                "erros": 1,
                "totalEncontradas": 0,
                "detalhes": erro,
                "githubRepo": GITHUB_REPO,
            }
        )

        resultado = await send_email(
            to=emails,
            subject=template["subject"],
            html=template["html"],
            text=template["text"],
        )
        resultado_ok = bool(resultado.get("ok"))

        log.info(
            "alerta GitHub Actions",
            extra={
                "evento": evento,
                "modo": modo,
                "emailOk": resultado_ok,
            },
        )

        return JSONResponse(
            content={
                "ok": True,
                "emailEnviado": resultado_ok,
                "destinatarios": len(emails),
            }
        )
