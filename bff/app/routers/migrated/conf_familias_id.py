"""Rota migrada (strangler-fig): /api/conformidade/familias/{id}.

Espelho 1:1 de ``src/app/api/conformidade/familias/[id]/route.ts`` (handlers
GET / PATCH / DELETE) — paridade de comportamento e de resposta com o BFF
FastAPI (``JSON.parse(bff) === JSON.parse(next)``).

Métodos:
    GET    — Detalhe da família (com aliases, anexos, documentos vinculados).
    PATCH  — Edita a família (Conformidade: ADMIN/LIDER/SGI). Optimistic NÃO há
             coluna ``versao``; o lock é por soft-delete (``deletado_em IS NULL``)
             no WHERE do UPDATE.
    DELETE — Soft delete (somente ADMIN), grava ``deletado_em``/``atualizado_em``.

Guards do Next (replicados na MESMA ordem):
    GET    — ``requireVisualizar()`` → ``requireAuth()`` (401 se sem sessão) +
             ``podeVisualizar(role)`` (403). role ∈ {ADMIN, LIDER, ORCAMENTISTA,
             TECNICO, SGI, VISUALIZADOR}. Equivalente: ``require_visualizar``.
    PATCH  — ``requireAuth()`` (401) PRIMEIRO; depois ``podeGerenciarFamilias``
             (= ``isConformidade`` = ADMIN/LIDER/SGI) → 403 ``{error:"Permissão
             negada"}``. Equivalente lógico: ``require_conformidade``.
    DELETE — ``requireAuth()`` (401) PRIMEIRO; depois ``podeExcluirFamilia`` (=
             ``isAdmin`` = ADMIN) → 403 ``{error:"Somente administradores podem
             excluir famílias"}``. Equivalente lógico: ``require_admin``.

PARIDADE DE SHAPE DE ERRO (importante — replica o que o Next devolve, NÃO o
default do FastAPI):
    O Next NÃO usa o ``{detail}`` do FastAPI; ele usa ``handleApiError`` (401:
    ``{error:"Não autenticado", code:"UNAUTHENTICATED"}``) e respostas explícitas
    (``{error: "..."}`` / ``{error:"Dados inválidos", detalhes:{...}}``). Por isso
    PATCH/DELETE fazem auth MANUAL (``get_current_user`` + checagem de papel) e
    devolvem ``JSONResponse`` com EXATAMENTE o shape do Next, incluindo as
    mensagens de 403 distintas por método.

Validação do body (PATCH) — espelha ``EditarFamiliaSchema`` (Zod):
    - JSON inválido → 400 ``{error:"JSON inválido"}``.
    - Falha de schema → 422 ``{error:"Dados inválidos", detalhes:{<path>:<msg>}}``
      (``formatZodErrors``: path com ``.`` e a mensagem da 1ª issue por path —
      como o ``reduce`` do Next sobrescreve, fica a ÚLTIMA issue de cada path; o
      Zod emite uma issue por path neste schema, então é determinístico).
    - Todos os campos são opcionais; nenhum obrigatório.

Serialização (paridade JSON com o Drizzle/pg):
    - timestamp (com tz) → ISO 8601 via ``isoformat()``.
    - uuid → ``str()`` (Drizzle/pg devolve uuid como string).
    - jsonb (criterios/tags/escopos_cobertos) → dict/list nativo (asyncpg parseia).
    - text/bool/int → cru.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import (
    CurrentUser,
    get_current_user,
    is_admin,
    is_conformidade,
    require_visualizar,
)
from app.routers.migrated._restrito import (
    is_conformidade as _is_conformidade_s12,
)
from app.db.session import get_db
from app.services.audit import registrar_audit

router = APIRouter()

# ── Enums espelhando os schemas Zod (validations.ts) ──────────────────────────

_NIVEL_FAMILIA = {"FAMILIA", "SUBFAMILIA", "GRUPO", "ITEM"}
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
_SEGMENTO_PETROBRAS = {"YELLOW_PAGES", "OPERACIONAL", "CRITICA", "ESTRATEGICA"}
_STATUS_FLUXO_CRC = {"D", "Q", "A", "X"}

# Ordem de DECLARAÇÃO dos enums (Zod v4 reporta opções e itera nessa ordem; não
# usamos ``set`` para as mensagens/iteração pois ``sorted()`` divergiria do Zod).
_NIVEL_FAMILIA_ORDER = ("FAMILIA", "SUBFAMILIA", "GRUPO", "ITEM")
_STATUS_FAMILIA_ORDER = ("ATIVA", "EM_RENOVACAO", "SUSPENSA", "VENCIDA", "REJEITADA")
_STATUS_CRITERIO_ORDER = (
    "APROVADO",
    "QUALIFICADO",
    "EM_AVALIACAO",
    "REJEITADO",
    "CANCELADO",
)
_CRITERIO_CRC_ORDER = (
    "JURIDICO",
    "ECONOMICO",
    "TECNICO",
    "TECNICO_SMS",
    "LFO",
    "REVENDEDOR",
    "INTEGRIDADE",
)
_SEGMENTO_PETROBRAS_ORDER = ("YELLOW_PAGES", "OPERACIONAL", "CRITICA", "ESTRATEGICA")
_STATUS_FLUXO_CRC_ORDER = ("D", "Q", "A", "X")

# Sentinela de "chave ausente" no body — o JS distingue ``undefined`` (chave não
# enviada) de ``null``. Usamos esta sentinela p/ reproduzir "received undefined".
_MISSING = object()

# Regex de datetime EXTRAÍDA do Zod v4 (z.string().datetime() default): exige
# sufixo 'Z', rejeita offset numérico (+hh:mm), datetime sem timezone, date-only
# e separador por espaço. Valida ranges de data (incl. 29/02 bissexto) e hora.
_ZOD_DATETIME_RE = re.compile(
    r"^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|"
    r"[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|"
    r"(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))"
    r"T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z))$"
)


# ── Helpers de serialização ───────────────────────────────────────────────────


def _jsonable(value: Any) -> Any:
    """Normaliza um valor de coluna para JSON (paridade Next/Drizzle)."""
    if value is None:
        return None
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


def _row_familia(row) -> dict:
    """Projeta uma Row da tabela ``familias`` no objeto camelCase do Drizzle.

    Espelha ``db.select().from(familias)`` (TODAS as colunas), com os mesmos
    aliases que o Drizzle expõe (a prop do schema). ``...familia`` no Next é
    exatamente este objeto.
    """
    m = row._mapping
    return {
        "id": _jsonable(m["id"]),
        "codigoCrc": m["codigo_crc"],
        "codigoNormalizado": m["codigo_normalizado"],
        "nome": m["nome"],
        "descricao": m["descricao"],
        "nivel": m["nivel"],
        "parentId": _jsonable(m["parent_id"]),
        "path": m["path"],
        "cadastroCorporativo": m["cadastro_corporativo"],
        "segmentoPetrobras": m["segmento_petrobras"],
        "status": m["status"],
        "statusFluxoCrc": m["status_fluxo_crc"],
        "validadeFim": _jsonable(m["validade_fim"]),
        "proximaRenovacaoEm": _jsonable(m["proxima_renovacao_em"]),
        "criterios": m["criterios"],
        "tags": m["tags"],
        "escoposCobertos": m["escopos_cobertos"],
        "observacoes": m["observacoes"],
        "deletadoEm": _jsonable(m["deletado_em"]),
        "criadoPor": _jsonable(m["criado_por"]),
        "atualizadoPor": _jsonable(m["atualizado_por"]),
        "criadoEm": _jsonable(m["criado_em"]),
        "atualizadoEm": _jsonable(m["atualizado_em"]),
    }


_FAMILIA_COLS = """
    id, codigo_crc, codigo_normalizado, nome, descricao, nivel, parent_id, path,
    cadastro_corporativo, segmento_petrobras, status, status_fluxo_crc,
    validade_fim, proxima_renovacao_em, criterios, tags, escopos_cobertos,
    observacoes, deletado_em, criado_por, atualizado_por, criado_em, atualizado_em
"""


def normalizar_codigo_crc(codigo: str) -> str:
    """Espelha ``normalizarCodigoCrc`` (validations.ts): NFD, remove diacríticos,
    mantém só alfanumérico, maiúsculas.

    O Next faz ``.normalize("NFD").replace(/diacríticos/, "").replace(/[^a-zA-Z0-9]/, "").toUpperCase()``.
    """
    nfd = unicodedata.normalize("NFD", codigo)
    sem_diacritico = "".join(ch for ch in nfd if unicodedata.category(ch) != "Mn")
    so_alfanum = "".join(ch for ch in sem_diacritico if ch.isascii() and ch.isalnum())
    return so_alfanum.upper()


# ── Validação do body do PATCH (espelha EditarFamiliaSchema do Zod) ───────────


class _ZodError(Exception):
    """Acumula erros de validação no formato ``{<path>: <mensagem>}`` (formatZodErrors)."""

    def __init__(self) -> None:
        self.errors: dict[str, str] = {}

    def add(self, path: str, msg: str) -> None:
        # formatZodErrors sobrescreve por path (reduce); replicamos o ÚLTIMO valor.
        self.errors[path] = msg

    def __bool__(self) -> bool:
        return bool(self.errors)


def _validar_str(
    val: Any, path: str, err: _ZodError, *, min_len=None, max_len=None
) -> bool:
    """Valida string com min/max (espelha z.string().min().max(), msgs Zod v4)."""
    if not isinstance(val, str):
        err.add(path, "Invalid input: expected string, received " + _zod_typeof(val))
        return False
    if min_len is not None and len(val) < min_len:
        err.add(path, f"Too small: expected string to have >={min_len} characters")
        return False
    if max_len is not None and len(val) > max_len:
        err.add(path, f"Too big: expected string to have <={max_len} characters")
        return False
    return True


def _zod_typeof(val: Any) -> str:
    """Aproxima o ``received`` do Zod v4 para as mensagens de tipo."""
    if val is _MISSING:
        return "undefined"
    if val is None:
        return "null"
    if isinstance(val, bool):
        return "boolean"
    if isinstance(val, (int, float)):
        return "number"
    if isinstance(val, str):
        return "string"
    if isinstance(val, list):
        return "array"
    if isinstance(val, dict):
        return "object"
    return "unknown"


def _is_iso_datetime(val: Any) -> bool:
    """Espelha z.string().datetime() default do Zod v4: SÓ aceita RFC3339 com
    sufixo 'Z'. Rejeita offset numérico (+hh:mm), datetime sem timezone,
    date-only e separador por espaço — ao contrário de ``datetime.fromisoformat``
    (que é bem mais permissivo)."""
    if not isinstance(val, str):
        return False
    return _ZOD_DATETIME_RE.match(val) is not None


def _validar_editar_familia(body: Any) -> tuple[dict | None, dict | None]:
    """Valida o body do PATCH espelhando ``EditarFamiliaSchema``.

    Retorna ``(data, None)`` em sucesso ou ``(None, detalhes)`` em falha, onde
    ``detalhes`` é o ``Record<string,string>`` de ``formatZodErrors``.

    Todos os campos são opcionais. ``.nullable()`` permite ``None`` explícito.
    A semântica preserva ``data[campo] is not undefined`` do Next: aqui usamos a
    PRESENÇA da chave no dict (``in body``) como equivalente de "definido".
    """
    err = _ZodError()
    if not isinstance(body, dict):
        # z.object() sobre não-objeto: erro de nível raiz (path vazio "").
        err.add("", "Invalid input: expected object, received " + _zod_typeof(body))
        return None, err.errors

    data: dict[str, Any] = {}

    def presente(k: str) -> bool:
        return k in body

    # codigoCrc: string min2 max50 optional
    if presente("codigoCrc"):
        v = body["codigoCrc"]
        if _validar_str(v, "codigoCrc", err, min_len=2, max_len=50):
            data["codigoCrc"] = v

    # nome: string min2 max200 optional
    if presente("nome"):
        v = body["nome"]
        if _validar_str(v, "nome", err, min_len=2, max_len=200):
            data["nome"] = v

    # descricao: string max2000 optional nullable
    if presente("descricao"):
        v = body["descricao"]
        if v is None:
            data["descricao"] = None
        elif _validar_str(v, "descricao", err, max_len=2000):
            data["descricao"] = v

    # nivel: enum optional
    if presente("nivel"):
        v = body["nivel"]
        if v in _NIVEL_FAMILIA:
            data["nivel"] = v
        else:
            err.add("nivel", _enum_msg(_NIVEL_FAMILIA_ORDER, v))

    # parentId: uuid optional nullable
    if presente("parentId"):
        v = body["parentId"]
        if v is None:
            data["parentId"] = None
        elif _is_uuid(v):
            data["parentId"] = v
        else:
            err.add("parentId", "ID inválido")

    # cadastroCorporativo: boolean optional
    if presente("cadastroCorporativo"):
        v = body["cadastroCorporativo"]
        if isinstance(v, bool):
            data["cadastroCorporativo"] = v
        else:
            err.add(
                "cadastroCorporativo",
                "Invalid input: expected boolean, received " + _zod_typeof(v),
            )

    # segmentoPetrobras: enum optional nullable
    if presente("segmentoPetrobras"):
        v = body["segmentoPetrobras"]
        if v is None:
            data["segmentoPetrobras"] = None
        elif v in _SEGMENTO_PETROBRAS:
            data["segmentoPetrobras"] = v
        else:
            err.add("segmentoPetrobras", _enum_msg(_SEGMENTO_PETROBRAS_ORDER, v))

    # status: enum optional
    if presente("status"):
        v = body["status"]
        if v in _STATUS_FAMILIA:
            data["status"] = v
        else:
            err.add("status", _enum_msg(_STATUS_FAMILIA_ORDER, v))

    # statusFluxoCrc: enum optional nullable
    if presente("statusFluxoCrc"):
        v = body["statusFluxoCrc"]
        if v is None:
            data["statusFluxoCrc"] = None
        elif v in _STATUS_FLUXO_CRC:
            data["statusFluxoCrc"] = v
        else:
            err.add("statusFluxoCrc", _enum_msg(_STATUS_FLUXO_CRC_ORDER, v))

    # validadeFim: datetime optional nullable
    if presente("validadeFim"):
        v = body["validadeFim"]
        if v is None:
            data["validadeFim"] = None
        elif not isinstance(v, str):
            # Zod v4: erro de TIPO antes do check de formato.
            err.add(
                "validadeFim",
                "Invalid input: expected string, received " + _zod_typeof(v),
            )
        elif _is_iso_datetime(v):
            data["validadeFim"] = v
        else:
            # Mensagem custom do schema (dateTimeSchema): invalid_format.
            err.add(
                "validadeFim",
                "Data e hora inválidas. Use o formato ISO 8601.",
            )

    # criterios: record(criterioCrc -> {status, validadeFim, observacao?}) optional
    if presente("criterios"):
        v = body["criterios"]
        if _validar_criterios(v, err):
            data["criterios"] = v

    # tags: array(string max50) max50 optional
    if presente("tags"):
        v = body["tags"]
        if _validar_array_str(v, "tags", err, item_max=50, arr_max=50):
            data["tags"] = v

    # escoposCobertos: array(string max200) max100 optional
    if presente("escoposCobertos"):
        v = body["escoposCobertos"]
        if _validar_array_str(v, "escoposCobertos", err, item_max=200, arr_max=100):
            data["escoposCobertos"] = v

    # observacoes: string max2000 optional nullable
    if presente("observacoes"):
        v = body["observacoes"]
        if v is None:
            data["observacoes"] = None
        elif _validar_str(v, "observacoes", err, max_len=2000):
            data["observacoes"] = v

    if err:
        return None, err.errors
    return data, None


def _enum_msg(valores, recebido: Any) -> str:
    """Mensagem de enum inválido (Zod v4 ``invalid_value``).

    Formato: ``Invalid option: expected one of "A"|"B"|"C"`` — opções entre aspas
    duplas, juntadas por ``|`` SEM espaços, na ORDEM de declaração do enum (NÃO
    ``sorted()``) e SEM sufixo ``received``. ``valores`` deve ser uma sequência
    ordenada (tupla ``*_ORDER``), não um ``set``.
    """
    opcoes = "|".join(f'"{v}"' for v in valores)
    return f"Invalid option: expected one of {opcoes}"


def _is_uuid(val: Any) -> bool:
    if not isinstance(val, str):
        return False
    try:
        UUID(val)
        return True
    except (ValueError, AttributeError, TypeError):
        return False


def _validar_array_str(
    val: Any, path: str, err: _ZodError, *, item_max: int, arr_max: int
) -> bool:
    if not isinstance(val, list):
        err.add(path, "Invalid input: expected array, received " + _zod_typeof(val))
        return False
    if len(val) > arr_max:
        err.add(path, f"Too big: expected array to have <={arr_max} items")
        return False
    for i, item in enumerate(val):
        if not isinstance(item, str):
            err.add(
                f"{path}.{i}",
                "Invalid input: expected string, received " + _zod_typeof(item),
            )
            return False
        if len(item) > item_max:
            err.add(
                f"{path}.{i}",
                f"Too big: expected string to have <={item_max} characters",
            )
            return False
    return True


def _validar_criterios(val: Any, err: _ZodError) -> bool:
    """Valida ``criterios`` espelhando ``z.record(criterioCrcSchema, value)`` (Zod v4).

    No Zod v4, ``z.record(enumKey, value)`` é EXAUSTIVO sobre o keyEnum: TODAS as 7
    chaves de ``criterioCrcSchema`` são tratadas como OBRIGATÓRIAS. A emissão de
    issues segue a ORDEM de DECLARAÇÃO do enum:

      1) Para cada membro do enum (em ordem): se presente → valida o objeto-valor
         (emitindo ``criterios.<MEMBRO>.<campo>`` por sub-issue, ou
         ``criterios.<MEMBRO>`` se o valor não for objeto); se AUSENTE →
         ``criterios.<MEMBRO>`` → "Invalid input: expected object, received undefined".
      2) Depois, chaves DESCONHECIDAS (não pertencentes ao enum) viram UMA issue
         ``unrecognized_keys`` agregada no path ``criterios``, na ordem de inserção
         do body: 1 chave → ``Unrecognized key: "FOO"``; 2+ →
         ``Unrecognized keys: "FOO", "BAR"``.

    ``formatZodErrors`` (reduce) sobrescreve por path, então cada path acima fica
    com sua mensagem e a ordem de inserção no dict casa byte-a-byte com o Next.
    """
    if not isinstance(val, dict):
        err.add("criterios", "Invalid input: expected object, received " + _zod_typeof(val))
        return False
    ok = True

    # (1) Membros do enum em ordem de declaração (record exaustivo do Zod v4).
    for membro in _CRITERIO_CRC_ORDER:
        if membro not in val:
            err.add(
                f"criterios.{membro}",
                "Invalid input: expected object, received undefined",
            )
            ok = False
            continue
        item = val[membro]
        if not isinstance(item, dict):
            err.add(
                f"criterios.{membro}",
                "Invalid input: expected object, received " + _zod_typeof(item),
            )
            ok = False
            continue
        # Sub-campos em ordem de declaração: status, validadeFim, observacao.
        st = item.get("status")  # ausente/None → enum invalid_value no Zod v4.
        if st not in _STATUS_CRITERIO:
            err.add(
                f"criterios.{membro}.status",
                _enum_msg(_STATUS_CRITERIO_ORDER, st),
            )
            ok = False
        if "validadeFim" not in item:
            err.add(
                f"criterios.{membro}.validadeFim",
                "Invalid input: expected string, received undefined",
            )
            ok = False
        else:
            vf = item["validadeFim"]
            if vf is None:
                pass  # .nullable() permite None.
            elif not isinstance(vf, str):
                err.add(
                    f"criterios.{membro}.validadeFim",
                    "Invalid input: expected string, received " + _zod_typeof(vf),
                )
                ok = False
            elif not _is_iso_datetime(vf):
                # z.string().datetime() (sem message custom) → "Invalid ISO datetime".
                err.add(f"criterios.{membro}.validadeFim", "Invalid ISO datetime")
                ok = False
        if "observacao" in item:
            obs = item["observacao"]
            if not isinstance(obs, str):
                # .optional() (NÃO nullable): None é type error no Zod v4.
                err.add(
                    f"criterios.{membro}.observacao",
                    "Invalid input: expected string, received " + _zod_typeof(obs),
                )
                ok = False
            elif len(obs) > 500:
                err.add(
                    f"criterios.{membro}.observacao",
                    "Too big: expected string to have <=500 characters",
                )
                ok = False

    # (2) Chaves desconhecidas → unrecognized_keys agregada (ordem de inserção).
    desconhecidas = [k for k in val if k not in _CRITERIO_CRC]
    if desconhecidas:
        chaves = ", ".join(f'"{k}"' for k in desconhecidas)
        rotulo = "Unrecognized key" if len(desconhecidas) == 1 else "Unrecognized keys"
        err.add("criterios", f"{rotulo}: {chaves}")
        ok = False

    return ok


# ── 401 com o shape do Next (handleApiError de requireAuth) ───────────────────


async def _usuario_ou_401(request: Request) -> tuple[CurrentUser | None, JSONResponse | None]:
    """Replica ``requireAuth()`` do Next: 401 ``{error,code}`` quando sem sessão.

    ``get_current_user`` levanta ``HTTPException(401)``; capturamos e devolvemos
    o MESMO shape do ``handleApiError(ApiError(401,...))`` do Next em vez do
    ``{detail}`` default do FastAPI.
    """
    from fastapi import HTTPException

    try:
        user = await get_current_user(request)
        return user, None
    except HTTPException as exc:
        if exc.status_code == 401:
            return None, JSONResponse(
                status_code=401,
                content={"error": "Não autenticado", "code": "UNAUTHENTICATED"},
            )
        # Demais (ex.: 500 sem AUTH_SECRET) propagam o detail do FastAPI.
        return None, JSONResponse(
            status_code=exc.status_code, content={"error": exc.detail}
        )


def _not_found() -> JSONResponse:
    """Espelha ``notFound()`` do Next: 404 ``{error:"Família não encontrada"}``."""
    return JSONResponse(
        status_code=404, content={"error": "Família não encontrada"}
    )


# ── GET ────────────────────────────────────────────────────────────────────────


@router.get("/api/conformidade/familias/{id}")
async def get_familia(
    id: str,
    request: Request,
    user: CurrentUser = Depends(require_visualizar),
    db=Depends(get_db),
) -> JSONResponse:
    """GET /api/conformidade/familias/{id} — detalhe com aliases/anexos/documentos.

    Guard ``require_visualizar`` (dependency) espelha ``requireVisualizar()``
    (401 sem sessão / 403 sem papel — antes do corpo, igual ao Next, em que o
    guard é a 1ª coisa do handler).
    """
    # getFamiliaById: SELECT * WHERE id = :id AND deletado_em IS NULL LIMIT 1.
    res = await db.execute(
        text(
            f"SELECT {_FAMILIA_COLS} FROM familias "
            "WHERE id = :id AND deletado_em IS NULL LIMIT 1"
        ),
        {"id": id},
    )
    fam_row = res.first()
    if fam_row is None:
        return _not_found()

    familia = _row_familia(fam_row)

    # getAliasesByFamilia: SELECT * WHERE familia_id ORDER BY criado_em DESC.
    res_aliases = await db.execute(
        text(
            """
            SELECT
                id, familia_id, codigo_alternativo,
                codigo_alternativo_normalizado, observacao, criado_em
            FROM familias_aliases
            WHERE familia_id = :id
            ORDER BY criado_em DESC
            """
        ),
        {"id": id},
    )
    aliases = [
        {
            "id": _jsonable(r["id"]),
            "familiaId": _jsonable(r["familia_id"]),
            "codigoAlternativo": r["codigo_alternativo"],
            "codigoAlternativoNormalizado": r["codigo_alternativo_normalizado"],
            "observacao": r["observacao"],
            "criadoEm": _jsonable(r["criado_em"]),
        }
        for r in res_aliases.mappings().all()
    ]

    # getAnexosByFamilia: colunas explícitas + leftJoin users (uploadadoPorNome),
    # ORDER BY anexos.criado_em DESC.
    res_anexos = await db.execute(
        text(
            """
            SELECT
                fa.id                  AS id,
                fa.familia_id          AS familia_id,
                fa.tipo                AS tipo,
                fa.nome_arquivo        AS nome_arquivo,
                fa.blob_url            AS blob_url,
                fa.blob_key            AS blob_key,
                fa.tamanho_bytes       AS tamanho_bytes,
                fa.content_type        AS content_type,
                fa.validade_fim        AS validade_fim,
                fa.uploadado_por       AS uploadado_por,
                u.nome                 AS uploadado_por_nome,
                fa.criado_em           AS criado_em
            FROM familias_anexos fa
            LEFT JOIN users u ON fa.uploadado_por = u.id
            WHERE fa.familia_id = :id
            ORDER BY fa.criado_em DESC
            """
        ),
        {"id": id},
    )
    anexos = [
        {
            "id": _jsonable(r["id"]),
            "familiaId": _jsonable(r["familia_id"]),
            "tipo": r["tipo"],
            "nomeArquivo": r["nome_arquivo"],
            "blobUrl": r["blob_url"],
            "blobKey": r["blob_key"],
            "tamanhoBytes": r["tamanho_bytes"],
            "contentType": r["content_type"],
            "validadeFim": _jsonable(r["validade_fim"]),
            "uploadadoPor": _jsonable(r["uploadado_por"]),
            "uploadadoPorNome": r["uploadado_por_nome"],
            "criadoEm": _jsonable(r["criado_em"]),
        }
        for r in res_anexos.mappings().all()
    ]

    # getDocumentosByFamilia: innerJoin documentos_habilitacao, ORDER BY titulo ASC.
    # 0034/S12 (02-APIS §16-B.2): predicado restrito na DIREÇÃO INVERSA — a
    # lista de provas da família não pode exibir o contrato restrito a papéis
    # fora de Conformidade (a linha é FILTRADA; a contagem implícita acompanha).
    res_docs = await db.execute(
        text(
            """
            SELECT
                df.id            AS vinculo_id,
                dh.id            AS documento_id,
                dh.titulo        AS titulo,
                dh.categoria     AS categoria,
                dh.subcategoria  AS subcategoria,
                dh.status        AS status,
                dh.validade_fim  AS validade_fim,
                df.observacao    AS observacao,
                df.criado_em     AS vinculado_em
            FROM documentos_familias df
            INNER JOIN documentos_habilitacao dh ON df.documento_id = dh.id
            WHERE df.familia_id = :id
              AND (dh.restrito = false OR :is_conformidade)
            ORDER BY dh.titulo ASC
            """
        ),
        {"id": id, "is_conformidade": _is_conformidade_s12(user.role)},
    )
    documentos = [
        {
            "vinculoId": _jsonable(r["vinculo_id"]),
            "documentoId": _jsonable(r["documento_id"]),
            "titulo": r["titulo"],
            "categoria": r["categoria"],
            "subcategoria": r["subcategoria"],
            "status": r["status"],
            "validadeFim": _jsonable(r["validade_fim"]),
            "observacao": r["observacao"],
            "vinculadoEm": _jsonable(r["vinculado_em"]),
        }
        for r in res_docs.mappings().all()
    ]

    return JSONResponse(
        content={
            **familia,
            "aliases": aliases,
            "anexos": anexos,
            "documentos": documentos,
        }
    )


# ── PATCH ──────────────────────────────────────────────────────────────────────


@router.patch("/api/conformidade/familias/{id}")
async def patch_familia(
    id: str,
    request: Request,
    db=Depends(get_db),
) -> JSONResponse:
    """PATCH /api/conformidade/familias/{id} — edita a família.

    Ordem idêntica ao Next:
      1) ``requireAuth()`` → 401 (auth MANUAL p/ shape ``{error,code}``);
      2) ``podeGerenciarFamilias(role)`` (= isConformidade) → 403
         ``{error:"Permissão negada"}``;
      3) carrega ``getFamiliaById`` → 404 se não existe;
      4) parse do body (400 se JSON inválido) + validação (422 ``{error,detalhes}``);
      5) checa unicidade de codigoNormalizado se mudou o código → 409;
      6) UPDATE WHERE id AND deletado_em IS NULL RETURNING * (re-404 se 0 linhas);
      7) INSERT audit_log (EDITAR_FAMILIA);
      8) 200 com a família atualizada (objeto cru, igual ao Next).
    """
    # (1) requireAuth → 401
    user, resp401 = await _usuario_ou_401(request)
    if resp401 is not None:
        return resp401
    assert user is not None

    # (2) podeGerenciarFamilias → isConformidade (ADMIN/LIDER/SGI)
    if not is_conformidade(user.role):
        return JSONResponse(status_code=403, content={"error": "Permissão negada"})

    # (3) getFamiliaById → 404
    res_atual = await db.execute(
        text(
            f"SELECT {_FAMILIA_COLS} FROM familias "
            "WHERE id = :id AND deletado_em IS NULL LIMIT 1"
        ),
        {"id": id},
    )
    atual_row = res_atual.first()
    if atual_row is None:
        return _not_found()
    atual = _row_familia(atual_row)

    # (4a) body = await request.json(); JSON inválido → 400
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 — qualquer falha de parse = JSON inválido
        return JSONResponse(status_code=400, content={"error": "JSON inválido"})

    # (4b) EditarFamiliaSchema.safeParse → 422 {error, detalhes}
    data, detalhes = _validar_editar_familia(body)
    if detalhes is not None:
        return JSONResponse(
            status_code=422,
            content={"error": "Dados inválidos", "detalhes": detalhes},
        )
    assert data is not None

    # (5) Se mudou o código → verifica unicidade do codigoNormalizado → 409.
    if data.get("codigoCrc") and data["codigoCrc"] != atual["codigoCrc"]:
        codigo_normalizado = normalizar_codigo_crc(data["codigoCrc"])
        res_conf = await db.execute(
            text(
                "SELECT id FROM familias "
                "WHERE codigo_normalizado = :cn AND deletado_em IS NULL LIMIT 1"
            ),
            {"cn": codigo_normalizado},
        )
        conf_row = res_conf.first()
        if conf_row is not None and str(conf_row._mapping["id"]) != id:
            return JSONResponse(
                status_code=409,
                content={
                    "error": f"Já existe família com código {data['codigoCrc']}"
                },
            )

    # (6) Monta o SET do UPDATE (espelha o objeto `updates` do Next).
    set_clauses = ["atualizado_por = :atualizado_por", "atualizado_em = :atualizado_em"]
    params: dict[str, Any] = {
        "id": id,
        "atualizado_por": user.id,
        "atualizado_em": datetime.now(tz=timezone.utc),
    }

    if "codigoCrc" in data:
        set_clauses.append("codigo_crc = :codigo_crc")
        params["codigo_crc"] = data["codigoCrc"]
        set_clauses.append("codigo_normalizado = :codigo_normalizado")
        params["codigo_normalizado"] = normalizar_codigo_crc(data["codigoCrc"])
    if "nome" in data:
        set_clauses.append("nome = :nome")
        params["nome"] = data["nome"]
    if "descricao" in data:
        set_clauses.append("descricao = :descricao")
        params["descricao"] = data["descricao"]
    if "nivel" in data:
        set_clauses.append("nivel = :nivel")
        params["nivel"] = data["nivel"]
    if "parentId" in data:
        set_clauses.append("parent_id = :parent_id")
        params["parent_id"] = data["parentId"]
    if "cadastroCorporativo" in data:
        set_clauses.append("cadastro_corporativo = :cadastro_corporativo")
        params["cadastro_corporativo"] = data["cadastroCorporativo"]
    if "segmentoPetrobras" in data:
        set_clauses.append("segmento_petrobras = :segmento_petrobras")
        params["segmento_petrobras"] = data["segmentoPetrobras"]
    if "statusFluxoCrc" in data:
        set_clauses.append("status_fluxo_crc = :status_fluxo_crc")
        params["status_fluxo_crc"] = data["statusFluxoCrc"]
    if "status" in data:
        set_clauses.append("status = :status")
        params["status"] = data["status"]
    if "validadeFim" in data:
        # No Next: data.validadeFim ? new Date(data.validadeFim) : null.
        set_clauses.append("validade_fim = :validade_fim")
        params["validade_fim"] = (
            _parse_data(data["validadeFim"]) if data["validadeFim"] else None
        )
    if "criterios" in data:
        set_clauses.append("criterios = CAST(:criterios AS jsonb)")
        params["criterios"] = _json_dumps(data["criterios"])
    if "tags" in data:
        set_clauses.append("tags = CAST(:tags AS jsonb)")
        params["tags"] = _json_dumps(data["tags"])
    if "escoposCobertos" in data:
        set_clauses.append("escopos_cobertos = CAST(:escopos_cobertos AS jsonb)")
        params["escopos_cobertos"] = _json_dumps(data["escoposCobertos"])
    if "observacoes" in data:
        set_clauses.append("observacoes = :observacoes")
        params["observacoes"] = data["observacoes"]

    set_sql = ", ".join(set_clauses)
    res_upd = await db.execute(
        text(
            f"UPDATE familias SET {set_sql} "
            f"WHERE id = :id AND deletado_em IS NULL "
            f"RETURNING {_FAMILIA_COLS}"
        ),
        params,
    )
    atualizada_row = res_upd.first()
    if atualizada_row is None:
        # Mesmo que `atual` existisse, o lock por deletado_em pode ter mudado.
        await db.rollback()
        return _not_found()
    atualizada = _row_familia(atualizada_row)

    # (7) INSERT audit_log (EDITAR_FAMILIA) — mesmo `detalhes` (antes/depois).
    detalhes_audit = {
        "antes": {
            "codigoCrc": atual["codigoCrc"],
            "nome": atual["nome"],
            "status": atual["status"],
            "segmentoPetrobras": atual["segmentoPetrobras"],
            "statusFluxoCrc": atual["statusFluxoCrc"],
        },
        "depois": {
            "codigoCrc": atualizada["codigoCrc"],
            "nome": atualizada["nome"],
            "status": atualizada["status"],
            "segmentoPetrobras": atualizada["segmentoPetrobras"],
            "statusFluxoCrc": atualizada["statusFluxoCrc"],
        },
    }
    await registrar_audit(
        db,
        user_id=user.id,
        acao="EDITAR_FAMILIA",
        entidade="familia",
        entidade_id=id,
        detalhes=detalhes_audit,
    )

    await db.commit()

    # (8) 200 com a família atualizada (objeto cru, igual ao Next).
    return JSONResponse(content=atualizada)


# ── DELETE ──────────────────────────────────────────────────────────────────────


@router.delete("/api/conformidade/familias/{id}")
async def delete_familia(
    id: str,
    request: Request,
    db=Depends(get_db),
) -> JSONResponse:
    """DELETE /api/conformidade/familias/{id} — soft delete (somente ADMIN).

    Ordem idêntica ao Next:
      1) ``requireAuth()`` → 401 (auth MANUAL p/ shape ``{error,code}``);
      2) ``podeExcluirFamilia(role)`` (= isAdmin) → 403 ``{error:"Somente
         administradores podem excluir famílias"}``;
      3) ``getFamiliaById`` → 404 se não existe;
      4) UPDATE deletado_em/atualizado_em WHERE id (SEM filtro deletado_em — bug
         de produção replicado: o WHERE só usa eq(id), não isNull(deletado_em));
      5) INSERT audit_log (EXCLUIR_FAMILIA);
      6) 200 ``{ok:true, message:"Família removida com sucesso"}``.
    """
    # (1) requireAuth → 401
    user, resp401 = await _usuario_ou_401(request)
    if resp401 is not None:
        return resp401
    assert user is not None

    # (2) podeExcluirFamilia → isAdmin (ADMIN)
    if not is_admin(user.role):
        return JSONResponse(
            status_code=403,
            content={"error": "Somente administradores podem excluir famílias"},
        )

    # (3) getFamiliaById → 404
    res_atual = await db.execute(
        text(
            f"SELECT {_FAMILIA_COLS} FROM familias "
            "WHERE id = :id AND deletado_em IS NULL LIMIT 1"
        ),
        {"id": id},
    )
    atual_row = res_atual.first()
    if atual_row is None:
        return _not_found()
    atual = _row_familia(atual_row)

    # (4) Soft delete. O Next NÃO filtra por deletado_em no WHERE do UPDATE
    # (apenas eq(familias.id, id)). Replicado fielmente.
    agora = datetime.now(tz=timezone.utc)
    await db.execute(
        text(
            "UPDATE familias SET deletado_em = :deletado_em, "
            "atualizado_em = :atualizado_em WHERE id = :id"
        ),
        {"deletado_em": agora, "atualizado_em": agora, "id": id},
    )

    # (5) INSERT audit_log (EXCLUIR_FAMILIA).
    await registrar_audit(
        db,
        user_id=user.id,
        acao="EXCLUIR_FAMILIA",
        entidade="familia",
        entidade_id=id,
        detalhes={"codigoCrc": atual["codigoCrc"], "nome": atual["nome"]},
    )

    await db.commit()

    # (6) 200 {ok, message}.
    return JSONResponse(
        content={"ok": True, "message": "Família removida com sucesso"}
    )


# ── Helpers internos (json/data) ──────────────────────────────────────────────


def _json_dumps(value: Any) -> str:
    """Serializa dict/list p/ string JSON (param de CAST(... AS jsonb)).

    ``separators=(',',':')`` espelha ``JSON.stringify`` (sem espaços) — paridade
    com o serializador do JS (o Postgres reparseia o jsonb de qualquer forma).
    """
    import json as _json

    return _json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _parse_data(valor: str) -> datetime:
    """Espelha ``new Date(valor)`` p/ a coluna timestamptz (validade_fim).

    Aceita ISO 8601 com ``Z`` (normaliza p/ ``+00:00``). Em caso de string não-ISO
    o ``new Date()`` do JS produziria ``Invalid Date``; aqui mantemos paridade com
    o caminho feliz (o body já passou pela validação ISO do schema).
    """
    candidato = valor[:-1] + "+00:00" if valor.endswith("Z") else valor
    return datetime.fromisoformat(candidato)
