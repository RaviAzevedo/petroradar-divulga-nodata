"""Rota migrada (strangler-fig): /api/conformidade/familias (GET + POST).

Equivalente 1:1 de ``src/app/api/conformidade/familias/route.ts`` — listagem
paginada/filtrada de famílias CRC (GET) e criação de família CRC (POST).

────────────────────────────────────────────────────────────────────────────
GET /api/conformidade/familias
────────────────────────────────────────────────────────────────────────────
Guard Next:
    ``requireVisualizar()`` (401 se sem sessão; 403 ``{ "error": "Permissão
    negada" }`` se role ∉ ROLES_VISUALIZAR). Equivalente no BFF:
    :data:`app.core.security.require_visualizar` (ADMIN, LIDER, ORCAMENTISTA,
    TECNICO, SGI, VISUALIZADOR). O 401 vem por baixo de ``get_current_user``.

Query params lidos (mesmos nomes/defaults do Next + FiltrosFamiliaSchema):
    status            enum StatusFamilia (ATIVA/EM_RENOVACAO/SUSPENSA/VENCIDA/REJEITADA)
    statusFluxoCrc    enum (D/Q/A/X)
    segmentoPetrobras enum (YELLOW_PAGES/OPERACIONAL/CRITICA/ESTRATEGICA)
    nivel             enum (FAMILIA/SUBFAMILIA/GRUPO/ITEM)
    parentId          uuid
    busca             str  max 200    ILIKE em codigo_crc/nome/descricao
    vencendoEm        int  1..365      validade_fim ∈ [hoje, hoje+N)
    page              int  default 1   min 1
    limit             int  default 50  1..500
    order             enum codigo|nome|status|validade|criado_em  default codigo
    dir               enum asc|desc                                default asc

    Defaults aplicados ANTES do parse (espelha o ?? do route.ts):
      page="1", limit="50", order="codigo", dir="asc"; demais ?? undefined.
    Parse inválido → 400 ``{ "error": "Parâmetros inválidos", "detalhes": {...} }``.

Shape da resposta (idêntico a listFamilias):
    { "data": [ {...familia camelCase} ], "total": int, "page": int,
      "limit": int, "pages": int }

────────────────────────────────────────────────────────────────────────────
POST /api/conformidade/familias
────────────────────────────────────────────────────────────────────────────
Guard Next (MESMA ORDEM):
    1. ``requireAuth()`` → 401 ``{ "error": "Não autenticado", "code":
       "UNAUTHENTICATED" }`` se sem sessão.
    2. ``podeGerenciarFamilias(role)`` = ``isConformidade(role)`` →
       role ∈ {ADMIN, LIDER, SGI}; senão 403 ``{ "error": "Permissão negada" }``.

    No BFF replicamos a ordem 401-antes-de-403 manualmente: ``get_current_user``
    (401) e depois checagem de papel (403). NÃO usamos ``require_conformidade``
    como dependency direta porque o Next devolve o 403 com shape
    ``{ "error": "Permissão negada" }`` (sem ``code``/``detail``).

Corpo (mesmos campos/validações de CriarFamiliaSchema):
    codigoCrc*           str  2..50
    nome*                str  2..200
    descricao            str  ≤2000
    nivel                enum default "FAMILIA"
    parentId             uuid | null
    cadastroCorporativo  bool default true
    segmentoPetrobras    enum | null
    status               enum default "ATIVA"
    statusFluxoCrc       enum | null
    validadeFim          str ISO-8601 datetime | null
    criterios            record<CriterioCrc, {status, validadeFim, observacao?}>
    tags                 str[≤50] (≤50)
    escoposCobertos      str[≤200] (≤100)
    observacoes          str ≤2000

    JSON malformado → 400 ``{ "error": "JSON inválido" }``.
    Validação falha → 422 ``{ "error": "Dados inválidos", "detalhes": {...} }``.

Lógica replicada (mesma do route.ts, BUGS DE PRODUÇÃO INCLUSOS):
    1. ``normalizarCodigoCrc`` (NFD → remove diacríticos → só [A-Za-z0-9] →
       upper).
    2. Unicidade: SELECT id FROM familias WHERE codigo_normalizado=? AND
       deletado_em IS NULL LIMIT 1 → 409 ``{ "error": "Já existe uma família
       com código <codigoCrc>" }``.
    3. Resolução do ``path`` — **BUG DE PRODUÇÃO REPLICADO**: quando há
       ``parentId``, o route.ts busca o parent por
       ``where(eq(familias.parentId, data.parentId))`` (coluna PARENT_ID, e não
       ``id``). Mantemos o mesmo WHERE incorreto. Se achar parent com path →
       ``"<parent.path>/<codigoCrc>"``, senão → ``codigoCrc``.
    4. ``proximaRenovacaoEm`` = validadeFim - 60 dias (ou null).
    5. INSERT na ``familias`` ... RETURNING * (devolve a linha criada).
    6. INSERT no ``audit_log`` (acao=CRIAR_FAMILIA, entidade=familia,
       entidade_id=<id>, detalhes={codigoCrc, nome, status}).
    7. Resposta: linha criada (camelCase) com status 201.

Serialização (paritária com o Next):
    datetime → ``.isoformat()``; uuid → ``str()``; numeric/jsonb → nativo.

Colunas (snake_case no banco → camelCase no Drizzle/alias projetado):
    id (uuid)                    → "id"
    codigo_crc (text)            → "codigoCrc"
    codigo_normalizado (text)    → "codigoNormalizado"
    nome (text)                  → "nome"
    descricao (text)             → "descricao"
    nivel (text)                 → "nivel"
    parent_id (uuid)             → "parentId"
    path (text)                  → "path"
    cadastro_corporativo (bool)  → "cadastroCorporativo"
    segmento_petrobras (text)    → "segmentoPetrobras"
    status (text)                → "status"
    status_fluxo_crc (text)      → "statusFluxoCrc"
    validade_fim (timestamptz)   → "validadeFim"
    proxima_renovacao_em (tstz)  → "proximaRenovacaoEm"
    criterios (jsonb)            → "criterios"
    tags (jsonb)                 → "tags"
    escopos_cobertos (jsonb)     → "escoposCobertos"
    observacoes (text)           → "observacoes"
    deletado_em (timestamptz)    → "deletadoEm"
    criado_por (uuid)            → "criadoPor"
    atualizado_por (uuid)        → "atualizadoPor"
    criado_em (timestamptz)      → "criadoEm"
    atualizado_em (timestamptz)  → "atualizadoEm"
"""

from __future__ import annotations

import json as _json
import math
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import (
    CurrentUser,
    get_current_user,
    is_conformidade,
    require_visualizar,
)
from app.db.session import get_db
from app.routers.migrated._shared import serializar, serializar_row
from app.services.audit import registrar_audit

router = APIRouter()


# ── Enums (espelham validations.ts) ───────────────────────────────────────────

_NIVEL = {"FAMILIA", "SUBFAMILIA", "GRUPO", "ITEM"}
_STATUS_FAMILIA = {"ATIVA", "EM_RENOVACAO", "SUSPENSA", "VENCIDA", "REJEITADA"}
_STATUS_CRITERIO = {"APROVADO", "QUALIFICADO", "EM_AVALIACAO", "REJEITADO", "CANCELADO"}
_CRITERIO_CRC = {
    "JURIDICO",
    "ECONOMICO",
    "TECNICO",
    "TECNICO_SMS",
    "LFO",
    "REVENDEDOR",
    "INTEGRIDADE",
}
_SEGMENTO = {"YELLOW_PAGES", "OPERACIONAL", "CRITICA", "ESTRATEGICA"}
_STATUS_FLUXO = {"D", "Q", "A", "X"}
_ORDER = {"codigo", "nome", "status", "validade", "criado_em"}
_DIR = {"asc", "desc"}

# Mapa order → coluna SQL (espelha o switch do listFamilias).
_ORDER_COL = {
    "codigo": "codigo_crc",
    "nome": "nome",
    "status": "status",
    "validade": "validade_fim",
    "criado_em": "criado_em",
}

# Mapa coluna_sql → chave camelCase (Drizzle $inferSelect de db.select()).
_FAMILIA_CAMEL = {
    "id": "id",
    "codigo_crc": "codigoCrc",
    "codigo_normalizado": "codigoNormalizado",
    "nome": "nome",
    "descricao": "descricao",
    "nivel": "nivel",
    "parent_id": "parentId",
    "path": "path",
    "cadastro_corporativo": "cadastroCorporativo",
    "segmento_petrobras": "segmentoPetrobras",
    "status": "status",
    "status_fluxo_crc": "statusFluxoCrc",
    "validade_fim": "validadeFim",
    "proxima_renovacao_em": "proximaRenovacaoEm",
    "criterios": "criterios",
    "tags": "tags",
    "escopos_cobertos": "escoposCobertos",
    "observacoes": "observacoes",
    "deletado_em": "deletadoEm",
    "criado_por": "criadoPor",
    "atualizado_por": "atualizadoPor",
    "criado_em": "criadoEm",
    "atualizado_em": "atualizadoEm",
}

# SELECT * com aliases camelCase (espelha db.select().from(familias)).
_FAMILIA_SELECT = ",\n            ".join(
    f'{col} AS "{camel}"' for col, camel in _FAMILIA_CAMEL.items()
)


# ── Serialização (paritária com o Next) ───────────────────────────────────────
# Canônicos de _shared (as cópias locais eram idênticas).
_serializar = serializar
_serializar_row = serializar_row


# ── Mensagens Zod v4.4.3 (paritárias com o projeto) ───────────────────────────
#
# O projeto usa Zod v4.4.3 (não v3). As mensagens-default mudaram completamente.
# Capturadas executando os schemas reais (CriarFamiliaSchema / FiltrosFamiliaSchema):
#   - tipo inválido  → "Invalid input: expected <esperado>, received <recebido>"
#   - enum inválido  → 'Invalid option: expected one of "A"|"B"|...'
#   - string longa   → "Too big: expected string to have <=N characters"
#   - array grande   → "Too big: expected array to have <=N items"
#   - number<min     → "Too small: expected number to be >=N"
#   - number>max     → "Too big: expected number to be <=N"
#   - não-numérico   → "Invalid input: expected number, received NaN"
#   - float p/ int   → "Invalid input: expected int, received number"
#   - datetime ruim  → "Invalid ISO datetime" (interno) / custom no campo de topo


def _js_tipo(valor: Any) -> str:
    """Nome do tipo no estilo JS (p/ mensagens Zod v4: received <tipo>)."""
    if valor is None:
        return "null"
    if isinstance(valor, bool):
        return "boolean"
    if isinstance(valor, (int, float)):
        return "number"
    if isinstance(valor, str):
        return "string"
    if isinstance(valor, list):
        return "array"
    if isinstance(valor, dict):
        return "object"
    return type(valor).__name__


def _zod_expected(esperado: str, valor: Any) -> str:
    """'Invalid input: expected <esperado>, received <tipo de valor>'."""
    return f"Invalid input: expected {esperado}, received {_js_tipo(valor)}"


def _zod_expected_undefined(esperado: str) -> str:
    """Campo ausente (received undefined) — Zod v4."""
    return f"Invalid input: expected {esperado}, received undefined"


def _zod_enum(valores: list[str]) -> str:
    """'Invalid option: expected one of \"A\"|\"B\"|...' (ordem do enum, com aspas)."""
    opcoes = "|".join(f'"{v}"' for v in valores)
    return f"Invalid option: expected one of {opcoes}"


def _zod_str_max(n: int) -> str:
    return f"Too big: expected string to have <={n} characters"


def _zod_array_max(n: int) -> str:
    return f"Too big: expected array to have <={n} items"


def _zod_num_min(n: int) -> str:
    return f"Too small: expected number to be >={n}"


def _zod_num_max(n: int) -> str:
    return f"Too big: expected number to be <={n}"


# Ordens canônicas dos enums (preservam a ordem declarada em validations.ts).
_NIVEL_ORDER = ["FAMILIA", "SUBFAMILIA", "GRUPO", "ITEM"]
_STATUS_FAMILIA_ORDER = ["ATIVA", "EM_RENOVACAO", "SUSPENSA", "VENCIDA", "REJEITADA"]
_STATUS_CRITERIO_ORDER = [
    "APROVADO",
    "QUALIFICADO",
    "EM_AVALIACAO",
    "REJEITADO",
    "CANCELADO",
]
_SEGMENTO_ORDER = ["YELLOW_PAGES", "OPERACIONAL", "CRITICA", "ESTRATEGICA"]
_STATUS_FLUXO_ORDER = ["D", "Q", "A", "X"]
_ORDER_ORDER = ["codigo", "nome", "status", "validade", "criado_em"]
_DIR_ORDER = ["asc", "desc"]


# ── Helpers de validação (espelham Zod) ───────────────────────────────────────


def normalizar_codigo_crc(codigo: str) -> str:
    """Espelha ``normalizarCodigoCrc``: NFD → remove diacríticos → só [A-Za-z0-9] → upper."""
    decomposto = unicodedata.normalize("NFD", codigo)
    sem_diacriticos = "".join(
        c for c in decomposto if unicodedata.category(c) != "Mn"
    )
    so_alnum = "".join(c for c in sem_diacriticos if c.isascii() and c.isalnum())
    return so_alnum.upper()


def _is_iso_datetime(valor: str) -> bool:
    """Espelha ``z.string().datetime()`` BARE do Zod v4.4.3.

    Zod v4 ``.datetime()`` sem opções aceita SOMENTE sufixo ``Z`` (UTC). Ele
    REJEITA qualquer offset ``±HH:MM`` (inclusive ``+00:00``), datetimes sem
    timezone e date-only. Verificado executando o schema real:
        ``...Z``                 → OK
        ``...+03:00`` / ``-03:00`` / ``+00:00`` → rejeitado
        ``...`` (sem tz)         → rejeitado
        ``2026-01-01`` (date)    → rejeitado
    Frações de segundo com ``Z`` são aceitas (``...T00:00:00.123Z``).
    """
    if not isinstance(valor, str):
        return False
    s = valor.strip()
    # Único timezone aceito: 'Z' literal no fim. Qualquer offset/ausência → False.
    if not s.endswith("Z"):
        return False
    corpo = s[:-1]
    # Garante que não há outro designador de tz no corpo (ex.: "+03:00Z").
    if "+" in corpo or corpo.rfind("-") > 9:  # '-' só pode estar em YYYY-MM-DD
        return False
    try:
        dt = datetime.fromisoformat(corpo)
    except ValueError:
        return False
    # Precisa ser datetime completo (tem componente de hora), não date-only.
    return dt.tzinfo is None and "T" in corpo


def _parse_validade_para_dt(valor: str) -> datetime:
    """Converte a string ISO validade para datetime (já validada por _is_iso_datetime)."""
    s = valor.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)


def _js_number(valor: str) -> float:
    """Espelha o JS ``Number(string)`` usado por ``z.coerce.number()``.

    Diferenças vs ``float()`` do Python que importam aqui:
      - ``Number("")`` e string só-espaços → ``0`` (não NaN).
      - ``Number("12abc")`` → ``NaN`` (parse total, não parcial como parseInt).
    Retorna ``float('nan')`` quando o JS retornaria ``NaN``.
    """
    s = valor.strip()
    if s == "":
        return 0.0
    try:
        # float() do Python rejeita sufixos não-numéricos (igual ao Number total).
        return float(s)
    except ValueError:
        return float("nan")


def _coerce_int_field(
    raw_val: str,
    minimo: int | None,
    maximo: int | None,
) -> tuple[int | None, str | None]:
    """Réplica de ``z.coerce.number().int().min(?).max(?)`` (Zod v4.4.3).

    Ordem de checagem do Zod v4:
      1. NaN          → 'Invalid input: expected number, received NaN'
      2. não-inteiro  → 'Invalid input: expected int, received number'
      3. < min        → 'Too small: expected number to be >=N'
      4. > max        → 'Too big: expected number to be <=N'
    Retorna ``(valor_int | None, mensagem_de_erro | None)``.
    """
    num = _js_number(raw_val)
    if num != num:  # NaN
        return None, "Invalid input: expected number, received NaN"
    if num != int(num):  # float não inteiro-valorado (5.5)
        return None, "Invalid input: expected int, received number"
    n = int(num)
    if minimo is not None and n < minimo:
        return None, _zod_num_min(minimo)
    if maximo is not None and n > maximo:
        return None, _zod_num_max(maximo)
    return n, None


# ── GET /api/conformidade/familias ────────────────────────────────────────────


@router.get("/api/conformidade/familias")
async def listar_familias(
    request: Request,
    user: CurrentUser = Depends(require_visualizar),
    db=Depends(get_db),
) -> JSONResponse:
    """Réplica fiel do handler GET: lista famílias com filtros e paginação."""
    qp = request.query_params

    # Defaults aplicados antes do parse (espelha o ?? do route.ts).
    raw = {
        "status": qp.get("status"),
        "statusFluxoCrc": qp.get("statusFluxoCrc"),
        "segmentoPetrobras": qp.get("segmentoPetrobras"),
        "nivel": qp.get("nivel"),
        "parentId": qp.get("parentId"),
        "busca": qp.get("busca"),
        "vencendoEm": qp.get("vencendoEm"),
        "page": qp.get("page") if qp.get("page") is not None else "1",
        "limit": qp.get("limit") if qp.get("limit") is not None else "50",
        "order": qp.get("order") if qp.get("order") is not None else "codigo",
        "dir": qp.get("dir") if qp.get("dir") is not None else "asc",
    }

    detalhes: dict[str, str] = {}

    def _enum(campo: str, valido: set[str], msg: str) -> str | None:
        v = raw[campo]
        if v is None:
            return None
        if v not in valido:
            detalhes[campo] = msg
            return None
        return v

    f_status = _enum("status", _STATUS_FAMILIA, _zod_enum(_STATUS_FAMILIA_ORDER))
    f_status_fluxo = _enum(
        "statusFluxoCrc", _STATUS_FLUXO, _zod_enum(_STATUS_FLUXO_ORDER)
    )
    f_segmento = _enum("segmentoPetrobras", _SEGMENTO, _zod_enum(_SEGMENTO_ORDER))
    f_nivel = _enum("nivel", _NIVEL, _zod_enum(_NIVEL_ORDER))

    # parentId: uuid (z.string().uuid("ID inválido")).
    f_parent_id = raw["parentId"]
    if f_parent_id is not None:
        try:
            import uuid as _uuid

            _uuid.UUID(f_parent_id)
        except (ValueError, AttributeError, TypeError):
            detalhes["parentId"] = "ID inválido"
            f_parent_id = None

    # busca: str max 200.
    f_busca = raw["busca"]
    if f_busca is not None and len(f_busca) > 200:
        detalhes["busca"] = _zod_str_max(200)
        f_busca = None

    # vencendoEm: z.coerce.number().int().min(1).max(365).optional().
    f_vencendo: int | None = None
    if raw["vencendoEm"] is not None:
        f_vencendo, err = _coerce_int_field(raw["vencendoEm"], 1, 365)
        if err is not None:
            detalhes["vencendoEm"] = err

    # page: z.coerce.number().int().min(1).default(1).
    f_page = 1
    page_val, err = _coerce_int_field(raw["page"], 1, None)
    if err is not None:
        detalhes["page"] = err
    elif page_val is not None:
        f_page = page_val

    # limit: z.coerce.number().int().min(1).max(500).default(50).
    f_limit = 50
    limit_val, err = _coerce_int_field(raw["limit"], 1, 500)
    if err is not None:
        detalhes["limit"] = err
    elif limit_val is not None:
        f_limit = limit_val

    # order / dir: enums com default.
    if raw["order"] not in _ORDER:
        detalhes["order"] = _zod_enum(_ORDER_ORDER)
        f_order = "codigo"
    else:
        f_order = raw["order"]

    if raw["dir"] not in _DIR:
        detalhes["dir"] = _zod_enum(_DIR_ORDER)
        f_dir = "asc"
    else:
        f_dir = raw["dir"]

    if detalhes:
        return JSONResponse(
            status_code=400,
            content={"error": "Parâmetros inválidos", "detalhes": detalhes},
        )

    # ── Monta WHERE (espelha listFamilias) ────────────────────────────────────
    conds: list[str] = ["deletado_em IS NULL"]
    params: dict[str, Any] = {}

    if f_status:
        params["status"] = f_status
        conds.append("status = :status")
    if f_status_fluxo:
        params["status_fluxo_crc"] = f_status_fluxo
        conds.append("status_fluxo_crc = :status_fluxo_crc")
    if f_segmento:
        params["segmento_petrobras"] = f_segmento
        conds.append("segmento_petrobras = :segmento_petrobras")
    if f_nivel:
        params["nivel"] = f_nivel
        conds.append("nivel = :nivel")
    if f_parent_id:
        params["parent_id"] = str(f_parent_id)
        conds.append("parent_id = :parent_id")
    if f_busca:
        params["termo"] = f"%{f_busca}%"
        conds.append(
            "(codigo_crc ILIKE :termo OR nome ILIKE :termo OR descricao ILIKE :termo)"
        )
    if f_vencendo:
        agora = datetime.now(tz=timezone.utc)
        limite = agora + timedelta(days=f_vencendo)
        params["venc_agora"] = agora
        params["venc_limite"] = limite
        conds.append("(validade_fim >= :venc_agora AND validade_fim < :venc_limite)")

    where_sql = " AND ".join(conds)
    order_col = _ORDER_COL[f_order]
    order_dir = "DESC" if f_dir == "desc" else "ASC"
    offset = (f_page - 1) * f_limit

    params_rows = {**params, "lim": f_limit, "off": offset}
    sql_rows = text(
        f"""
        SELECT
            {_FAMILIA_SELECT}
        FROM familias
        WHERE {where_sql}
        ORDER BY {order_col} {order_dir}
        LIMIT :lim OFFSET :off
        """
    )
    sql_total = text(f"SELECT COUNT(*) AS total FROM familias WHERE {where_sql}")

    res_rows = await db.execute(sql_rows, params_rows)
    rows = res_rows.mappings().all()
    res_total = await db.execute(sql_total, params)
    total = res_total.scalar() or 0

    data = [_serializar_row(r) for r in rows]
    pages = math.ceil(total / f_limit) if f_limit else 0

    return JSONResponse(
        content={
            "data": data,
            "total": total,
            "page": f_page,
            "limit": f_limit,
            "pages": pages,
        }
    )


# ── POST /api/conformidade/familias ───────────────────────────────────────────


@router.post("/api/conformidade/familias")
async def criar_familia(
    request: Request,
    # requireAuth() (401) — papel checado manualmente p/ replicar o 403 do Next.
    user: CurrentUser = Depends(get_current_user),
    db=Depends(get_db),
) -> JSONResponse:
    """Réplica fiel do handler POST: cria nova família CRC."""
    # ── podeGerenciarFamilias(role) = isConformidade(role) → 403. ─────────────
    if not is_conformidade(user.role):
        return JSONResponse(status_code=403, content={"error": "Permissão negada"})

    # ── Lê o body igual (request.json()) → 400 se inválido. ───────────────────
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 — JSON malformado
        return JSONResponse(status_code=400, content={"error": "JSON inválido"})

    # ── Valida igual ao CriarFamiliaSchema → 422 ``{error, detalhes}``. ───────
    parsed = _validar_criar_familia(body)
    if parsed.get("__erros__"):
        return JSONResponse(
            status_code=422,
            content={"error": "Dados inválidos", "detalhes": parsed["__erros__"]},
        )

    data = parsed["data"]
    codigo_normalizado = normalizar_codigo_crc(data["codigoCrc"])

    # ── Unicidade do código (deletado_em IS NULL) → 409. ──────────────────────
    res_existente = await db.execute(
        text(
            "SELECT id FROM familias "
            "WHERE codigo_normalizado = :cn AND deletado_em IS NULL "
            "LIMIT 1"
        ),
        {"cn": codigo_normalizado},
    )
    if res_existente.first() is not None:
        return JSONResponse(
            status_code=409,
            content={
                "error": f"Já existe uma família com código {data['codigoCrc']}"
            },
        )

    # ── Resolve path (BUG DE PRODUÇÃO: busca parent por parent_id, não id). ───
    path: str | None
    if data.get("parentId"):
        res_parent = await db.execute(
            text(
                "SELECT id, codigo_crc, path FROM familias "
                "WHERE parent_id = :pid "
                "LIMIT 1"
            ),
            {"pid": str(data["parentId"])},
        )
        parent = res_parent.mappings().first()
        if parent and parent.get("path"):
            path = f"{parent['path']}/{data['codigoCrc']}"
        else:
            path = data["codigoCrc"]
    else:
        path = data["codigoCrc"]

    # ── validadeFim + proximaRenovacaoEm (validadeFim - 60 dias). ─────────────
    validade_fim_dt: datetime | None = (
        _parse_validade_para_dt(data["validadeFim"])
        if data.get("validadeFim")
        else None
    )
    proxima_renovacao_dt: datetime | None = (
        validade_fim_dt - timedelta(days=60) if validade_fim_dt else None
    )

    # ── INSERT na familias ... RETURNING * (camelCase). ───────────────────────
    insert_params = {
        "codigo_crc": data["codigoCrc"],
        "codigo_normalizado": codigo_normalizado,
        "nome": data["nome"],
        "descricao": data.get("descricao") or None,
        "nivel": data["nivel"],
        "parent_id": str(data["parentId"]) if data.get("parentId") else None,
        "path": path,
        "cadastro_corporativo": data["cadastroCorporativo"],
        "segmento_petrobras": data.get("segmentoPetrobras"),
        "status": data["status"],
        "status_fluxo_crc": data.get("statusFluxoCrc"),
        "validade_fim": validade_fim_dt,
        "proxima_renovacao_em": proxima_renovacao_dt,
        "criterios": _json.dumps(data["criterios"])
        if data.get("criterios") is not None
        else None,
        "tags": _json.dumps(data["tags"]) if data.get("tags") is not None else None,
        "escopos_cobertos": _json.dumps(data["escoposCobertos"])
        if data.get("escoposCobertos") is not None
        else None,
        # BUG CORRIGIDO: Next usa ``data.observacoes ?? null`` — string vazia ''
        # PERMANECE '' (não vira NULL). ``or None`` transformava '' em NULL.
        # Preserva a '' espelhando o ?? do Next (mas só quando a chave existe em
        # ``data``; ausente → None, igual ao ?? sobre undefined).
        "observacoes": data["observacoes"] if "observacoes" in data else None,
        "criado_por": user.id,
        "atualizado_por": user.id,
    }

    sql_insert = text(
        f"""
        INSERT INTO familias (
            codigo_crc, codigo_normalizado, nome, descricao, nivel, parent_id,
            path, cadastro_corporativo, segmento_petrobras, status,
            status_fluxo_crc, validade_fim, proxima_renovacao_em, criterios,
            tags, escopos_cobertos, observacoes, criado_por, atualizado_por
        ) VALUES (
            :codigo_crc, :codigo_normalizado, :nome, :descricao, :nivel,
            :parent_id, :path, :cadastro_corporativo, :segmento_petrobras,
            :status, :status_fluxo_crc, :validade_fim, :proxima_renovacao_em,
            CAST(:criterios AS jsonb), CAST(:tags AS jsonb),
            CAST(:escopos_cobertos AS jsonb), :observacoes, :criado_por,
            :atualizado_por
        )
        RETURNING
            {_FAMILIA_SELECT}
        """
    )

    res_nova = await db.execute(sql_insert, insert_params)
    nova = res_nova.mappings().first()

    # ── INSERT no audit_log (espelha db.insert(auditLog).values do Next). ─────
    await registrar_audit(
        db,
        user_id=user.id,
        acao="CRIAR_FAMILIA",
        entidade="familia",
        entidade_id=str(nova["id"]),
        detalhes={
            "codigoCrc": nova["codigoCrc"],
            "nome": nova["nome"],
            "status": nova["status"],
        },
    )

    await db.commit()

    return JSONResponse(status_code=201, content=_serializar_row(nova))


# ── Validação do corpo (espelha CriarFamiliaSchema) ───────────────────────────


def _validar_criar_familia(body: Any) -> dict[str, Any]:
    """Valida ``body`` contra CriarFamiliaSchema. Retorna {data} ou {__erros__}.

    Réplica fiel das regras Zod (campos obrigatórios, faixas, enums, defaults).
    Em caso de erro devolve ``{"__erros__": {campo: mensagem}}`` no formato de
    ``formatZodErrors`` (path com pontos → mensagem).
    """
    erros: dict[str, str] = {}

    if not isinstance(body, dict):
        # z.object() sobre não-objeto → Zod v4: "Invalid input: expected object,
        # received <tipo JS>" sob path raiz "".
        return {"__erros__": {"": _zod_expected("object", body)}}

    out: dict[str, Any] = {}

    # codigoCrc* : str 2..50.
    codigo = body.get("codigoCrc")
    if not isinstance(codigo, str):
        erros["codigoCrc"] = (
            _zod_expected_undefined("string")
            if codigo is None
            else _zod_expected("string", codigo)
        )
    elif len(codigo) < 2:
        erros["codigoCrc"] = "Código CRC deve ter pelo menos 2 caracteres"
    elif len(codigo) > 50:
        erros["codigoCrc"] = "Código CRC muito longo"
    else:
        out["codigoCrc"] = codigo

    # nome* : str 2..200.
    nome = body.get("nome")
    if not isinstance(nome, str):
        erros["nome"] = (
            _zod_expected_undefined("string")
            if nome is None
            else _zod_expected("string", nome)
        )
    elif len(nome) < 2:
        erros["nome"] = "Nome deve ter pelo menos 2 caracteres"
    elif len(nome) > 200:
        erros["nome"] = "Nome muito longo"
    else:
        out["nome"] = nome

    # descricao : str ≤2000 optional.
    if "descricao" in body and body["descricao"] is not None:
        descricao = body["descricao"]
        if not isinstance(descricao, str):
            erros["descricao"] = _zod_expected("string", descricao)
        elif len(descricao) > 2000:
            erros["descricao"] = "Descrição muito longa"
        else:
            out["descricao"] = descricao

    # nivel : enum default "FAMILIA".
    nivel = body.get("nivel")
    if nivel is None:
        out["nivel"] = "FAMILIA"
    elif nivel not in _NIVEL:
        erros["nivel"] = _zod_enum(_NIVEL_ORDER)
    else:
        out["nivel"] = nivel

    # parentId : uuid optional nullable.
    if "parentId" in body and body["parentId"] is not None:
        pid = body["parentId"]
        if not isinstance(pid, str):
            erros["parentId"] = "ID inválido"
        else:
            try:
                import uuid as _uuid

                _uuid.UUID(pid)
                out["parentId"] = pid
            except ValueError:
                erros["parentId"] = "ID inválido"

    # cadastroCorporativo : bool default true.
    cc = body.get("cadastroCorporativo")
    if cc is None:
        out["cadastroCorporativo"] = True
    elif not isinstance(cc, bool):
        erros["cadastroCorporativo"] = _zod_expected("boolean", cc)
    else:
        out["cadastroCorporativo"] = cc

    # segmentoPetrobras : enum optional nullable.
    if "segmentoPetrobras" in body and body["segmentoPetrobras"] is not None:
        seg = body["segmentoPetrobras"]
        if seg not in _SEGMENTO:
            erros["segmentoPetrobras"] = _zod_enum(_SEGMENTO_ORDER)
        else:
            out["segmentoPetrobras"] = seg

    # status : enum default "ATIVA".
    st = body.get("status")
    if st is None:
        out["status"] = "ATIVA"
    elif st not in _STATUS_FAMILIA:
        erros["status"] = _zod_enum(_STATUS_FAMILIA_ORDER)
    else:
        out["status"] = st

    # statusFluxoCrc : enum optional nullable.
    if "statusFluxoCrc" in body and body["statusFluxoCrc"] is not None:
        sf = body["statusFluxoCrc"]
        if sf not in _STATUS_FLUXO:
            erros["statusFluxoCrc"] = _zod_enum(_STATUS_FLUXO_ORDER)
        else:
            out["statusFluxoCrc"] = sf

    # validadeFim : ISO datetime optional nullable.
    if "validadeFim" in body and body["validadeFim"] is not None:
        vf = body["validadeFim"]
        if not _is_iso_datetime(vf):
            erros["validadeFim"] = "Data e hora inválidas. Use o formato ISO 8601."
        else:
            out["validadeFim"] = vf

    # criterios : z.record(criterioCrcSchema, {...}) optional.
    #
    # BUG CORRIGIDO (paridade Zod v4): em Zod v4 o ``z.record(enumKey, val)`` é
    # EXAUSTIVO — exige TODAS as 7 chaves do enum presentes. Um criterios parcial
    # (ex.: {JURIDICO:{...}}) é REJEITADO com 422, gerando para cada chave AUSENTE
    # 'Invalid input: expected object, received undefined'. Chaves não-reconhecidas
    # geram 'Unrecognized key: "X"' (ou 'Unrecognized keys: "X", "Y"') no path
    # ``criterios``. Verificado executando o schema real.
    if "criterios" in body and body["criterios"] is not None:
        crit = body["criterios"]
        if not isinstance(crit, dict):
            # Record sobre não-objeto → "expected record, received <tipo JS>".
            erros["criterios"] = _zod_expected("record", crit)
        else:
            crit_ok = True
            # 1. Valida o VALOR de cada chave RECONHECIDA presente (ordem de inserção).
            for chave, val in crit.items():
                if chave not in _CRITERIO_CRC:
                    continue  # não-reconhecida: tratada como "Unrecognized" abaixo.
                if not isinstance(val, dict):
                    erros[f"criterios.{chave}"] = _zod_expected("object", val)
                    crit_ok = False
                    continue
                cstatus = val.get("status")
                if cstatus not in _STATUS_CRITERIO:
                    erros[f"criterios.{chave}.status"] = _zod_enum(
                        _STATUS_CRITERIO_ORDER
                    )
                    crit_ok = False
                # validadeFim: z.string().datetime().nullable() (obrigatório, aceita null).
                if "validadeFim" not in val:
                    erros[f"criterios.{chave}.validadeFim"] = _zod_expected_undefined(
                        "string"
                    )
                    crit_ok = False
                else:
                    cvf = val["validadeFim"]
                    if cvf is None:
                        pass  # null permitido (.nullable()).
                    elif not isinstance(cvf, str):
                        erros[f"criterios.{chave}.validadeFim"] = _zod_expected(
                            "string", cvf
                        )
                        crit_ok = False
                    elif not _is_iso_datetime(cvf):
                        # .datetime() interno (sem custom msg) → "Invalid ISO datetime".
                        erros[f"criterios.{chave}.validadeFim"] = "Invalid ISO datetime"
                        crit_ok = False
                # observacao: z.string().max(500).optional() (NÃO nullable).
                if "observacao" in val and val["observacao"] is not None:
                    obs = val["observacao"]
                    if not isinstance(obs, str):
                        erros[f"criterios.{chave}.observacao"] = _zod_expected(
                            "string", obs
                        )
                        crit_ok = False
                    elif len(obs) > 500:
                        erros[f"criterios.{chave}.observacao"] = _zod_str_max(500)
                        crit_ok = False
            # 2. Chaves do enum AUSENTES (exaustividade do record Zod v4).
            for chave in _CRITERIO_CRC:
                if chave not in crit:
                    erros[f"criterios.{chave}"] = _zod_expected_undefined("object")
                    crit_ok = False
            # 3. Chaves não-reconhecidas → "Unrecognized key(s)" no path criterios.
            nao_reconhecidas = [k for k in crit if k not in _CRITERIO_CRC]
            if nao_reconhecidas:
                aspas = ", ".join(f'"{k}"' for k in nao_reconhecidas)
                if len(nao_reconhecidas) == 1:
                    erros["criterios"] = f"Unrecognized key: {aspas}"
                else:
                    erros["criterios"] = f"Unrecognized keys: {aspas}"
                crit_ok = False
            if crit_ok:
                out["criterios"] = crit

    # tags : z.array(z.string().max(50)).max(50) optional.
    if "tags" in body and body["tags"] is not None:
        tags = body["tags"]
        if not isinstance(tags, list):
            erros["tags"] = _zod_expected("array", tags)
        elif len(tags) > 50:
            erros["tags"] = _zod_array_max(50)
        else:
            ok = True
            for i, tg in enumerate(tags):
                if not isinstance(tg, str):
                    erros[f"tags.{i}"] = _zod_expected("string", tg)
                    ok = False
                elif len(tg) > 50:
                    erros[f"tags.{i}"] = _zod_str_max(50)
                    ok = False
            if ok:
                out["tags"] = tags

    # escoposCobertos : z.array(z.string().max(200)).max(100) optional.
    if "escoposCobertos" in body and body["escoposCobertos"] is not None:
        esc = body["escoposCobertos"]
        if not isinstance(esc, list):
            erros["escoposCobertos"] = _zod_expected("array", esc)
        elif len(esc) > 100:
            erros["escoposCobertos"] = _zod_array_max(100)
        else:
            ok = True
            for i, ev in enumerate(esc):
                if not isinstance(ev, str):
                    erros[f"escoposCobertos.{i}"] = _zod_expected("string", ev)
                    ok = False
                elif len(ev) > 200:
                    erros[f"escoposCobertos.{i}"] = _zod_str_max(200)
                    ok = False
            if ok:
                out["escoposCobertos"] = esc

    # observacoes : z.string().max(2000) optional.
    if "observacoes" in body and body["observacoes"] is not None:
        observacoes = body["observacoes"]
        if not isinstance(observacoes, str):
            erros["observacoes"] = _zod_expected("string", observacoes)
        elif len(observacoes) > 2000:
            erros["observacoes"] = _zod_str_max(2000)
        else:
            out["observacoes"] = observacoes

    if erros:
        return {"__erros__": erros}
    return {"data": out}
