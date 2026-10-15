"""Rota MIGRADA: /api/conformidade/cofre/documentos/{id}/projetos (estrangulador).

Espelha 1:1 a rota Next:
  src/app/api/conformidade/cofre/documentos/[id]/projetos/route.ts

Métodos (paridade total):

  GET    /api/conformidade/cofre/documentos/{id}/projetos
    -> requireVisualizar()            (BFF: require_visualizar — ADMIN/LIDER/
       ORCAMENTISTA/TECNICO/SGI/VISUALIZADOR; barra EXTERNO com 403)
    -> getProjetosByDocumento(id):
         SELECT * FROM documentos_projetos
         WHERE documento_id = :id
         ORDER BY periodo_fim DESC      (Postgres DESC => NULLS FIRST)
    -> NextResponse.json({ data: lista })

  POST   /api/conformidade/cofre/documentos/{id}/projetos
    -> requireAuth()                   (BFF: get_current_user — SÓ sessão; NÃO
       usamos require_visualizar porque o Next só exige sessão aqui e a checagem
       de papel é MANUAL e diferente — um EXTERNO logado chega ao 403 manual)
    -> if (!podeGerenciarDocumentosHabilitacao(role)) -> 403 {error:"Permissão negada"}
       (= isConformidade(role) || role==ORCAMENTISTA || role==TECNICO
        = {ADMIN, LIDER, SGI, ORCAMENTISTA, TECNICO})
    -> body = await request.json()  (catch -> 400 {error:"JSON inválido"})
    -> VincularDocumentoProjetoSchema.safeParse(body)
         falha -> 422 {error:"Dados inválidos", detalhes:{<path>:<msg>}}
    -> INSERT INTO documentos_projetos (...) RETURNING *
    -> INSERT INTO audit_log (acao=ADICIONAR_PROJETO_DOC, entidade=documento_habilitacao,
         entidade_id=id, detalhes={projetoId, projetoNome})
    -> NextResponse.json(novo, {status: 201})   (a linha inteira inserida)

  DELETE /api/conformidade/cofre/documentos/{id}/projetos?projetoId=...
    -> requireAuth() + mesma checagem manual de papel (403 {error:"Permissão negada"})
    -> projetoId = searchParams.get("projetoId")
       if (!projetoId) -> 400 {error:"Query param projetoId é obrigatório"}
    -> DELETE FROM documentos_projetos WHERE documento_id = :id AND id = :projetoId
    -> INSERT INTO audit_log (acao=REMOVER_PROJETO_DOC, ..., detalhes={projetoId})
    -> NextResponse.json({ ok: true })

NOTAS DE PARIDADE (replicar comportamento de produção, inclusive "bugs"):

  - SHAPE de erro: os erros levantados DENTRO do handler do Next (403/400/422)
    usam ``{error: ...}`` (e ``detalhes`` no 422) — replicados literalmente via
    JSONResponse. O 401 (sessão ausente/ inválida) é levantado pelo dependency
    de auth (``get_current_user``), que rende ``{"detail": ...}`` — convenção da
    camada de auth do BFF, igual aos irmãos migrados.

  - O Next NÃO verifica se o documento ``id`` existe antes do INSERT, e NÃO
    valida o formato do ``id``. A FK ``documento_id -> documentos_habilitacao``
    e o cast UUID ficam a cargo do Postgres: id inexistente/ malformado ->
    erro do banco (500). Replicamos: passamos ``id`` cru e deixamos o banco
    decidir (paridade de produção).

  - O DELETE NÃO confere se alguma linha foi removida — sempre devolve
    ``{ ok: true }`` e grava o audit_log mesmo que nada tenha sido apagado
    (idempotente / sem 404). Replicado.

  - Validação: Zod v4 (zod ^4). Reproduzimos as mensagens EXATAS observadas
    (inclusive os textos default em inglês de tipo/tamanho) e a ordem de
    avaliação por chave do objeto. ``formatZodErrors`` faz join do path por '.'
    e last-write-wins por path. Corpo não-objeto -> ``detalhes: {"": ...}``.

  - Serialização (paridade de WIRE com o NextResponse.json/Drizzle):
      uuid          -> str()               (id, documento_id)
      numeric(18,2) -> STRING como o pg devolve (Drizzle ``numeric`` mode default
                       = string; ex.: 1000 -> "1000.00"); None -> null
      timestamptz   -> Date.toISOString() do JS (UTC, ms, sufixo 'Z') via
                       :func:`_js_to_iso_string` (Drizzle timestamp mode default
                       = "date" -> JS Date -> .toISOString())
      text          -> str | null
"""

from __future__ import annotations

import json
import math
import re
from datetime import datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import (
    CurrentUser,
    get_current_user,
    is_conformidade,
    require_visualizar,
    ROLE_ORCAMENTISTA,
    ROLE_TECNICO,
)
from app.db.session import get_db
from app.routers.migrated._restrito import is_conformidade
from app.services.audit import registrar_audit

router = APIRouter()


# ── Permissão (espelha podeGerenciarDocumentosHabilitacao de permissions.ts) ──
def _pode_gerenciar_documentos_habilitacao(role: str) -> bool:
    """isConformidade(role) || role==ORCAMENTISTA || role==TECNICO.

    => {ADMIN, LIDER, SGI} ∪ {ORCAMENTISTA, TECNICO}.
    """
    return is_conformidade(role) or role == ROLE_ORCAMENTISTA or role == ROLE_TECNICO


# ── Parse de JSON estrito (espelha JS JSON.parse usado por request.json()) ─────
#
# O ``request.json()`` do Starlette delega a ``json.loads(body)`` do CPython,
# que por padrão ACEITA os tokens não-padrão ``Infinity``/``NaN``/``-Infinity``
# (extensão do CPython). O ``request.json()`` do Next usa ``JSON.parse`` do JS,
# que REJEITA esses tokens com ``SyntaxError`` -> cai no ``catch`` e devolve
# 400 ``{error:"JSON inválido"}``. Para paridade, parseamos o corpo cru com um
# ``parse_constant`` que levanta, fazendo o ``json.loads`` falhar (e o
# try/except do handler devolver o mesmo 400).
def _reject_constant(token: str):  # noqa: ANN202 — sempre levanta
    """Rejeita Infinity/NaN/-Infinity como o ``JSON.parse`` do JS."""
    raise ValueError(f"Constante JSON não-padrão não permitida: {token}")


async def _strict_json(request: Request):
    """``await request.json()`` estrito: rejeita os literais não-padrão do CPython.

    Lê o corpo cru e usa ``json.loads(..., parse_constant=_reject_constant)``
    para casar com o ``JSON.parse`` do Next. Para corpo vazio, replica o
    ``json.loads(b"")`` (``JSONDecodeError``) — também tratado como JSON inválido,
    igual ao ``request.json()`` original.
    """
    raw = await request.body()
    return json.loads(raw, parse_constant=_reject_constant)


# ── Serialização de datetime (Date.toISOString() do JS: UTC, ms, sufixo Z) ────
def _js_to_iso_string(dt) -> str | None:
    """Replica ``new Date(dt).toISOString()`` (UTC, 3 casas de ms, sufixo 'Z').

    As colunas de tempo de ``documentos_projetos`` são ``timestamptz``; o asyncpg
    devolve ``datetime`` aware. O Drizzle (mode "date" default) entrega um JS
    ``Date`` e o ``NextResponse.json`` serializa via ``.toISOString()``. O
    ``datetime.isoformat()`` puro divergiria (``+00:00`` e microssegundos).
    """
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    ms = dt.microsecond // 1000
    return (
        f"{dt.year:04d}-{dt.month:02d}-{dt.day:02d}"
        f"T{dt.hour:02d}:{dt.minute:02d}:{dt.second:02d}.{ms:03d}Z"
    )


def _numeric_to_str(value) -> str | None:
    """Serializa ``numeric`` como o Drizzle (string), igual ao pg.

    Drizzle ``numeric`` (sem ``mode``) devolve STRING bruta do Postgres. Para
    ``numeric(18,2)`` o pg formata com 2 casas (ex.: 1000 -> "1000.00"). O
    asyncpg entrega ``Decimal``; convertemos para a mesma representação textual
    que o pg/Drizzle exporia.
    """
    if value is None:
        return None
    if isinstance(value, Decimal):
        # Casa com o texto que o pg devolve p/ numeric(18,2): 2 casas decimais.
        return f"{value:.2f}"
    return str(value)


def _serialize_projeto(row) -> dict:
    """Converte uma linha de ``documentos_projetos`` no shape do Drizzle row.

    Chaves camelCase IGUAIS às do schema Drizzle (``documentos_projetos``):
      id, documentoId, clienteCnpj, clienteNome, projetoNome, valorContrato,
      periodoInicio, periodoFim, descricaoServico, engenheiroResponsavel,
      registroCrea, numeroArt, criadoEm.
    """
    return {
        "id": str(row["id"]),
        "documentoId": str(row["documento_id"]),
        "clienteCnpj": row["cliente_cnpj"],
        "clienteNome": row["cliente_nome"],
        "projetoNome": row["projeto_nome"],
        "valorContrato": _numeric_to_str(row["valor_contrato"]),
        "periodoInicio": _js_to_iso_string(row["periodo_inicio"]),
        "periodoFim": _js_to_iso_string(row["periodo_fim"]),
        "descricaoServico": row["descricao_servico"],
        "engenheiroResponsavel": row["engenheiro_responsavel"],
        "registroCrea": row["registro_crea"],
        "numeroArt": row["numero_art"],
        "criadoEm": _js_to_iso_string(row["criado_em"]),
    }


# ── Validação: porte fiel do VincularDocumentoProjetoSchema (Zod v4) ──────────
#
# Regex de datetime EXTRAÍDO do Zod v4 (z.string().datetime() default — exige
# 'Z', valida ranges de data/hora incl. 29/02 bissexto, segundos opcionais).
_ZOD_DATETIME_RE = re.compile(
    r"^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|"
    r"[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|"
    r"(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))"
    r"T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z))$"
)

# Regex do CNPJ (14 dígitos), igual ao schema.
_CNPJ_RE = re.compile(r"^\d{14}$")

# Mensagens custom do schema.
_MSG_CNPJ = "CNPJ deve conter 14 dígitos"
_MSG_DATETIME = "Data e hora inválidas. Use o formato ISO 8601."
_MSG_VALOR_NEG = "Valor não pode ser negativo"
_MSG_VALOR_MAX = "Valor excede o limite permitido"
_VALOR_MAX = 999_999_999_999_99  # 99999999999999

# Ordem das chaves no z.object (Zod avalia nessa ordem).
_FIELD_ORDER = (
    "clienteCnpj",
    "clienteNome",
    "projetoNome",
    "valorContrato",
    "periodoInicio",
    "periodoFim",
    "descricaoServico",
    "engenheiroResponsavel",
    "registroCrea",
    "numeroArt",
)


#: Sentinela de "chave ausente" no body — o JS distingue ``undefined`` (chave
#: não enviada) de ``null`` (enviada como null). Em Python ``request.json()``
#: colapsa ambos em ``None``, então marcamos a AUSÊNCIA com este sentinela para
#: reproduzir a mensagem "received undefined" do Zod (vs. "received null").
_MISSING = object()


def _zod_type_name(value) -> str:
    """Nome do tipo como o Zod v4 reporta em "received X"."""
    if value is _MISSING:
        return "undefined"
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, float) and math.isnan(value):
        return "NaN"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return "unknown"


def _check_string(
    value,
    *,
    field: str,
    minimo: int | None,
    maximo: int | None,
    regex: re.Pattern | None,
    regex_msg: str | None,
    errs: dict,
) -> None:
    """Valida uma string opcional/obrigatória ao estilo Zod v4 (1 issue/campo)."""
    if not isinstance(value, str):
        errs[field] = f"Invalid input: expected string, received {_zod_type_name(value)}"
        return
    if minimo is not None and len(value) < minimo:
        errs[field] = f"Too small: expected string to have >={minimo} characters"
        return
    if maximo is not None and len(value) > maximo:
        errs[field] = f"Too big: expected string to have <={maximo} characters"
        return
    if regex is not None and not regex.match(value):
        errs[field] = regex_msg  # type: ignore[assignment]
        return


def _validar_vincular_projeto(body) -> tuple[dict | None, dict | None]:
    """safeParse do VincularDocumentoProjetoSchema.

    Retorna ``(data, None)`` em sucesso (apenas chaves conhecidas, strip de
    extras como o Zod object default) ou ``(None, detalhes)`` em falha
    (mapa path->mensagem, igual a ``formatZodErrors``).
    """
    # Corpo não-objeto -> uma issue de path "" (Zod root).
    if not isinstance(body, dict):
        return None, {
            "": f"Invalid input: expected object, received {_zod_type_name(body)}"
        }

    errs: dict[str, str] = {}
    data: dict = {}

    # clienteCnpj — optional string, regex 14 dígitos.
    if "clienteCnpj" in body and body["clienteCnpj"] is not None:
        v = body["clienteCnpj"]
        _check_string(
            v, field="clienteCnpj", minimo=None, maximo=None,
            regex=_CNPJ_RE, regex_msg=_MSG_CNPJ, errs=errs,
        )
        if "clienteCnpj" not in errs:
            data["clienteCnpj"] = v

    # clienteNome — required string min2 max200 (ausente -> "received undefined").
    v = body["clienteNome"] if "clienteNome" in body else _MISSING
    _check_string(
        v, field="clienteNome", minimo=2, maximo=200,
        regex=None, regex_msg=None, errs=errs,
    )
    if "clienteNome" not in errs:
        data["clienteNome"] = v

    # projetoNome — required string min2 max200 (ausente -> "received undefined").
    v = body["projetoNome"] if "projetoNome" in body else _MISSING
    _check_string(
        v, field="projetoNome", minimo=2, maximo=200,
        regex=None, regex_msg=None, errs=errs,
    )
    if "projetoNome" not in errs:
        data["projetoNome"] = v

    # valorContrato — optional number, nonnegative, max _VALOR_MAX (finito).
    if "valorContrato" in body and body["valorContrato"] is not None:
        v = body["valorContrato"]
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            errs["valorContrato"] = (
                f"Invalid input: expected number, received {_zod_type_name(v)}"
            )
        elif isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            # NaN -> "received NaN"; Infinity -> "received number" (Zod: number
            # check falha para não-finito reportando como number).
            recv = "NaN" if math.isnan(v) else "number"
            errs["valorContrato"] = f"Invalid input: expected number, received {recv}"
        elif v < 0:
            errs["valorContrato"] = _MSG_VALOR_NEG
        elif v > _VALOR_MAX:
            errs["valorContrato"] = _MSG_VALOR_MAX
        else:
            data["valorContrato"] = v

    # periodoInicio — optional ISO datetime (z.string().datetime()).
    if "periodoInicio" in body and body["periodoInicio"] is not None:
        v = body["periodoInicio"]
        if not isinstance(v, str):
            errs["periodoInicio"] = (
                f"Invalid input: expected string, received {_zod_type_name(v)}"
            )
        elif not _ZOD_DATETIME_RE.match(v):
            errs["periodoInicio"] = _MSG_DATETIME
        else:
            data["periodoInicio"] = v

    # periodoFim — optional ISO datetime.
    if "periodoFim" in body and body["periodoFim"] is not None:
        v = body["periodoFim"]
        if not isinstance(v, str):
            errs["periodoFim"] = (
                f"Invalid input: expected string, received {_zod_type_name(v)}"
            )
        elif not _ZOD_DATETIME_RE.match(v):
            errs["periodoFim"] = _MSG_DATETIME
        else:
            data["periodoFim"] = v

    # descricaoServico — optional string max2000.
    if "descricaoServico" in body and body["descricaoServico"] is not None:
        v = body["descricaoServico"]
        _check_string(
            v, field="descricaoServico", minimo=None, maximo=2000,
            regex=None, regex_msg=None, errs=errs,
        )
        if "descricaoServico" not in errs:
            data["descricaoServico"] = v

    # engenheiroResponsavel — optional string max200.
    if "engenheiroResponsavel" in body and body["engenheiroResponsavel"] is not None:
        v = body["engenheiroResponsavel"]
        _check_string(
            v, field="engenheiroResponsavel", minimo=None, maximo=200,
            regex=None, regex_msg=None, errs=errs,
        )
        if "engenheiroResponsavel" not in errs:
            data["engenheiroResponsavel"] = v

    # registroCrea — optional string max50.
    if "registroCrea" in body and body["registroCrea"] is not None:
        v = body["registroCrea"]
        _check_string(
            v, field="registroCrea", minimo=None, maximo=50,
            regex=None, regex_msg=None, errs=errs,
        )
        if "registroCrea" not in errs:
            data["registroCrea"] = v

    # numeroArt — optional string max50.
    if "numeroArt" in body and body["numeroArt"] is not None:
        v = body["numeroArt"]
        _check_string(
            v, field="numeroArt", minimo=None, maximo=50,
            regex=None, regex_msg=None, errs=errs,
        )
        if "numeroArt" not in errs:
            data["numeroArt"] = v

    if errs:
        # Reordena por _FIELD_ORDER (Zod emite issues na ordem das chaves);
        # path "" não ocorre aqui (corpo já é dict).
        ordenado = {f: errs[f] for f in _FIELD_ORDER if f in errs}
        return None, ordenado
    return data, None


# ── Barreira do documento PAI restrito (0034/S13 — 02-APIS §16-B.2) ───────────
async def _pai_restrito_invisivel(db, id: str, role: str) -> bool:
    """True quando o pai existe, é ``restrito`` e o papel está fora de
    Conformidade — o handler responde o MESMO 404 de documento inexistente
    (ADR-05). Pai inexistente → False (os gates atuais tratam)."""
    row = (
        await db.execute(
            text(
                "SELECT restrito FROM documentos_habilitacao "
                "WHERE id::text = :id LIMIT 1"
            ),
            {"id": id},
        )
    ).mappings().first()
    return row is not None and row["restrito"] and not is_conformidade(role)


# ── GET ───────────────────────────────────────────────────────────────────────
@router.get("/api/conformidade/cofre/documentos/{id}/projetos")
async def get_projetos(
    id: str,
    request: Request,
    user: CurrentUser = Depends(require_visualizar),
    db=Depends(get_db),
) -> JSONResponse:
    """GET: lista projetos vinculados ao documento (requireVisualizar)."""
    # Barreira do pai (0034/S13): documento restrito é invisível fora de Conf.
    if await _pai_restrito_invisivel(db, id, user.role):
        return JSONResponse(
            status_code=404, content={"error": "Documento não encontrado"}
        )

    sql = text(
        """
        SELECT
          id,
          documento_id,
          cliente_cnpj,
          cliente_nome,
          projeto_nome,
          valor_contrato,
          periodo_inicio,
          periodo_fim,
          descricao_servico,
          engenheiro_responsavel,
          registro_crea,
          numero_art,
          criado_em
        FROM documentos_projetos
        WHERE documento_id = :id
        ORDER BY periodo_fim DESC
        """
    )
    rows = (await db.execute(sql, {"id": id})).mappings().all()
    data = [_serialize_projeto(r) for r in rows]
    return JSONResponse(content={"data": data})


# ── POST ──────────────────────────────────────────────────────────────────────
@router.post("/api/conformidade/cofre/documentos/{id}/projetos")
async def post_projeto(
    id: str,
    request: Request,
    user: CurrentUser = Depends(get_current_user),
    db=Depends(get_db),
) -> JSONResponse:
    """POST: vincula um projeto ao documento (requireAuth + role manual)."""
    # if (!podeGerenciarDocumentosHabilitacao(role)) -> 403
    if not _pode_gerenciar_documentos_habilitacao(user.role):
        return JSONResponse(status_code=403, content={"error": "Permissão negada"})

    # Barreira do pai restrito (0034/S13) — antes de qualquer efeito.
    if await _pai_restrito_invisivel(db, id, user.role):
        return JSONResponse(
            status_code=404, content={"error": "Documento não encontrado"}
        )

    # body = await request.json()  (catch -> 400 "JSON inválido")
    # Parse ESTRITO: rejeita Infinity/NaN/-Infinity como o JSON.parse do JS
    # (o request.json() do Starlette os aceitaria, divergindo do Next).
    try:
        body = await _strict_json(request)
    except Exception:  # noqa: BLE001 — JSON malformado/ausente/não-padrão
        return JSONResponse(status_code=400, content={"error": "JSON inválido"})

    data, detalhes = _validar_vincular_projeto(body)
    if detalhes is not None:
        return JSONResponse(
            status_code=422,
            content={"error": "Dados inválidos", "detalhes": detalhes},
        )

    assert data is not None  # narrow para o type checker

    # INSERT ... RETURNING * — replica os mapeamentos do Next:
    #   valorContrato -> String(...) (numeric); periodos -> new Date(...) (timestamptz);
    #   campos ausentes -> null (?? null). RETURNING devolve a linha completa.
    insert_sql = text(
        """
        INSERT INTO documentos_projetos (
          documento_id,
          cliente_cnpj,
          cliente_nome,
          projeto_nome,
          valor_contrato,
          periodo_inicio,
          periodo_fim,
          descricao_servico,
          engenheiro_responsavel,
          registro_crea,
          numero_art
        ) VALUES (
          :documento_id,
          :cliente_cnpj,
          :cliente_nome,
          :projeto_nome,
          :valor_contrato,
          :periodo_inicio,
          :periodo_fim,
          :descricao_servico,
          :engenheiro_responsavel,
          :registro_crea,
          :numero_art
        )
        RETURNING
          id,
          documento_id,
          cliente_cnpj,
          cliente_nome,
          projeto_nome,
          valor_contrato,
          periodo_inicio,
          periodo_fim,
          descricao_servico,
          engenheiro_responsavel,
          registro_crea,
          numero_art,
          criado_em
        """
    )

    valor = data.get("valorContrato")
    params = {
        "documento_id": id,
        "cliente_cnpj": data.get("clienteCnpj"),  # ?? null (não enviado -> None)
        "cliente_nome": data["clienteNome"],
        "projeto_nome": data["projetoNome"],
        # valorContrato != null ? String(valorContrato) : null
        "valor_contrato": (str(valor) if valor is not None else None),
        # periodoInicio ? new Date(periodoInicio) : null
        "periodo_inicio": _parse_iso(data.get("periodoInicio")),
        "periodo_fim": _parse_iso(data.get("periodoFim")),
        "descricao_servico": data.get("descricaoServico"),
        "engenheiro_responsavel": data.get("engenheiroResponsavel"),
        "registro_crea": data.get("registroCrea"),
        "numero_art": data.get("numeroArt"),
    }

    novo = (await db.execute(insert_sql, params)).mappings().first()

    # INSERT no audit_log (acao=ADICIONAR_PROJETO_DOC, detalhes={projetoId, projetoNome}).
    # Mesma sessão 'db' e antes do commit -> acompanha a transação (paridade Next).
    await registrar_audit(
        db,
        user_id=user.id,
        acao="ADICIONAR_PROJETO_DOC",
        entidade="documento_habilitacao",
        entidade_id=id,
        detalhes={"projetoId": str(novo["id"]), "projetoNome": novo["projeto_nome"]},
    )

    await db.commit()

    return JSONResponse(status_code=201, content=_serialize_projeto(novo))


# ── DELETE ────────────────────────────────────────────────────────────────────
@router.delete("/api/conformidade/cofre/documentos/{id}/projetos")
async def delete_projeto(
    id: str,
    request: Request,
    user: CurrentUser = Depends(get_current_user),
    db=Depends(get_db),
) -> JSONResponse:
    """DELETE: remove o vínculo de projeto (requireAuth + role manual)."""
    if not _pode_gerenciar_documentos_habilitacao(user.role):
        return JSONResponse(status_code=403, content={"error": "Permissão negada"})

    # Barreira do pai restrito (0034/S13) — antes de qualquer efeito.
    if await _pai_restrito_invisivel(db, id, user.role):
        return JSONResponse(
            status_code=404, content={"error": "Documento não encontrado"}
        )

    projeto_id = request.query_params.get("projetoId")
    if not projeto_id:
        return JSONResponse(
            status_code=400,
            content={"error": "Query param projetoId é obrigatório"},
        )

    # DELETE FROM documentos_projetos WHERE documento_id = :id AND id = :projetoId
    await db.execute(
        text(
            """
            DELETE FROM documentos_projetos
            WHERE documento_id = :id AND id = :projeto_id
            """
        ),
        {"id": id, "projeto_id": projeto_id},
    )

    # audit_log (acao=REMOVER_PROJETO_DOC, detalhes={projetoId}).
    # Mesma sessão 'db' e antes do commit -> acompanha a transação (paridade Next).
    await registrar_audit(
        db,
        user_id=user.id,
        acao="REMOVER_PROJETO_DOC",
        entidade="documento_habilitacao",
        entidade_id=id,
        detalhes={"projetoId": projeto_id},
    )

    await db.commit()

    return JSONResponse(content={"ok": True})


# ── Helpers ───────────────────────────────────────────────────────────────────
def _parse_iso(value: str | None) -> datetime | None:
    """new Date(isoString) -> datetime aware p/ a coluna timestamptz.

    O valor já foi validado pelo regex do Zod (sempre termina em 'Z'). Aceita
    fração de segundos opcional. Devolve ``None`` quando ausente (parida com
    ``periodo ? new Date(periodo) : null``).
    """
    if value is None:
        return None
    # Normaliza o sufixo 'Z' para offset reconhecido pelo fromisoformat.
    iso = value[:-1] + "+00:00" if value.endswith("Z") else value
    return datetime.fromisoformat(iso)


def _json_dumps(obj) -> str:
    """Serializa o ``detalhes`` (jsonb) com chaves preservadas, sem ASCII-escape."""
    import json

    return json.dumps(obj, ensure_ascii=False)
