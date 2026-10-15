"""Rota migrada (strangler-fig): /api/conformidade/cofre/documentos/verificar (POST).

Espelho 1:1 de
``app/src/app/api/conformidade/cofre/documentos/verificar/route.ts`` — a
consulta de duplicata ANTES do upload: a tela calcula o SHA-256 de cada arquivo
no navegador (``sha256Hex`` de ``src/lib/conformidade/operacoes.ts``) e pergunta
aqui, em UMA chamada, quais desses hashes já estão no cofre. Sem isso a
duplicata só apareceria depois de subir o blob — é assim que uma duplicata
exata passa batida.

Rota de LEITURA apesar do POST: o verbo é POST porque o corpo é uma lista de
até 50 hashes (não cabe em query string). NÃO escreve nada — sem INSERT, sem
audit_log e sem ``commit``.

──────────────────────────────────────────────────────────────────────────────
GUARDS (o MESMO do POST de documento no cofre — não é o guard de leitura)
──────────────────────────────────────────────────────────────────────────────
``requireAuth()`` (SÓ 401) e SÓ DEPOIS a checagem MANUAL de papel
``podeGerenciarDocumentosHabilitacao(role)`` = isConformidade(role) ||
ORCAMENTISTA || TECNICO = {ADMIN, LIDER, SGI, ORCAMENTISTA, TECNICO}.
  401 ``{"error":"Não autenticado","code":"UNAUTHENTICATED"}``
  403 ``{"error":"Permissão negada"}``  ← objeto de UMA chave, SEM ``code``
      (``NextResponse.json({error}, {status:403})`` cru no Next). Por isso NÃO
      usamos ``Depends(require_conformidade)`` nem ``raise HTTPException``: o
      handler de ``main.py`` acrescentaria ``"code":"FORBIDDEN"``.
Ordem contratual: 401 SEMPRE antes de 403.

──────────────────────────────────────────────────────────────────────────────
SHAPE
──────────────────────────────────────────────────────────────────────────────
Corpo: ``{"sha256": ["<64 hex minúsculos>", ...]}`` — 1..50 itens.
  200 ``{"existentes": {"<sha>": {"id","restrito","titulo","criadoEm",
      "operacaoCodigo"}}}`` SÓ os hashes que existem (os que não existem
      simplesmente não aparecem no mapa — a tela testa por presença da chave).
      OCULTAÇÃO DE RESTRITO (0034/R5): hash que casa com documento
      ``restrito=true`` visto por papel FORA de Conformidade vem CEGO —
      ``{id, restrito:true, titulo:null, criadoEm:null, operacaoCodigo:null}``.
      A linha NÃO é filtrada (o uploader precisa saber que é duplicata, senão
      sobe de novo), mas título/data/operação não vazam. A ORDEM das chaves é a
      MESMA nos dois ramos (``restrito`` logo após ``id``).
  400 ``{"error":"JSON inválido"}``
  422 ``{"error":"Dados inválidos","detalhes":{campo: msg}}``

Hash em MINÚSCULO é contratual: é o que ``sha256Hex`` produz no navegador e o
que o POST do cofre grava (``hashlib.sha256().hexdigest()``). Hex maiúsculo é
recusado com 422 em vez de silenciosamente não casar.

Réplica do ``VerificarHashesSchema`` (mensagens conferidas executando o schema
real, Zod v4.4.3) — ver :func:`_validar_body`.

──────────────────────────────────────────────────────────────────────────────
SERIALIZAÇÃO
──────────────────────────────────────────────────────────────────────────────
``criadoEm`` (timestamptz) → :func:`_js_to_iso_string` (``toISOString``: UTC,
milissegundos, sufixo 'Z' — NÃO ``isoformat()``); ``id`` (uuid) → ``str()``;
``operacaoCodigo`` vem do LEFT JOIN com ``operacoes`` e é ``null`` quando o
documento não está ligado a nenhuma obra.

DESEMPATE: um mesmo SHA pode ter mais de uma linha (é exatamente o caso de
uma duplicata já gravada no cofre). ``ORDER BY criado_em ASC, id ASC`` + primeira
ocorrência vence ⇒ o mapa aponta sempre para o documento ORIGINAL, não para a
cópia. O ``id`` no fim é o que torna a ordem TOTAL: sem ele, dois registros
gravados no mesmo instante sairiam em ordem imprevisível e cada stack poderia
devolver um documento diferente para o mesmo hash.
"""

from __future__ import annotations

import json as _json
import re
from datetime import timezone
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import (
    CurrentUser,
    ROLE_ORCAMENTISTA,
    ROLE_TECNICO,
    ROLES_CONFORMIDADE,
    get_current_user,
)
from app.db.session import get_db
from app.routers.migrated._restrito import is_conformidade

router = APIRouter()


# ══════════════════════════════════════════════════════════════════════════════
# Permissões (réplica de src/lib/permissions.ts — cópia local, como nos irmãos)
# ══════════════════════════════════════════════════════════════════════════════


def _is_conformidade(role: str) -> bool:
    """``isConformidade(role)`` — ADMIN, LIDER, SGI."""
    return role in ROLES_CONFORMIDADE


def _pode_gerenciar_documentos_habilitacao(role: str) -> bool:
    """``podeGerenciarDocumentosHabilitacao(role)`` (permissions.ts:120).

    isConformidade(role) || role === ORCAMENTISTA || role === TECNICO.
    Cópia local idêntica à de ``conf_cofre_documentos.py:98``.
    """
    return _is_conformidade(role) or role == ROLE_ORCAMENTISTA or role == ROLE_TECNICO


# ══════════════════════════════════════════════════════════════════════════════
# Serialização (cópia local — origem: conf_cofre_documentos.py:117)
# ══════════════════════════════════════════════════════════════════════════════


def _js_to_iso_string(dt) -> str | None:
    """Replica ``new Date(dt).toISOString()`` (UTC, milissegundos, sufixo 'Z')."""
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


# ══════════════════════════════════════════════════════════════════════════════
# Validação (réplica de VerificarDuplicatasSchema — mensagens do Zod v4.4.3)
# ══════════════════════════════════════════════════════════════════════════════

# SHA-256 em hex MINÚSCULO, 64 caracteres (o que crypto.subtle produz).
_SHA256_REGEX = re.compile(r"^[0-9a-f]{64}$")

# Mensagens CUSTOM do schema, copiadas LITERALMENTE (acento e pontuação inclusos).
_MSG_SHA = (
    "Hash inválido. Informe o SHA-256 com 64 caracteres hexadecimais minúsculos."
)
_MSG_MIN = "Informe ao menos um hash"
_MSG_MAX = "Máximo de 50 hashes por chamada"
_MIN_SHAS = 1
_MAX_SHAS = 50


def _js_tipo(valor: Any) -> str:
    """Nome do tipo no estilo JS (p/ 'received <tipo>' das mensagens do Zod v4)."""
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
    return f"Invalid input: expected {esperado}, received {_js_tipo(valor)}"


def _validar_body(body: Any) -> dict[str, Any]:
    """Valida ``{sha256: string[]}``. Retorna {data} ou {__erros__} (path→msg).

    Réplica de ``z.array(...).min(1, "…").max(50, "…")`` do Zod v4.4.3, com as
    duas manias que só aparecem executando o schema:

    1. Item inválido e array grande demais coexistem: o Zod valida os ELEMENTOS
       primeiro e roda os checks de tamanho DEPOIS, então um lote de 51 com um
       hash ruim devolve ``sha256.50`` **e** ``sha256`` no mesmo ``detalhes``.
    2. Quando ``sha256`` NÃO é array, o Zod v4 emite a issue de TIPO e, se o
       valor tiver ``.length`` (ou seja, string), AINDA roda ``.min()``/``.max()``
       sobre esse length. Como ``formatZodErrors`` (cofre/validations.ts:136) é
       um reduce ``acc[path] = issue.message``, a ÚLTIMA issue do mesmo path
       vence — então a mensagem de TAMANHO ganha da de tipo quando dispara.
       Medido contra o zod 4.4.3 de ``app/node_modules`` rodando o
       ``VerificarHashesSchema`` real:
         ``""``            → "Informe ao menos um hash"        (tipo + min)
         ``"a"``..50 chars → "…expected array, received string" (só tipo)
         51+ chars         → "Máximo de 50 hashes por chamada"  (tipo + max)
         ``5`` / ``{}`` / ``null`` → só a de tipo (não têm length)
    """
    if not isinstance(body, dict):
        return {"__erros__": {"": _zod_expected("object", body)}}

    if "sha256" not in body:
        return {
            "__erros__": {
                "sha256": "Invalid input: expected array, received undefined"
            }
        }

    shas = body["sha256"]

    if not isinstance(shas, list):
        # Não-array: começa na mensagem de TIPO e, para string, deixa o
        # min/max sobrescrever (mania 2 do docstring — last-wins do
        # formatZodErrors). Só string tem ``.length`` no JSON.
        msg = _zod_expected("array", shas)
        if isinstance(shas, str):
            if len(shas) < 1:
                msg = _MSG_MIN
            elif len(shas) > _MAX_SHAS:
                msg = _MSG_MAX
        return {"__erros__": {"sha256": msg}}

    erros: dict[str, str] = {}
    for i, s in enumerate(shas):
        if not isinstance(s, str):
            erros[f"sha256.{i}"] = _zod_expected("string", s)
        elif not _SHA256_REGEX.match(s):
            erros[f"sha256.{i}"] = _MSG_SHA

    if len(shas) < _MIN_SHAS:
        erros["sha256"] = _MSG_MIN
    elif len(shas) > _MAX_SHAS:
        erros["sha256"] = _MSG_MAX

    if erros:
        return {"__erros__": erros}
    return {"data": shas}


def _json_loads_js(bruto: bytes) -> Any:
    """``JSON.parse`` do JS: ``NaN``/``Infinity`` NUS são erro de sintaxe.

    O ``json.loads`` do Python aceita os três literais por padrão; sem este
    hook, um body ``{"sha256": NaN}`` daria 422 aqui e 400 ("JSON inválido")
    no Next.
    """

    def _rejeita(_constante: str):
        raise ValueError("constante JSON não permitida (NaN/Infinity)")

    return _json.loads(bruto, parse_constant=_rejeita)


# ══════════════════════════════════════════════════════════════════════════════
# POST — consulta de duplicata por hash (== handler POST do route.ts)
# ══════════════════════════════════════════════════════════════════════════════


@router.post("/api/conformidade/cofre/documentos/verificar")
async def verificar_duplicatas(
    request: Request,
    # requireAuth() → 401. O papel é checado À MÃO logo abaixo para reproduzir o
    # 403 SEM ``code`` do Next (ver bloco GUARDS do docstring do módulo).
    user: CurrentUser = Depends(get_current_user),
    db=Depends(get_db),
) -> JSONResponse:
    """Diz quais dos hashes enviados já estão no cofre (e em que operação).

    Ordem das checagens (igual ao Next):
      1. requireAuth() → 401 (via get_current_user).
      2. podeGerenciarDocumentosHabilitacao(role) → 403 ``Permissão negada``.
      3. body JSON → 400 ``JSON inválido``.
      4. VerificarDuplicatasSchema → 422 ``Dados inválidos`` + detalhes.
      5. SELECT por sha256 → 200 com o mapa dos que existem.
    """
    if not _pode_gerenciar_documentos_habilitacao(user.role):
        return JSONResponse(status_code=403, content={"error": "Permissão negada"})

    try:
        body = _json_loads_js(await request.body())
    except Exception:  # noqa: BLE001 — JSON malformado
        return JSONResponse(status_code=400, content={"error": "JSON inválido"})

    parsed = _validar_body(body)
    if parsed.get("__erros__"):
        return JSONResponse(
            status_code=422,
            content={"error": "Dados inválidos", "detalhes": parsed["__erros__"]},
        )
    shas: list[str] = parsed["data"]

    rows = (
        await db.execute(
            text(
                """
                SELECT
                  d.sha256    AS sha256,
                  d.id        AS id,
                  d.titulo    AS titulo,
                  d.criado_em AS criado_em,
                  d.restrito  AS restrito,
                  o.codigo    AS operacao_codigo
                FROM documentos_habilitacao d
                LEFT JOIN operacoes o ON o.id = d.operacao_id
                WHERE d.sha256 = ANY(CAST(:shas AS text[]))
                ORDER BY d.criado_em ASC, d.id ASC
                """
            ),
            {"shas": shas},
        )
    ).mappings().all()

    eh_conf = is_conformidade(user.role)

    existentes: dict[str, Any] = {}
    for r in rows:
        sha = r["sha256"]
        # Primeira ocorrência vence (ORDER BY criado_em ASC) → aponta o ORIGINAL.
        if sha in existentes:
            continue
        if r["restrito"] and not eh_conf:
            # Entrada CEGA (0034/R5): duplicata sinalizada, metadado não vaza —
            # o uploader não pode ler o título de um contrato restrito, mas também
            # não pode subir a cópia. MESMA ordem de chaves do ramo pleno.
            existentes[sha] = {
                "id": str(r["id"]),
                "restrito": True,
                "titulo": None,
                "criadoEm": None,
                "operacaoCodigo": None,
            }
        else:
            existentes[sha] = {
                "id": str(r["id"]),
                "restrito": r["restrito"],
                "titulo": r["titulo"],
                "criadoEm": _js_to_iso_string(r["criado_em"]),
                "operacaoCodigo": r["operacao_codigo"],
            }

    return JSONResponse(content={"existentes": existentes})
