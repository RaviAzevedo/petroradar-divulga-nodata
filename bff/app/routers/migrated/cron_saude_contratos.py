"""Rota MIGRADA (estrangulador): GET /api/cron/saude-contratos.

Espelha 1:1 a rota Next:
  src/app/api/cron/saude-contratos/route.ts  (Vercel Cron diário 13:30 UTC)

Para cada contrato ATIVO, recalcula ``statusSaude``:
  OK       — todos docs obrigatórios cobertos e válidos durante todo o contrato
  ATENCAO  — algum doc vence em 30-90 dias
  CRITICO  — algum doc vencido OU vence antes do fim do contrato

Quando muda OK→ATENCAO/CRITICO (e o novo status é CRITICO), dispara alerta por
e-mail pro ``responsavelSgi`` (ou pra todos da Conformidade {ADMIN, LIDER, SGI}
se não houver responsável).

────────────────────────────────────────────────────────────────────────────────
AUTH (paridade EXATA com o Next — ``verifyCronAuth``):
  Se ``CRON_SECRET`` está configurado -> SEMPRE exige ``Authorization: Bearer
  <CRON_SECRET>`` (comparação constant-time). Sem o secret (dev) -> aceita
  ``x-vercel-cron: 1``. Não autorizado -> 401 ``{"error":"Não autorizado"}``
  (early-return inline do route.ts, NÃO o ``{"detail":...}`` do require_cron).

  O route.ts NÃO aceita disparo manual por ADMIN logado — só o segredo de cron.

────────────────────────────────────────────────────────────────────────────────
LÓGICA replicada de route.ts (verbatim, inclusive a estrutura de try/catch):

  ativos = SELECT * FROM contratos_execucao WHERE status = 'ATIVO'.

  Para cada contrato (em try/catch próprio — 1 falha não derruba o job):
    stats.avaliados++
    { statusNovo, motivos } = avaliarSaude(c)
    mudou = c.statusSaude !== statusNovo
    if mudou: UPDATE contratos_execucao SET status_saude=:novo, atualizado_em=now()
              WHERE id=:id  ; stats.mudou++
    if statusNovo == CRITICO: stats.criticos++  elif ATENCAO: stats.atencao++
    if mudou and statusNovo == CRITICO:
        respEmail = email do responsavelSgi (ativo) ; fallback = emails da Conformidade
        destinatarios = [resp, ...fallback sem resp] se resp senão fallback
        if destinatarios: monta templateContratoCritico + sendEmail
          ok -> stats.emailsEnviados++  ; senão -> stats.emailsFalhos++

  avaliarSaude(contrato):
    - sem envelope_id -> { statusNovo: "OK", motivos: [] }
    - itens = SELECT (envelope_itens INNER requisitos_edital LEFT documentos_habilitacao)
              WHERE envelope_id = :env
    - para cada item OBRIGATÓRIO (req.obrigatorio):
        sem doc atribuído                       -> CRITICO (motivo vencido)
        doc status == VENCIDO                   -> CRITICO (motivo vencido)
        doc validadeIndeterminada               -> ignora (continue)
        sem validadeFim                         -> ignora (continue)
        validadeFim < agora                     -> CRITICO (vencido em ...)
        validadeFim < fimContrato               -> CRITICO (vence antes do fim ...)
        validadeFim < agora+90d                 -> ATENCAO (vence em ...)
    - status: CRITICO se algum crítico; senão ATENCAO se algum atenção; senão OK.

  Datas nos motivos: ``new Date(validade).toLocaleDateString("pt-BR")`` no Next
  roda no runtime Vercel/Node (UTC) -> dd/mm/aaaa em UTC. Replicado em _fmt_data_br.

  ── Piggyback (best-effort, try/catch próprio): gap de habilitação ──
     (o piggyback de previsão de win-rate saiu na limpeza de 2026-09)
     selectDistinct(requisitos_edital.licitacao_id) JOIN licitacoes (fase =
     'Recebendo Propostas') LIMIT 50; para cada candidata: calcularGapHabilitacao
     (usarIA:false) -> stats.gapRecalculados / stats.gapFalhas.

  log.info("execução concluída", { stats }) -> NextResponse.json({ ok: true, stats }).

  Try/catch de TOPO: falha inesperada -> handleApiError(e) -> 500 {"error":"Erro interno"}.

RESPOSTA (200): ``{ "ok": true, "stats": { avaliados, mudou, criticos, atencao,
  emailsEnviados, emailsFalhos, gapRecalculados, gapFalhas } }``
(mesma ORDEM de chaves do objeto literal do Next; números inteiros nativos).
"""

from __future__ import annotations

import json as _json
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.config import settings
from app.core.cron_auth import verify_cron_auth
from app.core.email import send_email
from app.db.session import get_db

# Réplicas canônicas (CNPJ Proponente / Math.round do JS) — ver _shared.py.
from app.routers.migrated._shared import PROPONENTE_CNPJ, js_round as _js_round

router = APIRouter()


# Papéis da Conformidade (fallback de destinatários) — {ADMIN, LIDER, SGI}.
# Espelha ROLES_CONFORMIDADE / inArray(users.role, [ADMIN, LIDER, SGI]).
ROLES_CONFORMIDADE = ("ADMIN", "LIDER", "SGI")

# Vocabulário de subcategorias do gap (ordem idêntica à de gap-habilitacao.ts).
SUBCATEGORIAS: list[str] = [
    "CND_FEDERAL", "FGTS", "CNDT", "CND_ESTADUAL", "CND_MUNICIPAL", "FALENCIA",
    "BALANCO", "INDICES_FINANCEIROS",
    "CONTRATO_SOCIAL", "CNPJ", "ATO_CONSTITUTIVO", "PROCURACAO",
    "ATESTADO_ACT", "ISO_9001", "ISO_14001", "ISO_45001",
    "NR_10", "NR_13", "NR_35", "ASME", "API_Q1", "API_6D", "PED", "OUTROS_TECNICOS",
    "CREA_PJ", "CREA_PF", "ART_CAT", "CTPS", "FORMACAO",
    "DECL_MENOR_NAO_EMPREGA", "DECL_IDONEIDADE", "DECL_ME_EPP", "DECL_OUTRA",
    "OUTRO",
]
_SUBCATEGORIAS_SET = set(SUBCATEGORIAS)

# E-mail base URL — espelha NEXTAUTH_URL ?? "http://localhost:3000" (templates.ts).
_BASE_URL = settings.nextauth_url or "http://localhost:3000"

# Meses por extenso em pt-BR (toLocaleDateString month:"long" / America/Sao_Paulo).
_MESES_PT = [
    "janeiro", "fevereiro", "março", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
]


# ══════════════════════════════════════════════════════════════════════════════
# Helpers de data / número (réplica fiel do comportamento JS)
# ══════════════════════════════════════════════════════════════════════════════


def _as_aware_utc(dt: Any) -> datetime | None:
    """Garante datetime tz-aware (assume UTC se naive) p/ comparações seguras."""
    if dt is None or not isinstance(dt, datetime):
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _fmt_data_br(dt: datetime) -> str:
    """Réplica de ``new Date(x).toLocaleDateString("pt-BR")`` -> dd/mm/aaaa.

    Sem timeZone explícito, o Next roda no runtime Vercel/Node (UTC); por isso
    formatamos o instante em UTC.
    """
    d = _as_aware_utc(dt)
    if d is None:
        return ""
    d = d.astimezone(timezone.utc)
    return f"{d.day:02d}/{d.month:02d}/{d.year:04d}"


def _fmt_data_longa_br(dt: datetime) -> str:
    """Réplica de ``formatDate`` (templates.ts): toLocaleDateString("pt-BR",
    {day:2-digit, month:long, year:numeric, hour:2-digit, minute:2-digit,
     timeZone:"America/Sao_Paulo"}) -> ``DD de mês de AAAA, HH:MM`` (24h).
    """
    d = _as_aware_utc(dt)
    if d is None:
        return ""
    try:
        from zoneinfo import ZoneInfo

        d = d.astimezone(ZoneInfo("America/Sao_Paulo"))
    except Exception:  # noqa: BLE001
        d = d.astimezone(timezone.utc)
    mes = _MESES_PT[d.month - 1]
    return f"{d.day:02d} de {mes} de {d.year:04d}, {d.hour:02d}:{d.minute:02d}"





def _esc_html(s: Any) -> str:
    """Coerção JS ``${x}`` em HTML — não há escaping no template Next (template
    literals cru). Mantemos paridade: só coage para string (sem escapar)."""
    if s is None:
        return ""
    return str(s)


# ══════════════════════════════════════════════════════════════════════════════
# templateContratoCritico (réplica fiel de templates.ts)
# ══════════════════════════════════════════════════════════════════════════════


def _link_contrato(_id: str) -> str:
    """linkContrato — fallback p/ /acervo/cofre (templates.ts)."""
    return f"{_BASE_URL}/acervo/cofre"


def _layout(conteudo: str) -> str:
    """Réplica do layout base (templates.ts)."""
    ano = datetime.now(tz=timezone.utc).year
    return (
        "<!DOCTYPE html>\n"
        '<html lang="pt-BR">\n'
        "<head>\n"
        '  <meta charset="UTF-8" />\n'
        '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n'
        '  <meta name="color-scheme" content="light" />\n'
        '  <meta name="supported-color-schemes" content="light" />\n'
        "  <title>Petro Radar</title>\n"
        "</head>\n"
        "<body style=\"margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;\">\n"
        '  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">\n'
        "    <tr>\n"
        '      <td align="center">\n'
        '        <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.12);">\n'
        "          <!-- Header -->\n"
        "          <tr>\n"
        '            <td style="background:#0f172a;padding:20px 32px;">\n'
        '              <span style="color:#f8fafc;font-size:20px;font-weight:700;letter-spacing:-0.5px;">\n'
        "                Petro Radar\n"
        "              </span>\n"
        '              <span style="color:#94a3b8;font-size:13px;margin-left:12px;">Petro Radar</span>\n'
        "            </td>\n"
        "          </tr>\n"
        "          <!-- Body -->\n"
        "          <tr>\n"
        '            <td style="padding:32px;">\n'
        f"              {conteudo}\n"
        "            </td>\n"
        "          </tr>\n"
        "          <!-- Footer -->\n"
        "          <tr>\n"
        '            <td style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0;">\n'
        '              <p style="margin:0;color:#94a3b8;font-size:12px;text-align:center;">\n'
        "                Este é um e-mail automático do sistema Petro Radar. Não responda este e-mail.<br/>\n"
        f"                © {ano} Petro Radar\n"
        "              </p>\n"
        "            </td>\n"
        "          </tr>\n"
        "        </table>\n"
        "      </td>\n"
        "    </tr>\n"
        "  </table>\n"
        "</body>\n"
        "</html>"
    )


def _badge(cor: str, texto: str) -> str:
    return (
        f'<span style="display:inline-block;background:{cor};color:#fff;'
        f'padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;">{texto}</span>'
    )


def _button(href: str, texto: str) -> str:
    return (
        f'<a href="{href}" style="display:inline-block;background:#0f172a;'
        "color:#f8fafc;padding:12px 24px;border-radius:6px;text-decoration:none;"
        f'font-weight:600;font-size:14px;margin-top:20px;">{texto}</a>'
    )


def _info_row(label: str, value: str) -> str:
    return (
        "<tr>\n"
        f'    <td style="padding:6px 0;color:#64748b;font-size:13px;width:140px;vertical-align:top;">{label}</td>\n'
        f'    <td style="padding:6px 0;color:#0f172a;font-size:13px;font-weight:500;">{value}</td>\n'
        "  </tr>"
    )


def _template_contrato_critico(
    contrato_id: str,
    numero: str,
    objeto: str,
    periodo_fim: datetime,
    motivos_criticos: list[str],
) -> dict[str, str]:
    """Réplica de ``templateContratoCritico`` (templates.ts)."""
    subject = f"🔴 CRÍTICO: Contrato {numero} com pendências de habilitação"

    motivos = "".join(
        f'<li style="color:#0f172a;font-size:13px;margin-bottom:4px;">{_esc_html(m)}</li>'
        for m in motivos_criticos
    )

    objeto_str = _esc_html(objeto)
    objeto_table = (
        objeto_str[:120] + "…" if len(objeto_str) > 120 else objeto_str
    )

    html = _layout(
        "\n"
        '    <h2 style="margin:0 0 4px;color:#0f172a;font-size:22px;">Contrato em Risco</h2>\n'
        '    <p style="margin:0 0 24px;color:#64748b;font-size:14px;">\n'
        f'      {_badge("#dc2626", "CRÍTICO")} Documentos obrigatórios em pendência\n'
        "    </p>\n"
        "\n"
        '    <table cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #e2e8f0;border-radius:6px;padding:16px;margin-bottom:24px;">\n'
        f'      {_info_row("Contrato", _esc_html(numero))}\n'
        f'      {_info_row("Objeto", objeto_table)}\n'
        f'      {_info_row("Fim do Contrato", _fmt_data_longa_br(periodo_fim))}\n'
        "    </table>\n"
        "\n"
        '    <p style="color:#0f172a;font-size:14px;margin:0 0 8px;font-weight:600;">Pendências detectadas:</p>\n'
        f'    <ul style="margin:0 0 24px;padding-left:20px;">{motivos}</ul>\n'
        "\n"
        '    <p style="color:#64748b;font-size:14px;margin:0 0 8px;">\n'
        "      Petrobras pode aplicar penalidades e até rescisão se documentos obrigatórios estiverem vencidos durante a execução.\n"
        "    </p>\n"
        "\n"
        f'    {_button(_link_contrato(contrato_id), "Acessar Contrato →")}\n'
        "  "
    )

    texto_motivos = "\n".join(f"- {_esc_html(m)}" for m in motivos_criticos)
    text = (
        f"CRÍTICO: Contrato {_esc_html(numero)}\n\n{texto_motivos}\n\n"
        f"Objeto: {_esc_html(objeto)}\nFim: {_fmt_data_longa_br(periodo_fim)}\n\n"
        f"Acesse: {_link_contrato(contrato_id)}"
    )

    return {"subject": subject, "html": html, "text": text}


# ══════════════════════════════════════════════════════════════════════════════
# Destinatários (réplica de getDestinatariosConformidade / getEmailDoUsuario)
# ══════════════════════════════════════════════════════════════════════════════


async def _get_destinatarios_conformidade(db) -> list[str]:
    """Réplica de ``getDestinatariosConformidade``.

    SELECT email FROM users WHERE ativo = true AND role IN (ADMIN, LIDER, SGI);
    map(u => u.email).filter(Boolean) — descarta emails falsy (None/"").
    """
    rows = (
        await db.execute(
            text(
                "SELECT email AS email FROM users "
                "WHERE ativo = true AND role IN ('ADMIN', 'LIDER', 'SGI')"
            )
        )
    ).mappings().all()
    return [r["email"] for r in rows if r["email"]]


async def _get_email_do_usuario(db, user_id: str | None) -> str | None:
    """Réplica de ``getEmailDoUsuario``.

    Sem userId -> None. Senão SELECT email FROM users WHERE id=:id AND ativo=true
    LIMIT 1 -> email (ou None).
    """
    if not user_id:
        return None
    row = (
        await db.execute(
            text(
                "SELECT email AS email FROM users "
                "WHERE id = :id AND ativo = true LIMIT 1"
            ),
            {"id": user_id},
        )
    ).mappings().first()
    return (row["email"] if row is not None else None) or None


# ══════════════════════════════════════════════════════════════════════════════
# avaliarSaude (réplica fiel)
# ══════════════════════════════════════════════════════════════════════════════


async def _avaliar_saude(db, contrato: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    """Réplica de ``avaliarSaude``. Retorna (statusNovo, motivos)."""
    motivos: list[dict[str, Any]] = []

    if not contrato["envelope_id"]:
        # Sem envelope, não temos itens — não conseguimos avaliar.
        return ("OK", [])

    # Itens do envelope com seus docs e validades (INNER requisitos / LEFT docs).
    itens = (
        await db.execute(
            text(
                """
                SELECT
                    ei.status                        AS item_status,
                    re.codigo                        AS req_codigo,
                    re.descricao                     AS req_descricao,
                    re.obrigatorio                   AS req_obrigatorio,
                    ei.documento_id                  AS doc_id,
                    dh.titulo                        AS doc_titulo,
                    dh.validade_fim                  AS doc_validade_fim,
                    dh.validade_indeterminada        AS doc_indeterm,
                    dh.status                        AS doc_status
                FROM envelope_itens ei
                INNER JOIN requisitos_edital re ON ei.requisito_id = re.id
                LEFT JOIN documentos_habilitacao dh ON ei.documento_id = dh.id
                  AND (dh.restrito = false OR dh.restrito IS NULL)
                WHERE ei.envelope_id = :env
                """
            ),
            {"env": contrato["envelope_id"]},
        )
    ).mappings().all()

    critico = False
    atencao = False
    fim_contrato = _as_aware_utc(contrato["periodo_fim"])
    agora = datetime.now(tz=timezone.utc)
    em90 = agora + timedelta(days=90)

    for it in itens:
        if not it["req_obrigatorio"]:
            continue

        if not it["doc_id"]:
            critico = True
            motivos.append(
                {
                    "texto": f'Sem documento atribuído para "{_esc_html(it["req_descricao"])}"',
                    "vencido": True,
                }
            )
            continue
        if it["doc_status"] == "VENCIDO":
            critico = True
            motivos.append(
                {
                    "texto": f'{_esc_html(it["doc_titulo"])} ({_esc_html(it["req_codigo"])}) está vencido',
                    "vencido": True,
                }
            )
            continue
        if it["doc_indeterm"]:
            continue
        if not it["doc_validade_fim"]:
            continue

        validade = _as_aware_utc(it["doc_validade_fim"])
        if validade < agora:
            critico = True
            motivos.append(
                {
                    "texto": (
                        f'{_esc_html(it["doc_titulo"])} ({_esc_html(it["req_codigo"])}) '
                        f"vencido em {_fmt_data_br(validade)}"
                    ),
                    "vencido": True,
                }
            )
        elif fim_contrato is not None and validade < fim_contrato:
            # Vence antes do fim do contrato — crítico
            critico = True
            motivos.append(
                {
                    "texto": (
                        f'{_esc_html(it["doc_titulo"])} ({_esc_html(it["req_codigo"])}) '
                        f"vence em {_fmt_data_br(validade)}, antes do fim do contrato"
                    ),
                    "vencido": False,
                }
            )
        elif validade < em90:
            atencao = True
            motivos.append(
                {
                    "texto": (
                        f'{_esc_html(it["doc_titulo"])} ({_esc_html(it["req_codigo"])}) '
                        f"vence em {_fmt_data_br(validade)}"
                    ),
                    "vencido": False,
                }
            )

    status_novo = "CRITICO" if critico else ("ATENCAO" if atencao else "OK")
    return (status_novo, motivos)


# ══════════════════════════════════════════════════════════════════════════════
# Piggyback: gap de habilitação (réplica fiel — gap-habilitacao.ts, usarIA:false)
# ══════════════════════════════════════════════════════════════════════════════


class GapNotFound(Exception):
    """Erro tipado (espelha ``class GapNotFound``)."""


def _resolver_data_referencia(
    data_abertura: str | None,
    data_disputa: str | None,
    data_fim: str | None,
) -> datetime | None:
    """1ª data válida entre [abertura, disputa, fim]; ISO ou BR -> meia-noite UTC."""
    for c in (data_abertura, data_disputa, data_fim):
        if not c:
            continue
        iso = re.match(r"^(\d{4})-(\d{2})-(\d{2})", c)
        if iso:
            try:
                return datetime(
                    int(iso.group(1)), int(iso.group(2)), int(iso.group(3)),
                    tzinfo=timezone.utc,
                )
            except ValueError:
                pass
        br = re.match(r"^(\d{2})/(\d{2})/(\d{4})", c)
        if br:
            try:
                return datetime(
                    int(br.group(3)), int(br.group(2)), int(br.group(1)),
                    tzinfo=timezone.utc,
                )
            except ValueError:
                pass
    return None


def _classificar_cobertura(
    subcat: str | None,
    doc_por_subcat: dict[str, dict[str, Any]],
    data_ref: datetime | None,
) -> tuple[str, dict[str, Any] | None]:
    """Réplica de ``classificarCobertura``."""
    if not subcat:
        return ("FALTANTE", None)
    doc = doc_por_subcat.get(subcat)
    if not doc:
        return ("FALTANTE", None)
    validade_fim = _as_aware_utc(doc["validadeFim"])
    if (
        not doc["validadeIndeterminada"]
        and validade_fim is not None
        and data_ref is not None
        and validade_fim < data_ref
    ):
        return ("VENCE_ANTES_DA_DATA", doc)
    return ("ATENDIDO", doc)


async def _carregar_doc_por_subcat(db) -> dict[str, dict[str, Any]]:
    """Cofre VIGENTE indexado por subcategoria, escolhendo a MELHOR validade."""
    docs = (
        await db.execute(
            text(
                """
                SELECT
                    id                       AS id,
                    titulo                   AS titulo,
                    subcategoria             AS subcategoria,
                    validade_fim             AS validade_fim,
                    validade_indeterminada   AS validade_indeterminada
                FROM documentos_habilitacao
                WHERE status = 'VIGENTE'
                  AND restrito = false
                """
                # 0034/S18: sugestão automática de prova no e-mail de saúde
                # nunca cita documento restrito (cron sem sessão → literal).
            )
        )
    ).mappings().all()

    doc_por_subcat: dict[str, dict[str, Any]] = {}
    for d in docs:
        doc = {
            "id": str(d["id"]),
            "titulo": d["titulo"],
            "subcategoria": d["subcategoria"],
            "validadeFim": d["validade_fim"],
            "validadeIndeterminada": bool(d["validade_indeterminada"]),
        }
        subcat = doc["subcategoria"]
        atual = doc_por_subcat.get(subcat)
        if atual is None:
            doc_por_subcat[subcat] = doc
            continue
        d_fim = _as_aware_utc(doc["validadeFim"])
        a_fim = _as_aware_utc(atual["validadeFim"])
        if doc["validadeIndeterminada"] and not atual["validadeIndeterminada"]:
            doc_por_subcat[subcat] = doc
        elif (
            not atual["validadeIndeterminada"]
            and d_fim is not None
            and a_fim is not None
            and d_fim > a_fim
        ):
            doc_por_subcat[subcat] = doc
    return doc_por_subcat


async def _calcular_gap_habilitacao(db, licitacao_id: str, usar_ia: bool) -> None:
    """Réplica de ``calcularGapHabilitacao`` (usarIA:false no piggyback).

    Levanta GapNotFound se a licitação não existir. Persiste via DELETE + INSERTs.
    O cron só usa o efeito colateral (persistência) — não consome o resultado.
    Com ``usar_ia=False`` (piggyback), os ambíguos NÃO são resolvidos por IA.
    """
    lic = (
        await db.execute(
            text("SELECT * FROM licitacoes WHERE id = :id LIMIT 1"),
            {"id": licitacao_id},
        )
    ).mappings().first()
    if lic is None:
        raise GapNotFound()

    data_ref = _resolver_data_referencia(
        lic["data_abertura"], lic["data_disputa"], lic["data_fim"]
    )

    requisitos = (
        await db.execute(
            text(
                "SELECT id AS id, codigo AS codigo, descricao AS descricao "
                "FROM requisitos_edital WHERE licitacao_id = :id ORDER BY ordem"
            ),
            {"id": licitacao_id},
        )
    ).mappings().all()

    analise = (
        await db.execute(
            text(
                "SELECT criterios_habilitacao AS criterios FROM analises_ia "
                "WHERE licitacao_id = :id LIMIT 1"
            ),
            {"id": licitacao_id},
        )
    ).mappings().first()

    criterios_raw = analise["criterios"] if analise is not None else None
    criterios_texto: list[str] = (
        [c for c in criterios_raw if isinstance(c, str)]
        if isinstance(criterios_raw, list)
        else []
    )

    doc_por_subcat = await _carregar_doc_por_subcat(db)

    itens: list[dict[str, Any]] = []
    ambiguos: list[dict[str, Any]] = []

    for req in requisitos:
        codigo = req["codigo"]
        match_por_codigo = (codigo in doc_por_subcat) or (codigo in _SUBCATEGORIAS_SET)
        if match_por_codigo:
            status_cob, doc = _classificar_cobertura(codigo, doc_por_subcat, data_ref)
            itens.append(
                {
                    "requisitoId": str(req["id"]),
                    "requisitoCodigo": codigo,
                    "statusCobertura": status_cob,
                    "documentoId": doc["id"] if doc else None,
                    "venceEm": doc["validadeFim"] if doc else None,
                    "metodoMatch": "CODIGO",
                    "confianca": 1,
                    "justificativa": (
                        f"Match por código ({codigo})."
                        if doc
                        else f"Sem documento VIGENTE para {codigo}."
                    ),
                }
            )
        else:
            ambiguos.append({"descricao": req["descricao"], "requisitoId": str(req["id"])})

    descricoes_req = {r["descricao"] for r in requisitos}
    for crit in criterios_texto:
        if crit in descricoes_req:
            continue
        ambiguos.append({"descricao": crit, "requisitoId": None})

    # usar_ia=False no piggyback -> NÃO chama IA; mapa de resolução vazio.
    resolucao: dict[str, dict[str, Any]] = {}

    for amb in ambiguos:
        r = resolucao.get(amb["descricao"])
        subcat = r["subcategoria"] if r else None
        status_cob, doc = _classificar_cobertura(subcat, doc_por_subcat, data_ref)
        itens.append(
            {
                "requisitoId": amb["requisitoId"],
                "requisitoCodigo": subcat,
                "statusCobertura": status_cob if subcat else "FALTANTE",
                "documentoId": doc["id"] if doc else None,
                "venceEm": doc["validadeFim"] if doc else None,
                "metodoMatch": "IA",
                "confianca": (r["confianca"] if r else 0),
                "justificativa": (
                    r["justificativa"]
                    if r
                    else "Requisito ambíguo, sem mapeamento de subcategoria."
                ),
            }
        )

    calculado_em = datetime.now(tz=timezone.utc)

    await db.execute(
        text("DELETE FROM gap_habilitacao WHERE licitacao_id = :id"),
        {"id": licitacao_id},
    )

    for it in itens:
        await db.execute(
            text(
                """
                INSERT INTO gap_habilitacao
                    (licitacao_id, requisito_id, requisito_codigo, status_cobertura,
                     documento_id, familia_id, vence_em, metodo_match, confianca,
                     justificativa, calculado_em)
                VALUES
                    (:licitacao_id, :requisito_id, :requisito_codigo, :status_cobertura,
                     :documento_id, NULL, :vence_em, :metodo_match, :confianca,
                     :justificativa, :calculado_em)
                """
            ),
            {
                "licitacao_id": licitacao_id,
                "requisito_id": it["requisitoId"],
                "requisito_codigo": it["requisitoCodigo"],
                "status_cobertura": it["statusCobertura"],
                "documento_id": it["documentoId"],
                "vence_em": _as_aware_utc(it["venceEm"]),
                "metodo_match": it["metodoMatch"],
                "confianca": it["confianca"],
                "justificativa": it["justificativa"],
                "calculado_em": calculado_em,
            },
        )

    await db.commit()


# ══════════════════════════════════════════════════════════════════════════════
# GET — cron diário de saúde de contratos
# ══════════════════════════════════════════════════════════════════════════════
@router.get("/api/cron/saude-contratos")
async def get_saude_contratos(request: Request) -> JSONResponse:
    """Cron diário: recalcula saúde de contratos + piggyback do gap.

    Auth: verify_cron_auth (Bearer CRON_SECRET ou x-vercel-cron). Não autorizado
    -> 401 {"error":"Não autorizado"}. Sucesso -> 200 {ok:true, stats}. Falha
    inesperada de topo -> 500 {"error":"Erro interno"} (handleApiError).
    """
    # if (!verifyCronAuth(req)) return 401 {"error":"Não autorizado"}.
    if not verify_cron_auth(request):
        return JSONResponse(status_code=401, content={"error": "Não autorizado"})

    stats = {
        "avaliados": 0,
        "mudou": 0,
        "criticos": 0,
        "atencao": 0,
        "emailsEnviados": 0,
        "emailsFalhos": 0,
        # Piggyback: recálculo em lote do gap de habilitação.
        "gapRecalculados": 0,
        "gapFalhas": 0,
    }

    # get_db é um generator de dependency; aqui obtemos a sessão manualmente
    # (rota sem Depends de DB para espelhar a borda de cron do Next).
    db_gen = get_db()
    db = await db_gen.__anext__()
    try:
        # Try/catch de topo: falha inesperada -> 500 (handleApiError).
        try:
            ativos = (
                await db.execute(
                    text("SELECT * FROM contratos_execucao WHERE status = 'ATIVO'")
                )
            ).mappings().all()

            for c in ativos:
                # Cada contrato em try/catch próprio: 1 falha não derruba o job.
                try:
                    stats["avaliados"] += 1
                    status_novo, motivos = await _avaliar_saude(db, c)

                    mudou = c["status_saude"] != status_novo
                    if mudou:
                        await db.execute(
                            text(
                                "UPDATE contratos_execucao "
                                "SET status_saude = :novo, atualizado_em = :agora "
                                "WHERE id = :id"
                            ),
                            {
                                "novo": status_novo,
                                "agora": datetime.now(tz=timezone.utc),
                                "id": str(c["id"]),
                            },
                        )
                        await db.commit()
                        stats["mudou"] += 1

                    if status_novo == "CRITICO":
                        stats["criticos"] += 1
                    elif status_novo == "ATENCAO":
                        stats["atencao"] += 1

                    # Alerta apenas quando piorou para CRITICO.
                    if mudou and status_novo == "CRITICO":
                        resp_email = await _get_email_do_usuario(
                            db, str(c["responsavel_sgi"]) if c["responsavel_sgi"] else None
                        )
                        fallback = await _get_destinatarios_conformidade(db)
                        if resp_email:
                            destinatarios = [resp_email] + [
                                e for e in fallback if e != resp_email
                            ]
                        else:
                            destinatarios = fallback
                        if len(destinatarios) > 0:
                            tpl = _template_contrato_critico(
                                contrato_id=str(c["id"]),
                                numero=c["numero"],
                                objeto=c["objeto"],
                                periodo_fim=c["periodo_fim"],
                                motivos_criticos=[m["texto"] for m in motivos][:10],
                            )
                            r = await send_email(
                                to=destinatarios,
                                subject=tpl["subject"],
                                html=tpl["html"],
                                text=tpl["text"],
                            )
                            if r.get("ok"):
                                stats["emailsEnviados"] += 1
                            else:
                                stats["emailsFalhos"] += 1
                except Exception:
                    # log.error("falha ao avaliar contrato", e, { contratoId })
                    await db.rollback()

            # ── Piggyback: recálculo em lote do gap de habilitação ──────────────
            # usarIA:false p/ conter custo (requisitos ambíguos ficam FALTANTE).
            try:
                candidatas = (
                    await db.execute(
                        text(
                            """
                            SELECT DISTINCT re.licitacao_id AS licitacao_id
                            FROM requisitos_edital re
                            INNER JOIN licitacoes l ON l.id = re.licitacao_id
                            WHERE l.fase = 'Recebendo Propostas'
                            LIMIT 50
                            """
                        )
                    )
                ).mappings().all()

                for cand in candidatas:
                    try:
                        await _calcular_gap_habilitacao(
                            db, str(cand["licitacao_id"]), usar_ia=False
                        )
                        stats["gapRecalculados"] += 1
                    except Exception:
                        # log.error("falha no recálculo de gap (piggyback)", errItem)
                        stats["gapFalhas"] += 1
                        await db.rollback()
            except Exception:
                # log.error("falha ao selecionar candidatas de gap (piggyback)", err)
                await db.rollback()

            # log.info("execução concluída", { stats })
            return JSONResponse(content={"ok": True, "stats": stats})
        except Exception:
            # log.error("falha geral no cron de saúde de contratos", e, { stats })
            # handleApiError(e) -> erro inesperado -> 500 {"error":"Erro interno"}.
            await db.rollback()
            return JSONResponse(status_code=500, content={"error": "Erro interno"})
    finally:
        await db_gen.aclose()
