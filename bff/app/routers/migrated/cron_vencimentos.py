"""Rota MIGRADA (estrangulador / strangler-fig):
    GET /api/cron/vencimentos  — Vercel/agendador diário

Espelho 1:1 de ``src/app/api/cron/vencimentos/route.ts``.

Responsabilidades (idênticas ao Next):
  1. Para cada documento_habilitacao com validade_fim, gera alertas idempotentes
     em D-60 / D-30 / D-15 / D-7 / D-1 / VENCIDO.
  2. Para cada família CRC com validade próxima, alerta os destinatários.
  3. Para cada envelope EM_MONTAGEM com pendências e prazo próximo, alerta.
  4. Marca status do documento como EM_RENOVACAO (D-30) ou VENCIDO automaticamente.
  5. Despacha e-mails via SMTP (app.core.email.send_email) e marca alerta.enviadoEm.

Idempotência:
  - Usa unique constraint (documentoId, tipoAlerta) em alertas_vencimento.
  - Para envelopes: sem persistência (1 e-mail por execução, se houver pendência).

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
SHAPE da resposta (paridade com ``NextResponse.json``)
──────────────────────────────────────────────────────────────────────────────
  - 200 {"ok": true, "stats": {docsAtualizados, alertasDocumentos, alertasFamilias,
                               alertasEnvelopes, emailsEnviados, emailsFalhos}}
  - 401 {"error": "Não autorizado"}
  - 500 {"error": "Erro interno"}    (réplica de handleApiError p/ erro inesperado)

Notas de paridade:
  - ``destinatarios``: users ativos com role IN (ADMIN, LIDER, SGI), email truthy.
  - ``diasEntre(de, ate)`` = floor((ate - de) / 86_400_000ms).
  - Templates de e-mail (templateVencimentoDocumento / Familia / EnvelopeIncompleto)
    portados verbatim — incluindo ``baseUrl = NEXTAUTH_URL ?? "http://localhost:3000"``
    e os deep-links de Cofre/Família/Envelope.
  - ``sendEmail`` → ``send_email`` (app.core.email): retorna {ok}; ``ok`` define
    ``enviadoEm`` (now se ok, None caso contrário) e os contadores enviados/falhos.
  - Cada item (doc/família/envelope) em try/except próprio: 1 falha não derruba o
    job; loga e segue (espelha os ``try { ... } catch (e) { log.error(...) }``).
  - O DB é uma única sessão asyncpg; cada bloco de escrita faz commit (no Next o
    Drizzle auto-commita por statement).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import math
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.config import settings
from app.core.email import send_email
from app.db.session import SessionLocal

router = APIRouter()

log = logging.getLogger("petro.cron.vencimentos")


# ── Papéis de Conformidade (espelha ROLES.ADMIN/LIDER/SGI de permissions.ts) ──

ROLE_ADMIN = "ADMIN"
ROLE_LIDER = "LIDER"
ROLE_SGI = "SGI"


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


# ── Janelas de alerta (dias até vencer) — espelha JANELAS / LIMIARES_FAMILIA ──

# (mantido como referência de paridade; a determinação do tipo segue o if-else)
JANELAS: list[dict] = [
    {"tipo": "D_60", "dias": 60},
    {"tipo": "D_30", "dias": 30},
    {"tipo": "D_15", "dias": 15},
    {"tipo": "D_7", "dias": 7},
    {"tipo": "D_1", "dias": 1},
]

LIMIARES_FAMILIA = [1, 7, 15, 30, 60]


def _dias_entre(de: datetime, ate: datetime) -> int:
    """Réplica de ``diasEntre(de, ate)`` = floor((ate - de) / 86_400_000ms).

    Usa milissegundos (``Date.getTime()`` no Next = epoch ms) para casar com a
    aritmética do app. ``timestamp()`` requer datetimes tz-aware; ``validade_fim``
    é ``timestamptz`` (asyncpg → datetime aware) e ``agora`` também é aware.
    """
    ms = ate.timestamp() * 1000.0 - de.timestamp() * 1000.0
    return math.floor(ms / (1000 * 60 * 60 * 24))


# ── Templates de e-mail (portados de src/lib/email/templates.ts) ──────────────

# baseUrl = process.env.NEXTAUTH_URL ?? "http://localhost:3000" (via settings).
_BASE_URL = settings.nextauth_url or "http://localhost:3000"


def _format_date(d: datetime) -> str:
    """Réplica de ``formatDate``: pt-BR, dia 2 dígitos / mês por extenso / ano /
    hora:minuto, timezone America/Sao_Paulo.

    O Node ``toLocaleDateString('pt-BR', {day,month:'long',year,hour,minute})``
    insere o separador literal " às " entre a data e a hora — replicado aqui.

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


def _button(href: str, texto: str) -> str:
    return (
        f'<a href="{href}" style="display:inline-block;background:#0f172a;'
        f"color:#f8fafc;padding:12px 24px;border-radius:6px;text-decoration:none;"
        f'font-weight:600;font-size:14px;margin-top:20px;">{texto}</a>'
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


def _link_cofre_documento(id_: str) -> str:
    return f"{_BASE_URL}/acervo/cofre/{id_}"


def _link_familia(id_: str) -> str:
    return f"{_BASE_URL}/acervo/familias/{id_}"


def _link_envelope(_id: str) -> str:
    # Fallback seguro (páginas de envelope foram removidas da UI do Acervo).
    return f"{_BASE_URL}/acervo/cofre"


def _template_vencimento_documento(
    documento_id: str,
    titulo: str,
    categoria: str,
    subcategoria: str,
    validade_fim: datetime,
    dias_restantes: int,
    tipo_alerta: str,
) -> dict:
    """Réplica de ``templateVencimentoDocumento``."""
    vencido = dias_restantes < 0
    urgente = dias_restantes <= 7
    cor = (
        "#dc2626"
        if vencido
        else "#dc2626"
        if urgente
        else "#d97706"
        if dias_restantes <= 30
        else "#2563eb"
    )
    urgencia = (
        "VENCIDO"
        if vencido
        else "URGENTE"
        if urgente
        else "ATENÇÃO"
        if dias_restantes <= 30
        else "AVISO"
    )

    if vencido:
        prazo_label = f"há {abs(dias_restantes)} dia(s)"
    elif dias_restantes == 0:
        prazo_label = "hoje"
    elif dias_restantes == 1:
        prazo_label = "amanhã"
    else:
        prazo_label = f"em {dias_restantes} dias"

    subject = (
        f"🔴 VENCIDO: {titulo}"
        if vencido
        else f"{urgencia}: {titulo} vence {prazo_label}"
    )

    html = _layout(
        f"""
    <h2 style="margin:0 0 4px;color:#0f172a;font-size:22px;">{"Documento Vencido" if vencido else "Documento Vencendo"}</h2>
    <p style="margin:0 0 24px;color:#64748b;font-size:14px;">
      {_badge(cor, urgencia)} {"Vencido" if vencido else "Vence"} <strong>{prazo_label}</strong>
    </p>

    <table cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #e2e8f0;border-radius:6px;padding:16px;margin-bottom:24px;">
      {_info_row("Documento", titulo)}
      {_info_row("Categoria", categoria)}
      {_info_row("Subcategoria", subcategoria)}
      {_info_row("Validade", _format_date(validade_fim))}
    </table>

    <p style="color:#64748b;font-size:14px;margin:0 0 8px;">
      Inicie a renovação {"imediatamente" if vencido else "antes do vencimento"} para evitar pendências em licitações ativas e contratos em execução.
    </p>

    {_button(_link_cofre_documento(documento_id), "Acessar Documento →")}
  """
    )

    text_ = (
        f"{urgencia}: {titulo} {'venceu' if vencido else 'vence'} {prazo_label}\n\n"
        f"Categoria: {categoria} / {subcategoria}\n"
        f"Validade: {_format_date(validade_fim)}\n\n"
        f"Acesse: {_link_cofre_documento(documento_id)}"
    )

    return {"subject": subject, "html": html, "text": text_}


def _template_vencimento_familia(
    familia_id: str,
    codigo_crc: str,
    nome: str,
    validade_fim: datetime,
    dias_restantes: int,
    segmento_petrobras: Optional[str],
) -> dict:
    """Réplica de ``templateVencimentoFamilia``."""
    cor = (
        "#dc2626"
        if dias_restantes <= 30
        else "#d97706"
        if dias_restantes <= 60
        else "#2563eb"
    )
    urgencia = "URGENTE" if dias_restantes <= 30 else "RENOVAR"
    subject = (
        f"{urgencia}: Família CRC {codigo_crc} — janela de renovação aberta "
        f"({dias_restantes}d)"
    )

    bloco_segmento = (
        _info_row("Segmento", segmento_petrobras) if segmento_petrobras else ""
    )

    html = _layout(
        f"""
    <h2 style="margin:0 0 4px;color:#0f172a;font-size:22px;">Família CRC em Janela de Renovação</h2>
    <p style="margin:0 0 24px;color:#64748b;font-size:14px;">
      {_badge(cor, urgencia)} CRC vence em <strong>{dias_restantes} dias</strong>
    </p>

    <table cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #e2e8f0;border-radius:6px;padding:16px;margin-bottom:24px;">
      {_info_row("Código CRC", codigo_crc)}
      {_info_row("Nome", nome)}
      {bloco_segmento}
      {_info_row("Validade", _format_date(validade_fim))}
    </table>

    <p style="color:#64748b;font-size:14px;margin:0 0 8px;">
      Petrobras recomenda iniciar a renovação 60 dias antes do vencimento dos critérios Jurídico e Econômico.
    </p>

    {_button(_link_familia(familia_id), "Acessar Família →")}
  """
    )

    text_ = (
        f"{urgencia}: Família CRC {codigo_crc} vence em {dias_restantes} dias\n\n"
        f"Nome: {nome}\n"
        f"Validade: {_format_date(validade_fim)}\n\n"
        f"Acesse: {_link_familia(familia_id)}"
    )

    return {"subject": subject, "html": html, "text": text_}


def _template_envelope_incompleto(
    envelope_id: str,
    numero_edital: str,
    prazo_protocolo: Optional[datetime],
    total_itens: int,
    itens_faltantes: int,
    itens_vencidos: int,
) -> dict:
    """Réplica de ``templateEnvelopeIncompleto``."""
    cor = "#dc2626" if itens_vencidos > 0 else "#d97706"
    subject = (
        f"Envelope {numero_edital}: {itens_faltantes + itens_vencidos} pendência(s)"
    )

    prazo_label = _format_date(prazo_protocolo) if prazo_protocolo else "—"

    html = _layout(
        f"""
    <h2 style="margin:0 0 4px;color:#0f172a;font-size:22px;">Envelope de Habilitação Pendente</h2>
    <p style="margin:0 0 24px;color:#64748b;font-size:14px;">
      {_badge(cor, "PENDÊNCIA")} {itens_faltantes + itens_vencidos} de {total_itens} itens precisam de ação
    </p>

    <table cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #e2e8f0;border-radius:6px;padding:16px;margin-bottom:24px;">
      {_info_row("Edital", numero_edital)}
      {_info_row("Prazo de Protocolo", prazo_label)}
      {_info_row("Itens Faltando", str(itens_faltantes))}
      {_info_row("Itens Vencidos", str(itens_vencidos))}
    </table>

    <p style="color:#64748b;font-size:14px;margin:0 0 8px;">
      Acesse o envelope para atribuir documentos faltantes ou substituir os vencidos.
    </p>

    {_button(_link_envelope(envelope_id), "Acessar Envelope →")}
  """
    )

    text_ = (
        f"Envelope {numero_edital}: {itens_faltantes} faltando, {itens_vencidos} vencidos\n\n"
        f"Prazo: {prazo_label}\n\n"
        f"Acesse: {_link_envelope(envelope_id)}"
    )

    return {"subject": subject, "html": html, "text": text_}


# ── Destinatários de Conformidade (réplica de getDestinatariosConformidade) ───


async def _get_destinatarios_conformidade(db) -> list[str]:
    """Emails de users ativos com role IN (ADMIN, LIDER, SGI), filtrando falsy.

    Réplica de ``getDestinatariosConformidade`` (rows.map(email).filter(Boolean)).
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


# ── Handler ───────────────────────────────────────────────────────────────────


@router.get("/api/cron/vencimentos")
async def get_cron_vencimentos(request: Request) -> JSONResponse:
    """GET /api/cron/vencimentos (réplica verbatim do Next).

    Auth: Bearer ``CRON_SECRET`` (ou ``x-vercel-cron: 1`` se o segredo não estiver
    configurado). Sem auth de usuário/sessão NextAuth.
    """
    if not _verify_cron_auth(request):
        return JSONResponse(content={"error": "Não autorizado"}, status_code=401)

    agora = datetime.now(tz=timezone.utc)
    stats = {
        "docsAtualizados": 0,
        "alertasDocumentos": 0,
        "alertasFamilias": 0,
        "alertasEnvelopes": 0,
        "emailsEnviados": 0,
        "emailsFalhos": 0,
    }

    # Try/except de topo: falha inesperada loga stats parciais e retorna 500
    # (handleApiError) em vez de mascarar como sucesso ou estourar sem log.
    try:
        async with SessionLocal() as db:
            destinatarios = await _get_destinatarios_conformidade(db)
            if len(destinatarios) == 0:
                log.warning("Nenhum destinatário (ADMIN/LIDER/SGI) ativo")

            # ── 1. Atualizar status de documentos automaticamente ─────────────
            # VIGENTE → EM_RENOVACAO (D-30) → VENCIDO (passou da validade)

            upd_renovacao = await db.execute(
                text(
                    """
                    UPDATE documentos_habilitacao
                    SET status = 'EM_RENOVACAO', atualizado_em = NOW()
                    WHERE status = 'VIGENTE'
                      AND validade_indeterminada = false
                      AND validade_fim IS NOT NULL
                      AND validade_fim <= NOW() + INTERVAL '30 days'
                      AND validade_fim > NOW()
                    """
                )
            )
            stats["docsAtualizados"] += int(upd_renovacao.rowcount or 0)

            upd_vencido = await db.execute(
                text(
                    """
                    UPDATE documentos_habilitacao
                    SET status = 'VENCIDO', atualizado_em = NOW()
                    WHERE status IN ('VIGENTE', 'EM_RENOVACAO')
                      AND validade_indeterminada = false
                      AND validade_fim IS NOT NULL
                      AND validade_fim <= NOW()
                    """
                )
            )
            stats["docsAtualizados"] += int(upd_vencido.rowcount or 0)
            await db.commit()

            # ── 2. Documentos vencendo: alertas D-60..D-1 + VENCIDO ───────────

            docs_relevantes = (
                await db.execute(
                    text(
                        """
                        SELECT id, titulo, categoria, subcategoria, validade_fim
                        FROM documentos_habilitacao
                        WHERE validade_indeterminada = false
                          AND validade_fim IS NOT NULL
                          AND validade_fim <= NOW() + INTERVAL '60 days'
                          AND restrito = false
                        """
                        # 0034/S17 (02-APIS §16-B.4): cron sem sessão → literal.
                        # Título de contrato sob cláusula NÃO entra em e-mail
                        # broadcast (o transporte Graph envia e-mail REAL).
                    )
                )
            ).mappings().all()

            for doc in docs_relevantes:
                # Cada documento em try/except próprio: 1 falha não derruba o job.
                try:
                    if not doc["validade_fim"]:
                        continue
                    validade = doc["validade_fim"]
                    dias = _dias_entre(agora, validade)

                    # Determina o tipo de alerta correspondente à situação atual
                    tipo: Optional[str] = None
                    if dias < 0:
                        tipo = "VENCIDO"
                    elif dias == 0 or dias == 1:
                        tipo = "D_1"
                    elif dias <= 7:
                        tipo = "D_7"
                    elif dias <= 15:
                        tipo = "D_15"
                    elif dias <= 30:
                        tipo = "D_30"
                    elif dias <= 60:
                        tipo = "D_60"

                    if not tipo:
                        continue

                    # Idempotência: skip se já existe alerta desse tipo pra esse doc
                    existente = (
                        await db.execute(
                            text(
                                """
                                SELECT id, enviado_em
                                FROM alertas_vencimento
                                WHERE documento_id = :doc_id
                                  AND tipo_alerta = :tipo
                                LIMIT 1
                                """
                            ),
                            {"doc_id": doc["id"], "tipo": tipo},
                        )
                    ).mappings().first()

                    if existente and existente["enviado_em"]:
                        continue  # já alertado

                    tpl = _template_vencimento_documento(
                        documento_id=str(doc["id"]),
                        titulo=doc["titulo"],
                        categoria=doc["categoria"],
                        subcategoria=doc["subcategoria"],
                        validade_fim=validade,
                        dias_restantes=dias,
                        tipo_alerta=tipo,
                    )

                    email_ok = False
                    if len(destinatarios) > 0:
                        r = await send_email(
                            to=destinatarios,
                            subject=tpl["subject"],
                            html=tpl["html"],
                            text=tpl["text"],
                        )
                        email_ok = bool(r.get("ok"))
                        if email_ok:
                            stats["emailsEnviados"] += 1
                        else:
                            stats["emailsFalhos"] += 1

                    enviado_em = datetime.now(tz=timezone.utc) if email_ok else None

                    if existente:
                        await db.execute(
                            text(
                                """
                                UPDATE alertas_vencimento
                                SET enviado_em = :enviado_em,
                                    destinatarios = CAST(:destinatarios AS jsonb)
                                WHERE id = :id
                                """
                            ),
                            {
                                "enviado_em": enviado_em,
                                "destinatarios": json.dumps(destinatarios),
                                "id": existente["id"],
                            },
                        )
                    else:
                        await db.execute(
                            text(
                                """
                                INSERT INTO alertas_vencimento
                                    (documento_id, tipo_alerta, agendado_para,
                                     enviado_em, destinatarios)
                                VALUES
                                    (:documento_id, :tipo_alerta, :agendado_para,
                                     :enviado_em, CAST(:destinatarios AS jsonb))
                                """
                            ),
                            {
                                "documento_id": doc["id"],
                                "tipo_alerta": tipo,
                                "agendado_para": agora,
                                "enviado_em": enviado_em,
                                "destinatarios": json.dumps(destinatarios),
                            },
                        )
                    await db.commit()

                    stats["alertasDocumentos"] += 1
                except Exception as e:  # noqa: BLE001
                    await db.rollback()
                    log.error(
                        "falha ao processar alerta de documento: %s (documentoId=%s)",
                        e,
                        doc.get("id"),
                    )

            # ── 3. Famílias CRC entrando na janela de renovação ───────────────

            fams_relevantes = (
                await db.execute(
                    text(
                        """
                        SELECT id, codigo_crc, nome, validade_fim, segmento_petrobras
                        FROM familias
                        WHERE deletado_em IS NULL
                          AND validade_fim IS NOT NULL
                          AND validade_fim <= NOW() + INTERVAL '60 days'
                          AND validade_fim >= NOW()
                        """
                    )
                )
            ).mappings().all()

            for fam in fams_relevantes:
                # Cada família em try/except próprio: 1 falha não derruba o job.
                try:
                    if not fam["validade_fim"]:
                        continue
                    validade = fam["validade_fim"]
                    dias = _dias_entre(agora, validade)

                    # Famílias NÃO têm idempotência persistida. Comparação de
                    # igualdade exata (dias === 60/30/15/7/1): no máximo 5 e-mails
                    # por família. (Usar <= dispararia e-mail todo dia — spam.)
                    if dias < 0 or dias > 60:
                        continue
                    limiar = next((l for l in LIMIARES_FAMILIA if dias == l), None)
                    if limiar is None:
                        continue

                    tpl = _template_vencimento_familia(
                        familia_id=str(fam["id"]),
                        codigo_crc=fam["codigo_crc"],
                        nome=fam["nome"],
                        validade_fim=validade,
                        dias_restantes=dias,
                        segmento_petrobras=fam["segmento_petrobras"],
                    )

                    if len(destinatarios) > 0:
                        r = await send_email(
                            to=destinatarios,
                            subject=tpl["subject"],
                            html=tpl["html"],
                            text=tpl["text"],
                        )
                        if bool(r.get("ok")):
                            stats["emailsEnviados"] += 1
                        else:
                            stats["emailsFalhos"] += 1
                    stats["alertasFamilias"] += 1
                except Exception as e:  # noqa: BLE001
                    log.error(
                        "falha ao processar alerta de família: %s (familiaId=%s)",
                        e,
                        fam.get("id"),
                    )

            # ── 4. Envelopes EM_MONTAGEM com pendências ───────────────────────

            envelopes_ativos = (
                await db.execute(
                    text(
                        """
                        SELECT id, numero_edital, prazo_protocolo
                        FROM envelopes_habilitacao
                        WHERE status = 'EM_MONTAGEM'
                          AND prazo_protocolo IS NOT NULL
                          AND prazo_protocolo <= NOW() + INTERVAL '14 days'
                        """
                    )
                )
            ).mappings().all()

            for env in envelopes_ativos:
                # Cada envelope em try/except próprio: 1 falha não derruba o job.
                try:
                    itens = (
                        await db.execute(
                            text(
                                """
                                SELECT status
                                FROM envelope_itens
                                WHERE envelope_id = :env_id
                                """
                            ),
                            {"env_id": env["id"]},
                        )
                    ).mappings().all()

                    total = len(itens)
                    faltantes = sum(1 for i in itens if i["status"] == "PENDENTE")
                    vencidos = sum(
                        1
                        for i in itens
                        if i["status"] == "VENCIDO"
                        or i["status"] == "VENCE_ANTES_DO_PROTOCOLO"
                    )

                    if faltantes + vencidos == 0:
                        continue

                    tpl = _template_envelope_incompleto(
                        envelope_id=str(env["id"]),
                        numero_edital=env["numero_edital"][:40],
                        prazo_protocolo=env["prazo_protocolo"],
                        total_itens=total,
                        itens_faltantes=faltantes,
                        itens_vencidos=vencidos,
                    )

                    if len(destinatarios) > 0:
                        r = await send_email(
                            to=destinatarios,
                            subject=tpl["subject"],
                            html=tpl["html"],
                            text=tpl["text"],
                        )
                        if bool(r.get("ok")):
                            stats["emailsEnviados"] += 1
                        else:
                            stats["emailsFalhos"] += 1
                    stats["alertasEnvelopes"] += 1
                except Exception as e:  # noqa: BLE001
                    log.error(
                        "falha ao processar alerta de envelope: %s (envelopeId=%s)",
                        e,
                        env.get("id"),
                    )

            log.info("execução concluída: %s", stats)

            return JSONResponse(content={"ok": True, "stats": stats})
    except Exception as e:  # noqa: BLE001 — réplica de handleApiError → 500
        log.error("falha geral no cron de vencimentos: %s (stats=%s)", e, stats)
        return JSONResponse(content={"error": "Erro interno"}, status_code=500)
