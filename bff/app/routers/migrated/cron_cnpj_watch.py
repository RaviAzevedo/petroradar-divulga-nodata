"""Rota MIGRADA (estrangulador / strangler-fig):
    GET /api/cron/cnpj-watch  — Vercel Cron semanal (segunda 09:00 UTC)

Espelho 1:1 de ``src/app/api/cron/cnpj-watch/route.ts``.

Responsabilidades (idênticas ao Next):
  Consulta a situação cadastral do CNPJ Proponente na Receita Federal via BrasilAPI
  (https://brasilapi.com.br/api/cnpj/v1/{cnpj}) — gratuita, sem cadastro. Detecta
  mudança de situação (ATIVA → SUSPENSA / INAPTA) e dispara alerta crítico, pois a
  Petrobras suspende automaticamente fornecedores com CNPJ irregular.

  1. Lê o CNPJ Proponente do config, remove não-dígitos; valida 14 dígitos.
  2. Faz fetch GET na BrasilAPI (header Accept: application/json), sem retry.
  3. Normaliza ``descricao_situacao_cadastral`` para ATIVA/SUSPENSA/INAPTA/BAIXADA/
     NULA/DESCONHECIDA (``normalizarSituacao``).
  4. Busca o último registro (cnpj_status_log) do mesmo CNPJ por checado_em desc.
  5. ``mudou`` = não há último OU situacao mudou.
  6. Insere SEMPRE o snapshot atual (auditoria) com alertado=false.
  7. Se ``mudou && situacao !== "ATIVA"``: busca destinatários críticos (users
     ativos com role IN ADMIN/LIDER/SGI), envia e-mail (templateCnpjSituacao) e,
     se ``ok``, marca alertado=true no snapshot recém-inserido.
  8. Retorna {"ok": true, "cnpj", "situacao", "mudou", "alertado"}.

──────────────────────────────────────────────────────────────────────────────
AUTENTICAÇÃO — réplica de ``verifyCronAuth(req)`` (src/lib/security/secrets.ts)
──────────────────────────────────────────────────────────────────────────────
O Next:

    export function verifyCronAuth(req): boolean {
      const cronSecret = process.env.CRON_SECRET;
      if (cronSecret) {
        const authHeader = req.headers.get("authorization") ?? "";
        return safeEqual(authHeader, `Bearer ${cronSecret}`);
      }
      return req.headers.get("x-vercel-cron") === "1";
    }

  - ``CRON_SECRET`` configurado  → SEMPRE exige ``Authorization: Bearer <secret>``
    (comparação constant-time: SHA-256 nos dois lados + ``timingSafeEqual``).
  - ``CRON_SECRET`` ausente (dev/local) → aceita ``x-vercel-cron: 1``.

``safeEqual(a, b)``: ``a == null || b == null`` → false; senão compara
``sha256(a)`` vs ``sha256(b)`` com ``timingSafeEqual`` (aqui ``hmac.compare_digest``).
``expected`` = ``settings.cron_secret`` (alias ``CRON_SECRET``).

Em falha de auth → 401 ``{"error": "Não autorizado"}`` (igual ao Next).

──────────────────────────────────────────────────────────────────────────────
SHAPE das respostas (paridade com ``NextResponse.json``)
──────────────────────────────────────────────────────────────────────────────
  - 401 {"error": "Não autorizado"}                             (auth falhou)
  - 500 {"error": "CNPJ Proponente inválido em config"}           (len != 14)
  - 502 {"ok": false, "error": "Falha de rede ao consultar BrasilAPI"}
  - 502 {"ok": false, "error": "BrasilAPI HTTP <status>"}
  - 200 {"ok": true, "cnpj", "situacao", "mudou", "alertado"}

Notas de paridade:
  - ``config.proponente.cnpj`` = ``NEXT_PUBLIC_PROPONENTE_CNPJ`` ?? "11222333000181"
    (lido via ``settings.proponente_cnpj``, mesmo default do app).
  - LGPD (02/07/2026): o snapshot persistido em ``cnpj_status_log.dados_brutos``
    NÃO inclui mais a chave ``qsa`` (nomes de sócios = dado pessoal). Mudança
    espelhada no Next em paralelo (mesma remoção antes do INSERT).
  - ``config.proponente.razaoSocial`` (usado só pelo template default "—" do Next
    quando ``razao_social`` ausente) NÃO é necessário aqui: o template recebe
    ``dados.razao_social ?? "—"`` direto, igual ao Next.
  - Snapshot inserido SEMPRE (auditoria), inclusive quando não mudou; ``dadosBrutos``
    grava a resposta crua da BrasilAPI; ``fonte`` = "BrasilAPI".
  - Alerta apenas quando ``mudou`` E saiu de ATIVA. ``situacaoAnterior`` =
    ``ultimo?.situacao ?? "DESCONHECIDA"``.
  - ``sendEmail`` → ``send_email`` (app.core.email): retorna {ok}; ``ok`` ⇒
    ``alertado = true`` e UPDATE do snapshot.
  - Template ``templateCnpjSituacao`` portado verbatim (layout/badge/infoRow/
    formatDate de src/lib/email/templates.ts).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.config import settings
from app.core.email import send_email
from app.db.session import SessionLocal

router = APIRouter()

log = logging.getLogger("petro.cron.cnpj_watch")


# ── Papéis críticos (espelha ROLES.ADMIN/LIDER/SGI de permissions.ts) ─────────

ROLE_ADMIN = "ADMIN"
ROLE_LIDER = "LIDER"
ROLE_SGI = "SGI"


# ── config.proponente.cnpj (réplica de src/lib/config.ts) ───────────────────────
# cnpj: process.env.NEXT_PUBLIC_PROPONENTE_CNPJ ?? "11222333000181"
# Lido via settings (campo proponente_cnpj); o ``or`` cobre env definida vazia.
def _proponente_cnpj() -> str:
    return settings.proponente_cnpj or "11222333000181"


# ── Réplica de safeEqual / verifyCronAuth (src/lib/security/secrets.ts) ───────


def _safe_equal(a: Optional[str], b: Optional[str]) -> bool:
    """Réplica de ``safeEqual``: SHA-256 nos dois lados + comparação constant-time.

    ``a == null || b == null`` → ``False``.
    """
    if a is None or b is None:
        return False
    ha = hashlib.sha256(a.encode("utf-8")).digest()
    hb = hashlib.sha256(b.encode("utf-8")).digest()
    return hmac.compare_digest(ha, hb)


def _verify_cron_auth(request: Request) -> bool:
    """Réplica de ``verifyCronAuth(req)``.

    ``CRON_SECRET`` configurado → exige ``Authorization: Bearer <secret>``
    (constant-time). Ausente → aceita header ``x-vercel-cron: 1``.
    """
    cron_secret = settings.cron_secret
    if cron_secret:
        auth_header = (
            request.headers.get("authorization")
            or request.headers.get("Authorization")
            or ""
        )
        return _safe_equal(auth_header, f"Bearer {cron_secret}")
    return request.headers.get("x-vercel-cron") == "1"


# ── Normalização da situação cadastral (réplica de normalizarSituacao) ────────


def _normalizar_situacao(s: Optional[str]) -> str:
    """Réplica de ``normalizarSituacao(s)``.

    Mapeia a descrição da BrasilAPI para o enum SituacaoCadastralCnpj.
    """
    x = (s if s is not None else "").upper()
    if "ATIVA" in x:
        return "ATIVA"
    if "SUSPENS" in x:
        return "SUSPENSA"
    if "INAPTA" in x:
        return "INAPTA"
    if "BAIXA" in x:
        return "BAIXADA"
    if "NULA" in x:
        return "NULA"
    return "DESCONHECIDA"


# ── Template de e-mail (portado de src/lib/email/templates.ts) ────────────────


def _format_date(d: datetime) -> str:
    """Réplica de ``formatDate``: pt-BR, dia 2 dígitos / mês por extenso / ano /
    hora:minuto, timezone America/Sao_Paulo.

    Ex.: "08 de junho de 2026 às 14:30".
    """
    try:
        from zoneinfo import ZoneInfo

        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        local = d.astimezone(ZoneInfo("America/Sao_Paulo"))
    except Exception:  # noqa: BLE001 — fallback sem tz (não deve ocorrer)
        local = d
    meses = [
        "janeiro", "fevereiro", "março", "abril", "maio", "junho",
        "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
    ]
    return (
        f"{local.day:02d} de {meses[local.month - 1]} de {local.year} às "
        f"{local.hour:02d}:{local.minute:02d}"
    )


def _layout(conteudo: str) -> str:
    """Réplica de ``layout(conteudo)`` — wrapper HTML do e-mail."""
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
        f'padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;">'
        f"{texto}</span>"
    )


def _info_row(label: str, value: str) -> str:
    return (
        '<tr>\n'
        f'    <td style="padding:6px 0;color:#64748b;font-size:13px;width:140px;'
        f'vertical-align:top;">{label}</td>\n'
        f'    <td style="padding:6px 0;color:#0f172a;font-size:13px;'
        f'font-weight:500;">{value}</td>\n'
        '  </tr>'
    )


def _template_cnpj_situacao(
    cnpj: str,
    razao_social: str,
    situacao_anterior: str,
    situacao_atual: str,
    motivo: Optional[str],
    ultima_atualizacao: Optional[datetime],
) -> dict:
    """Réplica de ``templateCnpjSituacao(p)``."""
    subject = f"🔴 ALERTA: CNPJ {razao_social} mudou para {situacao_atual}"

    linha_motivo = _info_row("Motivo", motivo) if motivo else ""
    linha_atualizacao = (
        _info_row("Atualização RF", _format_date(ultima_atualizacao))
        if ultima_atualizacao
        else ""
    )

    html = _layout(
        f"""
    <h2 style="margin:0 0 4px;color:#0f172a;font-size:22px;">Situação Cadastral CNPJ Alterada</h2>
    <p style="margin:0 0 24px;color:#64748b;font-size:14px;">
      {_badge("#dc2626", "URGENTE")} Mudou de <strong>{situacao_anterior}</strong> para <strong>{situacao_atual}</strong>
    </p>

    <table cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #e2e8f0;border-radius:6px;padding:16px;margin-bottom:24px;">
      {_info_row("CNPJ", cnpj)}
      {_info_row("Razão Social", razao_social)}
      {_info_row("Situação Anterior", situacao_anterior)}
      {_info_row("Situação Atual", situacao_atual)}
      {linha_motivo}
      {linha_atualizacao}
    </table>

    <p style="color:#64748b;font-size:14px;margin:0 0 8px;">
      Petrobras suspende automaticamente fornecedores com CNPJ irregular. Regularize com a Receita Federal o quanto antes.
    </p>
  """
    )

    text_ = (
        f"ALERTA: CNPJ {razao_social} mudou para {situacao_atual}\n\n"
        f"CNPJ: {cnpj}\n"
        f"Anterior: {situacao_anterior}\n"
        f"Atual: {situacao_atual}\n"
        f"Motivo: {motivo if motivo is not None else '—'}"
    )

    return {"subject": subject, "html": html, "text": text_}


# ── Destinatários críticos (réplica de getDestinatariosCriticos) ──────────────


async def _get_destinatarios_criticos(db) -> list[str]:
    """Emails de users ativos com role IN (ADMIN, LIDER, SGI), filtrando falsy.

    Réplica de ``getDestinatariosCriticos`` (rows.map(email).filter(Boolean)).
    """
    rows = (
        await db.execute(
            text(
                """
                SELECT email
                FROM users
                WHERE ativo = true
                  AND role IN (:r_admin, :r_lider, :r_sgi)
                """
            ),
            {"r_admin": ROLE_ADMIN, "r_lider": ROLE_LIDER, "r_sgi": ROLE_SGI},
        )
    ).mappings().all()
    return [r["email"] for r in rows if r["email"]]


# ── Helper: parse da data_situacao_cadastral → datetime (new Date(...)) ───────


def _parse_data_situacao(valor: Optional[str]) -> Optional[datetime]:
    """Réplica de ``new Date(dados.data_situacao_cadastral)``.

    O Next só cria o Date quando ``data_situacao_cadastral`` é truthy; caso
    contrário ``ultimaAtualizacao`` = null. Aqui, valor falsy → None. Parse
    tolerante de ISO-8601 / "YYYY-MM-DD".
    """
    if not valor:
        return None
    s = str(valor)
    try:
        # Suporta o sufixo "Z" (UTC) que o fromisoformat antigo não aceitava.
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s)
    except Exception:  # noqa: BLE001
        try:
            return datetime.strptime(s[:10], "%Y-%m-%d")
        except Exception:  # noqa: BLE001
            return None


# ── Handler ───────────────────────────────────────────────────────────────────


@router.get("/api/cron/cnpj-watch")
async def get_cron_cnpj_watch(request: Request) -> JSONResponse:
    """GET /api/cron/cnpj-watch (réplica verbatim do Next).

    Auth: Bearer ``CRON_SECRET`` (ou ``x-vercel-cron: 1`` se o segredo não estiver
    configurado). Sem auth de usuário/sessão NextAuth.
    """
    if not _verify_cron_auth(request):
        return JSONResponse(content={"error": "Não autorizado"}, status_code=401)

    # config.proponente.cnpj.replace(/\D/g, "")
    cnpj = "".join(ch for ch in _proponente_cnpj() if ch.isdigit())
    if len(cnpj) != 14:
        return JSONResponse(
            content={"error": "CNPJ Proponente inválido em config"}, status_code=500
        )

    # ── Fetch BrasilAPI (sem retry pesado — rate limit baixo) ─────────────────
    try:
        async with httpx.AsyncClient() as client:
            res = await client.get(
                f"https://brasilapi.com.br/api/cnpj/v1/{cnpj}",
                headers={"Accept": "application/json"},
            )
    except Exception as e:  # noqa: BLE001 — falha de rede
        log.error("BrasilAPI falha de rede: %s (cnpj=%s)", e, cnpj)
        return JSONResponse(
            content={"ok": False, "error": "Falha de rede ao consultar BrasilAPI"},
            status_code=502,
        )

    # res.ok no fetch = status 200..299
    if not (200 <= res.status_code < 300):
        try:
            txt = res.text
        except Exception:  # noqa: BLE001
            txt = ""
        log.error(
            "BrasilAPI retornou erro (cnpj=%s, status=%s, body=%s)",
            cnpj,
            res.status_code,
            txt[:200],
        )
        return JSONResponse(
            content={"ok": False, "error": f"BrasilAPI HTTP {res.status_code}"},
            status_code=502,
        )

    dados = res.json()
    situacao = _normalizar_situacao(dados.get("descricao_situacao_cadastral"))
    _motivo = dados.get("motivo_situacao_cadastral")
    motivo_str = str(_motivo) if _motivo is not None else None
    ultima_atualizacao = _parse_data_situacao(dados.get("data_situacao_cadastral"))

    async with SessionLocal() as db:
        # ── Último registro (por checado_em desc) ─────────────────────────────
        ultimo = (
            await db.execute(
                text(
                    """
                    SELECT id, situacao
                    FROM cnpj_status_log
                    WHERE cnpj = :cnpj
                    ORDER BY checado_em DESC
                    LIMIT 1
                    """
                ),
                {"cnpj": cnpj},
            )
        ).mappings().first()

        mudou = (ultimo is None) or (ultimo["situacao"] != situacao)
        alertado = False

        # LGPD: QSA não persistido — a resposta da BrasilAPI traz o quadro
        # societário (``qsa``: nome_socio, cnpj_cpf_do_socio, ...), dado pessoal
        # sem finalidade para o monitoramento de situação cadastral. Removemos a
        # chave ANTES de gravar o snapshot em cnpj_status_log (minimização,
        # LGPD art. 6º III). O fluxo em memória (razao_social etc.) não muda.
        dados_persistir = {k: v for k, v in dados.items() if k != "qsa"}

        # ── Insere o snapshot atual sempre (auditoria) ────────────────────────
        novo = (
            await db.execute(
                text(
                    """
                    INSERT INTO cnpj_status_log
                        (cnpj, situacao, motivo_situacao, razao_social,
                         ultima_atualizacao, fonte, dados_brutos, mudou, alertado)
                    VALUES
                        (:cnpj, :situacao, :motivo_situacao, :razao_social,
                         :ultima_atualizacao, :fonte, CAST(:dados_brutos AS jsonb),
                         :mudou, :alertado)
                    RETURNING id
                    """
                ),
                {
                    "cnpj": cnpj,
                    "situacao": situacao,
                    "motivo_situacao": motivo_str,
                    "razao_social": dados.get("razao_social"),
                    "ultima_atualizacao": ultima_atualizacao,
                    "fonte": "BrasilAPI",
                    "dados_brutos": json.dumps(dados_persistir),
                    "mudou": mudou,
                    "alertado": False,
                },
            )
        ).mappings().first()
        await db.commit()

        # ── Alerta apenas quando mudou pra estado pior (deixa de ser ATIVA) ───
        if mudou and situacao != "ATIVA":
            destinatarios = await _get_destinatarios_criticos(db)
            if len(destinatarios) > 0:
                tpl = _template_cnpj_situacao(
                    cnpj=cnpj,
                    razao_social=(
                        dados.get("razao_social")
                        if dados.get("razao_social") is not None
                        else "—"
                    ),
                    situacao_anterior=(
                        ultimo["situacao"] if ultimo is not None else "DESCONHECIDA"
                    ),
                    situacao_atual=situacao,
                    motivo=motivo_str,
                    ultima_atualizacao=ultima_atualizacao,
                )
                r = await send_email(
                    to=destinatarios,
                    subject=tpl["subject"],
                    html=tpl["html"],
                    text=tpl["text"],
                )
                if bool(r.get("ok")):
                    alertado = True
                    await db.execute(
                        text(
                            """
                            UPDATE cnpj_status_log
                            SET alertado = true
                            WHERE id = :id
                            """
                        ),
                        {"id": novo["id"]},
                    )
                    await db.commit()

        return JSONResponse(
            content={
                "ok": True,
                "cnpj": cnpj,
                "situacao": situacao,
                "mudou": mudou,
                "alertado": alertado,
            }
        )
