"""Rota MIGRADA (estrangulador): /api/conformidade/cofre/documentos/{id}/familias.

Espelha 1:1 a rota Next:
  src/app/api/conformidade/cofre/documentos/[id]/familias/route.ts

Vínculos N:N entre um documento do cofre de habilitação e as famílias CRC que
ele comprova (tabela ``documentos_familias``). Três handlers:

  GET    — lista famílias vinculadas         (guard: requireVisualizar)
  POST   — vincula uma família (idempotente)  (guard: requireAuth + role check)
  DELETE — desvincula uma família             (guard: requireAuth + role check)

────────────────────────────────────────────────────────────────────────────────
GUARDS (paridade EXATA com o Next):

  GET  -> ``requireVisualizar()``  == BFF ``require_visualizar``
          (ADMIN/LIDER/ORCAMENTISTA/TECNICO/SGI/VISUALIZADOR; EXTERNO barrado).
          Sessão ausente -> 401 (get_current_user); papel inválido -> 403.

  POST / DELETE -> NÃO usam ``requireVisualizar``/``requireRole``. O Next faz:
            1) ``requireAuth()``  (apenas sessão válida — QUALQUER papel, inclusive
               EXTERNO, passa nesta etapa; 401 se não logado);
            2) checagem MANUAL de papel via ``podeGerenciarDocumentosHabilitacao``:
                 isConformidade(role)  -> {ADMIN, LIDER, SGI}
                 OU role == ORCAMENTISTA
                 OU role == TECNICO
               -> se falhar: 403 { "error": "Permissão negada" }.

          IMPORTANTE: a paridade aqui NÃO é ``require_propor`` nem
          ``require_conformidade`` — é a UNIÃO {ADMIN, LIDER, SGI, ORCAMENTISTA,
          TECNICO} (i.e. todos exceto VISUALIZADOR e EXTERNO). Por isso o guard de
          AUTENTICAÇÃO é ``get_current_user`` (== requireAuth) e o gate de PAPEL é
          replicado à mão com :func:`_pode_gerenciar_documentos_habilitacao`, na
          MESMA ORDEM do Next (auth primeiro -> 401; depois papel -> 403).

ORDEM DAS CHECAGENS (idêntica ao Next):
  POST:  auth(401) -> role(403) -> parse JSON(400) -> validação(422) ->
         idempotência -> INSERT + audit -> 200.
  DELETE: auth(401) -> role(403) -> familiaId query obrigatório(400) ->
          DELETE + audit -> 200.

SHAPES de erro (cópia literal do route.ts — NÃO normalizar):
  - JSON inválido:      400 { "error": "JSON inválido" }
  - Permissão negada:   403 { "error": "Permissão negada" }
  - Dados inválidos:    422 { "error": "Dados inválidos", "detalhes": { campo: msg } }
  - familiaId faltando: 400 { "error": "Query param familiaId é obrigatório" }
  (Observação: este route.ts usa o shape PLANO ``{error: "<msg>"}``, NÃO o shape
   aninhado ``{error: {message}}``. Replicamos exatamente o que o Next devolve.)

VALIDAÇÃO (réplica do VincularDocumentoFamiliaSchema do Zod v4.4.3):
  familiaId   -> string UUID (z.string().uuid("ID inválido"))   OBRIGATÓRIO
  observacao  -> string, max 500                                OPCIONAL
  Mensagens de erro Zod replicadas em :func:`_validar_vincular` no MESMO formato de
  ``formatZodErrors`` (mapa { "caminho.do.campo": "mensagem" }). O projeto usa ZOD
  v4 (package.json: ``zod ^4.3.6``; instalado 4.4.3) — as strings seguem o formato
  v4 (NÃO v3), VERIFICADAS executando o schema real contra a versão instalada:
    - ausente   -> "Invalid input: expected string, received undefined"
    - null      -> "Invalid input: expected string, received null"  (erro de TIPO)
    - tipo errado -> "Invalid input: expected string, received <tipo>"
    - >500 chars  -> "Too big: expected string to have <=500 characters"
    - raiz não-objeto -> "Invalid input: expected object, received <tipo>"
    - uuid inválido   -> "ID inválido" (única mensagem custom).

SERIALIZAÇÃO de wire (paridade JSON.parse(bff) == JSON.parse(next)):
  - ``documentos_familias.id`` / ``familias.id`` são ``uuid`` -> ``str(...)``.
  - ``documentos_familias.criado_em`` e família.* são serializados pelo
    ``getFamiliasByDocumento`` do Drizzle: ``criado_em`` é ``timestamp WITH tz``
    (``withTimezone: true``) -> o Drizzle (mode "string" para colunas withTimezone)
    devolve a STRING crua do Postgres no GET? Não: o select usa ``criadoEm`` que é
    ``timestamp({ withTimezone: true })`` e o Drizzle entrega ``Date`` -> o
    ``NextResponse.json`` serializa via ``.toISOString()`` (UTC, ms, 'Z'). Usamos
    :func:`_js_to_iso_string` (convenção dos irmãos migrados).

DB:
  - POST insere em ``documentos_familias`` (RETURNING id) e em ``audit_log``.
    ``audit_log.detalhes`` é ``jsonb`` -> cast ``:detalhes::jsonb`` com json.dumps.
    ``audit_log.id`` é ``serial`` (NÃO devolvido na resposta — paridade).
  - DELETE remove de ``documentos_familias`` (sem RETURNING; idempotente: 0 linhas
    ainda devolve {ok:true}, igual ao Drizzle) e insere em ``audit_log``.
  - Em ambos: commit do vínculo/DELETE e do audit SEPARADAMENTE (dois
    ``await db.commit()``), replicando a NÃO-atomicidade do Next (node-postgres
    Pool sem ``db.transaction``: cada INSERT/DELETE é autocommit). Se o audit
    falhar, o vínculo/desvínculo já está persistido — paridade bug-a-bug.

Objetivo: JSON.parse(resp_bff) == JSON.parse(resp_next) e MESMOS status codes.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

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

# Regex de UUID — replica z.string().uuid() do Zod. O Zod aceita UUID v1-v8 no
# formato canônico 8-4-4-4-12 (case-insensitive). Usamos o mesmo formato canônico.
_UUID_REGEX = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _js_to_iso_string(dt) -> str | None:
    """Replica ``new Date(dt).toISOString()`` do JS (UTC, ms, sufixo 'Z').

    ``criado_em`` é ``timestamp WITH tz`` -> o asyncpg devolve ``datetime``
    aware; o Drizzle entrega ``Date`` e o ``NextResponse.json`` serializa via
    ``.toISOString()`` (sempre UTC, MILISSEGUNDOS, sufixo 'Z'). Usamos esta
    formatação manual em vez de ``isoformat()`` (que daria '+00:00' e micros).
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


def _pode_gerenciar_documentos_habilitacao(role: str) -> bool:
    """Réplica de ``podeGerenciarDocumentosHabilitacao`` (permissions.ts).

    ``isConformidade(role) || role === ORCAMENTISTA || role === TECNICO``
    -> {ADMIN, LIDER, SGI, ORCAMENTISTA, TECNICO}.
    """
    return (
        is_conformidade(role)
        or role == ROLE_ORCAMENTISTA
        or role == ROLE_TECNICO
    )


#: Sentinela de "chave ausente" no body. O JS distingue ``undefined`` (chave não
#: enviada) de ``null`` (enviada como null) — o Zod v4 reporta "received
#: undefined" vs "received null". Como o JSON não carrega ``undefined`` e o
#: ``request.json()`` colapsa a ausência, marcamos a AUSÊNCIA com este sentinela
#: para reproduzir a mensagem certa.
_MISSING = object()


def _validar_vincular(body: Any) -> tuple[dict | None, dict | None]:
    """Réplica do ``VincularDocumentoFamiliaSchema`` (Zod v4.4.3) + ``formatZodErrors``.

    Schema:
      familiaId  -> z.string().uuid("ID inválido")   (obrigatório)
      observacao -> z.string().max(500).optional()

    Retorna ``(data, None)`` em sucesso ou ``(None, detalhes)`` em falha, onde
    ``detalhes`` é o mapa ``{ "caminho.do.campo": "mensagem" }`` produzido por
    ``formatZodErrors`` (chave = ``issue.path.join(".")``).

    Mensagens EXATAS do Zod v4.4.3 (verificadas executando o schema real contra
    a versão instalada — NÃO o formato do Zod v3):
      - body não-objeto -> "" -> "Invalid input: expected object, received <tipo>".
      - familiaId ausente -> "Invalid input: expected string, received undefined".
      - familiaId null -> "Invalid input: expected string, received null"
        (erro de TIPO, não "obrigatório" — não há .nullable()).
      - familiaId não-string -> "Invalid input: expected string, received <tipo>".
      - familiaId string mas não-UUID -> "ID inválido" (mensagem custom).
      - observacao null/não-string -> "Invalid input: expected string, received <tipo>".
      - observacao string > 500 -> "Too big: expected string to have <=500 characters".
    O Zod por default NÃO aborta no primeiro erro (coleta todos os issues do
    nível); coletamos múltiplos issues do mesmo modo.
    """
    detalhes: dict[str, str] = {}

    if not isinstance(body, dict):
        # Zod object schema sobre não-objeto: issue na raiz (path = "" -> chave "").
        recebido = _zod_typename(body)
        detalhes[""] = f"Invalid input: expected object, received {recebido}"
        return None, detalhes

    # ── familiaId (obrigatório, string UUID) ──────────────────────────────────
    # Zod v4: ausente -> "received undefined"; null -> "received null"; outro tipo
    # -> "received <tipo>" (tudo erro de TIPO, mesmo prefixo "Invalid input:").
    fam = body["familiaId"] if "familiaId" in body else _MISSING
    if not isinstance(fam, str):
        detalhes["familiaId"] = (
            f"Invalid input: expected string, received {_zod_typename(fam)}"
        )
    elif not _UUID_REGEX.match(fam):
        detalhes["familiaId"] = "ID inválido"

    # ── observacao (opcional, string max 500) ─────────────────────────────────
    # Zod .optional(): ausente é ok; null NÃO é aceito (não há .nullable()) e cai
    # em "Invalid input: expected string, received null".
    if "observacao" in body:
        obs = body["observacao"]
        if not isinstance(obs, str):
            detalhes["observacao"] = (
                f"Invalid input: expected string, received {_zod_typename(obs)}"
            )
        elif len(obs) > 500:
            detalhes["observacao"] = (
                "Too big: expected string to have <=500 characters"
            )

    if detalhes:
        return None, detalhes

    data = {
        "familiaId": body["familiaId"],
        # parsed.data.observacao ?? null  -> chave presente com valor ou ausente.
        "observacao": body.get("observacao"),
    }
    return data, None


def _zod_typename(value: Any) -> str:
    """Nome do tipo no estilo Zod v4 para mensagens 'expected X, received <tipo>'.

    ``_MISSING`` (chave ausente) -> "undefined"; ``None`` -> "null".
    """
    if value is _MISSING:
        return "undefined"
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return "unknown"


# ── SQL ───────────────────────────────────────────────────────────────────────

# getFamiliasByDocumento: innerJoin documentos_familias × familias, ordenado por
# familias.codigo_crc asc. Aliases camelCase IGUAIS aos do Drizzle.
_GET_FAMILIAS_SQL = text(
    """
    SELECT
      df.id          AS vinculo_id,
      f.id           AS familia_id,
      f.codigo_crc   AS codigo_crc,
      f.nome         AS nome,
      f.status       AS status,
      df.observacao  AS observacao,
      df.criado_em   AS vinculado_em
    FROM documentos_familias df
    INNER JOIN familias f ON df.familia_id = f.id
    WHERE df.documento_id = :documento_id
    ORDER BY f.codigo_crc ASC
    """
)

# Idempotência: SELECT id ... WHERE documento_id = :id AND familia_id = :fam LIMIT 1
_EXISTE_VINCULO_SQL = text(
    """
    SELECT id
    FROM documentos_familias
    WHERE documento_id = :documento_id AND familia_id = :familia_id
    LIMIT 1
    """
)

# INSERT do vínculo (RETURNING id). observacao = parsed.data.observacao ?? null.
_INSERT_VINCULO_SQL = text(
    """
    INSERT INTO documentos_familias (documento_id, familia_id, observacao)
    VALUES (:documento_id, :familia_id, :observacao)
    RETURNING id
    """
)

# DELETE do vínculo (sem RETURNING; idempotente).
_DELETE_VINCULO_SQL = text(
    """
    DELETE FROM documentos_familias
    WHERE documento_id = :documento_id AND familia_id = :familia_id
    """
)

# Trilha de auditoria (audit_log): delegada a app.services.audit.registrar_audit,
# que faz o INSERT na MESMA sessão 'db' (commit é do handler) — espelha o
# db.insert(auditLog).values({...}) do Next.


# ── Barreira do documento PAI restrito (0034/S11 — 02-APIS §16-B.2) ───────────
async def _pai_restrito_invisivel(db, id: str, role: str) -> bool:
    """True quando o pai existe, é ``restrito`` e o papel está fora de
    Conformidade — TODOS os métodos deste arquivo respondem o MESMO 404 de
    documento inexistente (403 confirmaria a existência do pai — ADR-05).
    Pai inexistente → False (os gates atuais tratam)."""
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


# ── GET — lista famílias vinculadas ───────────────────────────────────────────
@router.get("/api/conformidade/cofre/documentos/{id}/familias")
async def listar_familias(
    id: str,
    request: Request,
    user: CurrentUser = Depends(require_visualizar),
    db=Depends(get_db),
) -> JSONResponse:
    """GET: lista famílias vinculadas ao documento. Guard: require_visualizar.

    Espelha ``getFamiliasByDocumento(id)`` -> ``NextResponse.json({ data: lista })``.
    """
    # Barreira do pai (0034/S11): documento restrito é invisível fora de Conf.
    if await _pai_restrito_invisivel(db, id, user.role):
        return JSONResponse(
            status_code=404, content={"error": "Documento não encontrado"}
        )

    rows = (await db.execute(_GET_FAMILIAS_SQL, {"documento_id": id})).mappings().all()
    lista = [
        {
            "vinculoId": str(r["vinculo_id"]),
            "familiaId": str(r["familia_id"]),
            "codigoCrc": r["codigo_crc"],
            "nome": r["nome"],
            "status": r["status"],
            "observacao": r["observacao"],
            "vinculadoEm": _js_to_iso_string(r["vinculado_em"]),
        }
        for r in rows
    ]
    return JSONResponse(content={"data": lista})


# ── POST — vincula uma família (idempotente) ──────────────────────────────────
@router.post("/api/conformidade/cofre/documentos/{id}/familias")
async def vincular_familia(
    id: str,
    request: Request,
    # requireAuth() do Next == apenas sessão válida (qualquer papel, inclusive
    # EXTERNO). O gate de PAPEL é feito À MÃO logo abaixo, na mesma ordem do Next.
    user: CurrentUser = Depends(get_current_user),
    db=Depends(get_db),
) -> JSONResponse:
    """POST: vincula a família ao documento. Auth(401) -> role(403) -> 422/400.

    Réplica fiel do handler POST do route.ts (idempotente: vínculo já existente
    devolve ``{id, ok:true, status:"ja-existia"}`` sem erro).
    """
    # 2) Checagem manual de papel (após auth) — podeGerenciarDocumentosHabilitacao.
    if not _pode_gerenciar_documentos_habilitacao(user.role):
        return JSONResponse(status_code=403, content={"error": "Permissão negada"})

    # 2b) Barreira do pai restrito (0034/S11) — antes de qualquer efeito.
    if await _pai_restrito_invisivel(db, id, user.role):
        return JSONResponse(
            status_code=404, content={"error": "Documento não encontrado"}
        )

    # 3) Parse do body IGUAL ao Next: try { await request.json() } catch -> 400.
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 — JSON malformado -> 400, igual ao Next.
        return JSONResponse(status_code=400, content={"error": "JSON inválido"})

    # 4) Validação (Zod safeParse) -> 422 { error, detalhes } se falhar.
    data, detalhes = _validar_vincular(body)
    if data is None:
        return JSONResponse(
            status_code=422,
            content={"error": "Dados inválidos", "detalhes": detalhes},
        )

    familia_id = data["familiaId"]
    observacao = data["observacao"]  # parsed.data.observacao ?? null

    # 5) Idempotência: se já existe vínculo, retorna sem erro.
    existente = (
        await db.execute(
            _EXISTE_VINCULO_SQL,
            {"documento_id": id, "familia_id": familia_id},
        )
    ).mappings().first()
    if existente is not None:
        return JSONResponse(
            content={"id": str(existente["id"]), "ok": True, "status": "ja-existia"}
        )

    # 6) INSERT do vínculo (RETURNING id).
    novo = (
        await db.execute(
            _INSERT_VINCULO_SQL,
            {
                "documento_id": id,
                "familia_id": familia_id,
                "observacao": observacao,
            },
        )
    ).mappings().first()

    # 7) audit_log: VINCULAR_DOC_FAMILIA. detalhes = { familiaId } (mesmas chaves
    # do Next: db.insert(auditLog).values({ userId: session.user.id, acao,
    # entidade, entidadeId: id, detalhes: { familiaId } })). Best-effort, na MESMA
    # sessão 'db', acompanhando a operação até o commit do handler abaixo.
    await registrar_audit(
        db,
        user_id=user.id,
        acao="VINCULAR_DOC_FAMILIA",
        entidade="documento_habilitacao",
        entidade_id=id,
        detalhes={"familiaId": familia_id},
    )
    await db.commit()

    return JSONResponse(content={"id": str(novo["id"]), "ok": True})


# ── DELETE — desvincula uma família ───────────────────────────────────────────
@router.delete("/api/conformidade/cofre/documentos/{id}/familias")
async def desvincular_familia(
    id: str,
    request: Request,
    # requireAuth() -> get_current_user (qualquer papel logado). Papel à mão abaixo.
    user: CurrentUser = Depends(get_current_user),
    db=Depends(get_db),
) -> JSONResponse:
    """DELETE: desvincula a família do documento. Auth(401) -> role(403) -> 400.

    ``familiaId`` vem do query string (``?familiaId=...``), NÃO do body — igual ao
    Next (``new URL(request.url).searchParams.get("familiaId")``). Idempotente:
    ausência de linha a remover ainda devolve ``{ok:true}`` (Drizzle delete sem
    RETURNING).
    """
    # 2) Checagem manual de papel (após auth).
    if not _pode_gerenciar_documentos_habilitacao(user.role):
        return JSONResponse(status_code=403, content={"error": "Permissão negada"})

    # 2b) Barreira do pai restrito (0034/S11) — antes de qualquer efeito.
    if await _pai_restrito_invisivel(db, id, user.role):
        return JSONResponse(
            status_code=404, content={"error": "Documento não encontrado"}
        )

    # 3) familiaId query param obrigatório -> 400 se ausente.
    familia_id = request.query_params.get("familiaId")
    if not familia_id:
        return JSONResponse(
            status_code=400,
            content={"error": "Query param familiaId é obrigatório"},
        )

    # 4) DELETE do vínculo (sem RETURNING).
    await db.execute(
        _DELETE_VINCULO_SQL,
        {"documento_id": id, "familia_id": familia_id},
    )

    # 5) audit_log: DESVINCULAR_DOC_FAMILIA. detalhes = { familiaId } (mesmas
    # chaves do Next: db.insert(auditLog).values({ userId: session.user.id, acao,
    # entidade, entidadeId: id, detalhes: { familiaId } })). Best-effort, na MESMA
    # sessão 'db', acompanhando o DELETE até o commit do handler abaixo.
    await registrar_audit(
        db,
        user_id=user.id,
        acao="DESVINCULAR_DOC_FAMILIA",
        entidade="documento_habilitacao",
        entidade_id=id,
        detalhes={"familiaId": familia_id},
    )
    await db.commit()

    return JSONResponse(content={"ok": True})
