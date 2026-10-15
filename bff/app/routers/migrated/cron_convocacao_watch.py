"""Rota MIGRADA: GET /api/cron/convocacao-watch (estrangulador).

Espelha 1:1 a rota Next:
  src/app/api/cron/convocacao-watch/route.ts

  Radar de Convocação do Remanescente (2º colocado) pós-resultado.

  Cruza propostas onde cnpj = Proponente e posicao >= posicaoMinima (config) com
  eventos DESCLASSIFICADO/DESISTIU recém-inseridos (convocacao_notificada_em IS
  NULL): quando um concorrente à frente sai, a Proponente sobe na fila e pode ser
  a próxima elegível. Para cada gatilho:
    1. Envia e-mail "você é o próximo elegível" aos ADMIN/LIDER ativos.
       (Até 2026-09 também gravava no sininho in-app, que saiu com Participações.)
    2. Marca licitacao_eventos_vencedor.convocacao_notificada_em (dedup).

  Segurança: Bearer ${CRON_SECRET} ou x-vercel-cron: 1.

FIDELIDADE:
  - autorizarCron: se CRON_SECRET existe, exige header
    ``authorization == "Bearer <CRON_SECRET>"``; senão, exige
    ``x-vercel-cron == "1"``. 401 {"error":"Não autorizado"} igual.
  - gate de cron desabilitado -> 200 {"ok":true,"skipped":true,"motivo":"cron desabilitado"}.
  - listarGatilhosConvocacao(): MESMA query SQL (WITH kp_posicao + kp_convocada +
    SELECT final, LIMIT 100), com a interpolação literal de ``posicaoMin`` (sql.raw
    no Next) e o pós-processamento (toNum/valor_proposta/dataEvento ISO).
  - destinatários: users role IN (ADMIN, LIDER) AND ativo = true, filtrando email truthy.
  - por gatilho: monta template e envia 1 e-mail por destinatário.
  - dedup: update convocacaoNotificadaEm = agora WHERE id = eventoId.
  - stats {gatilhos, emailsEnviados, emailsFalhos} e executadoEm ISO.

NOTA sobre transações: o Next usa neon-http (sem db.transaction); cada insert/
update é independente. Aqui usamos a AsyncSession e commitamos por operação
(execute + commit) para reproduzir o mesmo efeito incremental/não-transacional.

Objetivo: JSON.parse(resp_bff) == JSON.parse(resp_next).
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.config import settings
from app.core.cron_auth import safe_equal
from app.core.email import send_email
from app.db.session import SessionLocal
from app.routers.migrated._shared import flag as _flag, num as _num

router = APIRouter()

# ── Espelha config.proponente.cnpj (src/lib/config.ts) ──────────────────────────
#   process.env.NEXT_PUBLIC_PROPONENTE_CNPJ ?? "11222333000181" (via settings;
#   o ``or`` cobre env definida vazia).
PROPONENTE_CNPJ = settings.proponente_cnpj or "11222333000181"

# ── Espelha config.crons.convocacaoWatch (src/lib/config.ts) ─────────────────
#   habilitado = flag(CRON_CONVOCACAO_WATCH_ENABLED, true)  (default ligado)
#   posicaoMinima = num(CRON_CONVOCACAO_POSICAO_MIN, 2)
#   (helpers paritários flag/num consolidados em _shared; valores crus do settings)

CONVOCACAO_HABILITADO = _flag(settings.cron_convocacao_watch_enabled, True)
CONVOCACAO_POSICAO_MIN = _num(settings.cron_convocacao_posicao_min, 2)

# ── Espelha baseUrl do template (src/lib/email/templates.ts) ─────────────────
#   export const baseUrl = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
EMAIL_BASE_URL = settings.nextauth_url or "http://localhost:3000"

# ROLES (src/lib/permissions.ts): ADMIN, LIDER.
ROLE_ADMIN = "ADMIN"
ROLE_LIDER = "LIDER"

# Fuso usado pelo formatDate do template (America/Sao_Paulo).
_TZ_SP = ZoneInfo("America/Sao_Paulo")

# Meses por extenso (pt-BR, "long") — espelha toLocaleDateString pt-BR.
_MESES_PT = [
    "janeiro", "fevereiro", "março", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
]


def _to_num(v) -> float:
    """Espelha toNum() de convocacao-watch.ts: null/NaN -> 0, senão número."""
    if v is None:
        return 0
    try:
        n = float(v)
    except (TypeError, ValueError):
        return 0
    if math.isnan(n):
        return 0
    return n


def _js_num(x):
    """Colapsa float inteiro-valorado para int (paridade de wire com JSON.stringify)."""
    if isinstance(x, float) and x.is_integer():
        return int(x)
    return x


def _iso_z(dt: datetime) -> str:
    """Replica new Date(dt).toISOString() do JS (UTC, sufixo 'Z', ms)."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    ms = dt.microsecond // 1000
    return f"{dt.strftime('%Y-%m-%dT%H:%M:%S')}.{ms:03d}Z"


def _format_date(dt: datetime) -> str:
    """Espelha formatDate() do template (pt-BR, America/Sao_Paulo).

    new Date(...).toLocaleDateString("pt-BR", {day:2-digit, month:long,
    year:numeric, hour:2-digit, minute:2-digit, timeZone:America/Sao_Paulo})
    produz algo como: "08 de junho de 2026 14:35".
    """
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    local = dt.astimezone(_TZ_SP)
    mes = _MESES_PT[local.month - 1]
    return (
        f"{local.day:02d} de {mes} de {local.year} "
        f"{local.hour:02d}:{local.minute:02d}"
    )


def _format_currency(value) -> str:
    """Espelha formatCurrency() do template (pt-BR, BRL).

    null/undefined/"" -> "—"; não-finito -> "—"; senão "R$ 1.234,56".
    """
    if value is None or value == "":
        return "—"
    try:
        num = float(value)
    except (TypeError, ValueError):
        return "—"
    if not math.isfinite(num):
        return "—"
    # Formatação pt-BR: milhar com '.', decimal com ','.
    inteiro = f"{num:,.2f}"  # ex.: "1,234.56"
    inteiro = inteiro.replace(",", "X").replace(".", ",").replace("X", ".")
    return f"R$\xa0{inteiro}"


def _link_licitacao(id_: str) -> str:
    """Espelha linkLicitacao(id): `${baseUrl}/licitacoes/${id}`."""
    return f"{EMAIL_BASE_URL}/licitacoes/{id_}"


def _layout(conteudo: str) -> str:
    """Espelha layout() do template (HTML base)."""
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
        f'<tr>\n'
        f'    <td style="padding:6px 0;color:#64748b;font-size:13px;width:140px;'
        f'vertical-align:top;">{label}</td>\n'
        f'    <td style="padding:6px 0;color:#0f172a;font-size:13px;'
        f'font-weight:500;">{value}</td>\n'
        f'  </tr>'
    )


def _template_convocacao_remanescente(p: dict) -> dict:
    """Espelha templateConvocacaoRemanescente() do Next.

    p = {
      licitacaoId, numero, objeto, posicaoProponente, empresaAnterior,
      tipoEvento, motivo, dataEvento (datetime), valorPropostaProponente (str|None)
    }
    Retorna {subject, html, text}.
    """
    numero = p["numero"]
    objeto = p["objeto"]
    posicao = p["posicaoProponente"]
    empresa_anterior = p["empresaAnterior"]
    tipo_evento = p["tipoEvento"]
    motivo = p["motivo"]
    data_evento = p["dataEvento"]
    valor = p.get("valorPropostaProponente")
    licitacao_id = p["licitacaoId"]

    subject = f"Oportunidade: Proponente é a próxima elegível na licitação {numero}"

    if tipo_evento == "DESISTIU":
        motivo_label = f"{empresa_anterior} desistiu"
    else:
        sufixo = f" ({motivo})" if motivo else ""
        motivo_label = f"{empresa_anterior} foi desclassificada{sufixo}"

    objeto_row = ""
    if objeto:
        objeto_fmt = objeto if len(objeto) <= 120 else objeto[:120] + "…"
        objeto_row = _info_row("Objeto", objeto_fmt)

    valor_row = ""
    if valor:
        valor_row = _info_row("Nossa Proposta", _format_currency(valor))

    conteudo = f"""
    <h2 style="margin:0 0 4px;color:#0f172a;font-size:22px;">Você é o Próximo Elegível</h2>
    <p style="margin:0 0 24px;color:#64748b;font-size:14px;">
      {_badge("#16a34a", "REMANESCENTE")} Proponente subiu para a <strong>{posicao}ª posição</strong>
    </p>

    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:16px;margin-bottom:24px;">
      <p style="margin:0;color:#166534;font-size:14px;">
        {motivo_label}. A Proponente pode ser convocada para apresentar documentação como remanescente.
      </p>
    </div>

    <table cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #e2e8f0;border-radius:6px;padding:16px;margin-bottom:24px;">
      {_info_row("Licitação", numero)}
      {objeto_row}
      {_info_row("Posição Proponente", f"{posicao}ª")}
      {_info_row("Evento", f"{tipo_evento} — {_format_date(data_evento)}")}
      {valor_row}
    </table>

    <p style="color:#64748b;font-size:14px;margin:0 0 8px;">
      Prepare a documentação de habilitação — a convocação como remanescente costuma ter prazo curto e fatal.
    </p>

    {_button(_link_licitacao(licitacao_id), "Ver Licitação →")}
  """
    html = _layout(conteudo)

    text_lines = [
        f"Proponente é a próxima elegível na licitação {numero}",
        f"Posição: {posicao}ª",
        motivo_label,
        f"Evento: {tipo_evento} em {_format_date(data_evento)}",
        f"\nAcesse: {_link_licitacao(licitacao_id)}",
    ]
    text = "\n".join([line for line in text_lines if line])

    return {"subject": subject, "html": html, "text": text}


def _autorizar_cron(req: Request) -> bool:
    """Espelha autorizarCron(req) do Next.

    Se CRON_SECRET existe -> exige authorization == "Bearer <CRON_SECRET>".
    Senão -> exige header x-vercel-cron == "1". Comparação constant-time
    (safe_equal) — mesmo resultado booleano, sem canal de timing.
    """
    cron_secret = settings.cron_secret
    if cron_secret:
        auth_header = req.headers.get("authorization") or ""
        return safe_equal(auth_header, f"Bearer {cron_secret}")
    return req.headers.get("x-vercel-cron") == "1"


async def _listar_gatilhos_convocacao() -> list[dict]:
    """Espelha listarGatilhosConvocacao() (src/lib/eventos-vencedor/convocacao-watch.ts).

    MESMA query (WITH kp_posicao + kp_convocada + SELECT final, LIMIT 100), com
    interpolação literal de posicaoMin (sql.raw no Next) e o mapeamento camelCase.
    """
    posicao_min = CONVOCACAO_POSICAO_MIN

    sql = text(
        f"""
        WITH kp_posicao AS (
          SELECT
            pl.numero_licitacao,
            MIN(pl.posicao)               AS posicao,
            MAX(pl.valor_total::numeric)  AS valor_proposta
          FROM propostas_licitacao pl
          WHERE pl.cnpj = :proponente
            AND pl.declinou = false
            AND pl.posicao IS NOT NULL
            AND pl.posicao >= {posicao_min}
          GROUP BY pl.numero_licitacao
        ),
        kp_convocada AS (
          -- Licitações onde a Proponente já foi convocada/homologada (não alertar de novo)
          SELECT DISTINCT numero_licitacao
          FROM licitacao_eventos_vencedor
          WHERE cnpj = :proponente
            AND tipo IN ('CONVOCADO', 'HOMOLOGADO')
        )
        SELECT
          ev.id                AS evento_id,
          ev.numero_licitacao  AS numero_licitacao,
          ev.cnpj              AS cnpj_que_saiu,
          ev.fornecedor        AS fornecedor_que_saiu,
          ev.tipo              AS tipo_evento,
          ev.motivo            AS motivo,
          ev.data_evento       AS data_evento,
          kp.posicao           AS posicao,
          kp.valor_proposta    AS valor_proposta,
          r.licitacao_id       AS licitacao_id,
          r.objeto             AS objeto,
          r.segmento           AS segmento,
          r.empresa            AS empresa
        FROM licitacao_eventos_vencedor ev
        INNER JOIN kp_posicao kp ON kp.numero_licitacao = ev.numero_licitacao
        LEFT JOIN resultados_licitacao r ON r.numero_licitacao = ev.numero_licitacao
        WHERE ev.tipo IN ('DESCLASSIFICADO', 'DESISTIU')
          AND ev.convocacao_notificada_em IS NULL
          AND ev.cnpj <> :proponente
          AND ev.numero_licitacao NOT IN (SELECT numero_licitacao FROM kp_convocada)
        ORDER BY ev.data_evento DESC
        LIMIT 100
        """
    )

    async with SessionLocal() as db:
        rows = (
            await db.execute(sql, {"proponente": PROPONENTE_CNPJ})
        ).mappings().all()

    gatilhos: list[dict] = []
    for row in rows:
        valor_proposta = row["valor_proposta"]
        licitacao_id = row["licitacao_id"]
        data_evento = row["data_evento"]
        gatilhos.append(
            {
                "eventoId": str(row["evento_id"]),
                "numeroLicitacao": row["numero_licitacao"],
                # uuid (Drizzle/pg devolve STRING); asyncpg pode devolver UUID/str.
                "licitacaoId": (
                    str(licitacao_id) if licitacao_id is not None else None
                ),
                "objeto": row["objeto"],
                "segmento": row["segmento"],
                "empresa": row["empresa"],
                "posicaoProponente": _to_num(row["posicao"]),
                "valorPropostaProponente": (
                    _to_num(valor_proposta) if valor_proposta is not None else None
                ),
                "cnpjQueSaiu": row["cnpj_que_saiu"],
                "fornecedorQueSaiu": row["fornecedor_que_saiu"],
                "tipoEvento": row["tipo_evento"],
                "motivo": row["motivo"],
                # row.data_evento ? new Date(...).toISOString() : ""
                "dataEvento": _iso_z(data_evento) if data_evento else "",
                # datetime cru p/ reconstruir new Date(g.dataEvento) no handler.
                "_dataEventoRaw": data_evento,
            }
        )
    return gatilhos


@router.get("/api/cron/convocacao-watch")
async def get_convocacao_watch(request: Request) -> JSONResponse:
    # autorizarCron
    if not _autorizar_cron(request):
        return JSONResponse(content={"error": "Não autorizado"}, status_code=401)

    # config.crons.convocacaoWatch.habilitado
    if not CONVOCACAO_HABILITADO:
        return JSONResponse(
            content={"ok": True, "skipped": True, "motivo": "cron desabilitado"}
        )

    agora = datetime.now(timezone.utc)
    stats = {"gatilhos": 0, "emailsEnviados": 0, "emailsFalhos": 0}

    gatilhos = await _listar_gatilhos_convocacao()

    if len(gatilhos) == 0:
        # log.info("nenhum gatilho de convocação")
        return JSONResponse(
            content={"ok": True, "stats": stats, "executadoEm": _iso_z(agora)}
        )

    # Destinatários: gestão ativa (ADMIN/LIDER) — alerta de oportunidade estratégica.
    async with SessionLocal() as db:
        dest_rows = (
            await db.execute(
                text(
                    """
                    SELECT u.id AS id, u.email AS email
                    FROM users u
                    WHERE u.role IN (:admin, :lider)
                      AND u.ativo = true
                    """
                ),
                {"admin": ROLE_ADMIN, "lider": ROLE_LIDER},
            )
        ).mappings().all()

    destinatarios = [{"id": str(r["id"]), "email": r["email"]} for r in dest_rows]
    # destValidos = destinatarios.filter(u => Boolean(u.email))
    dest_validos = [u for u in destinatarios if u["email"]]

    for g in gatilhos:
        stats["gatilhos"] += 1

        if len(dest_validos) > 0:
            template = _template_convocacao_remanescente(
                {
                    "licitacaoId": g["licitacaoId"] or "",
                    "numero": g["numeroLicitacao"],
                    "objeto": g["objeto"],
                    "posicaoProponente": g["posicaoProponente"],
                    "empresaAnterior": g["fornecedorQueSaiu"],
                    "tipoEvento": g["tipoEvento"],
                    "motivo": g["motivo"],
                    # g.dataEvento ? new Date(g.dataEvento) : agora
                    "dataEvento": (
                        g["_dataEventoRaw"] if g["dataEvento"] else agora
                    ),
                    "valorPropostaProponente": (
                        str(g["valorPropostaProponente"])
                        if g["valorPropostaProponente"] is not None
                        else None
                    ),
                }
            )

            for u in dest_validos:
                resultado = await send_email(
                    to=u["email"],
                    subject=template["subject"],
                    html=template["html"],
                    text=template["text"],
                )

                if resultado.get("ok"):
                    stats["emailsEnviados"] += 1
                else:
                    stats["emailsFalhos"] += 1

        # Dedup: marca o evento como notificado (não re-dispara).
        async with SessionLocal() as db:
            await db.execute(
                text(
                    """
                    UPDATE licitacao_eventos_vencedor
                    SET convocacao_notificada_em = :agora
                    WHERE id = :evento_id
                    """
                ),
                {"agora": agora, "evento_id": g["eventoId"]},
            )
            await db.commit()

    # log.info("execução concluída", { stats })

    return JSONResponse(
        content={"ok": True, "stats": stats, "executadoEm": _iso_z(agora)}
    )
