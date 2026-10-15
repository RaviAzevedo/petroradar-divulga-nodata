"""Rota migrada (strangler-fig): POST /api/conformidade/cofre/documentos/vincular-operacao.

Espelho 1:1 de
``app/src/app/api/conformidade/cofre/documentos/vincular-operacao/route.ts`` —
ADOÇÃO EM LOTE (B3, 02-APIS §10): vincula documentos ÓRFÃOS a UMA operação.
Nasceu na 0034; é o gesto que dá lar aos atestados que ficaram sem operação.

REGRA CENTRAL (ADR-04): só preenche onde ``operacao_id IS NULL`` — documento já
vinculado é PULADO, nunca sobrescrito (sobrescrever é ato unitário e consciente
via PATCH /cofre/documentos/[id]). A regra é repetida NO BANCO (``AND
operacao_id IS NULL`` no UPDATE): numa corrida entre duas adoções, a segunda
afeta 0 linhas e ``vinculados`` vem do rowcount, não da classificação.

──────────────────────────────────────────────────────────────────────────────
GUARD
──────────────────────────────────────────────────────────────────────────────
``requireAuth()`` (SÓ 401) e SÓ DEPOIS a checagem MANUAL
``podeGerenciarDocumentosHabilitacao(role)`` = {ADMIN, LIDER, SGI, ORCAMENTISTA,
TECNICO} — adoção em lote é gesto de quem sobe documento (matriz §3.1).
  401 ``{"error":"Não autenticado","code":"UNAUTHENTICATED"}``
  403 ``{"error":"Permissão negada"}``  ← SEM ``code`` (checagem inline).

──────────────────────────────────────────────────────────────────────────────
ORDEM dos gates (02-APIS §10.3)
──────────────────────────────────────────────────────────────────────────────
  1. requireAuth                        → 401
  2. podeGerenciarDocumentosHabilitacao → 403 (sem code)
  3. request.json()                     → 400 {"error":"JSON inválido"}
  4. zod (precedência: issue com path começando em ``ids`` vira o 422 FIXO
     {"error":"Esperado { ids: string[] } com 1 a 200 itens"} SEM detalhes;
     o resto cai no 422 padrão com formatZodErrors)
  5. operacaoId não resolve             → 422 {"error":"Operação não encontrada",
                                               "code":"OPERACAO_NAO_ENCONTRADA"}
  6. SELECT dos docs → classifica NA ORDEM dos ids do request → UPDATE em lote
     → audit → 200 {"ok":true,"vinculados":N,"pulados":[{id,motivo}]}

Motivos de ``pulados`` (a ordem da lista é contrato):
  NAO_ENCONTRADO — id não retornou do SELECT;
  RESTRITO       — documento restrito e requisitante fora de Conformidade;
  JA_VINCULADO   — ``operacao_id`` já preenchido (nunca sobrescreve).
``pulados`` vazio → ``[]`` (nunca omitido).
"""

from __future__ import annotations

import json as _json
import re
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
from app.services.audit import registrar_audit

router = APIRouter()

# Papel da prova NA operação (tupla de src/lib/conformidade/operacoes.ts — a
# ordem entra na mensagem de enum do Zod).
_PAPEIS = ("ATESTADO", "CAT_ART", "CONTRATO", "ADITIVO",
           "NOTA_FISCAL", "DECLARACAO", "OUTRO")

_MSG_IDS_FIXA = "Esperado { ids: string[] } com 1 a 200 itens"
_MAX_IDS = 200

# Regex LITERAL do ``z.string().uuid()`` do Zod v4.4.3 (padrão dos irmãos).
_UUID_ZOD_REGEX = re.compile(
    r"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}"
    r"-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000"
    r"|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
)


def _pode_gerenciar_documentos_habilitacao(role: str) -> bool:
    """``podeGerenciarDocumentosHabilitacao(role)`` (permissions.ts:120)."""
    return (
        role in ROLES_CONFORMIDADE
        or role == ROLE_ORCAMENTISTA
        or role == ROLE_TECNICO
    )


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


def _zod_enum_msg(valores: tuple[str, ...]) -> str:
    return "Invalid option: expected one of " + "|".join(f'"{v}"' for v in valores)


def _json_loads_js(bruto: bytes) -> Any:
    """``JSON.parse`` do JS: ``NaN``/``Infinity`` NUS são erro de sintaxe."""

    def _rejeita(_constante: str):
        raise ValueError("constante JSON não permitida (NaN/Infinity)")

    return _json.loads(bruto, parse_constant=_rejeita)


def _validar_vincular(body: Any) -> dict[str, Any]:
    """Réplica de ``VincularOperacaoEmLoteSchema.safeParse`` + o MAPEAMENTO de
    erro do handler (§10.2): retorna ``{data}``, ``{__ids__: True}`` (422 fixo)
    ou ``{__erros__}`` (422 padrão). Precedência: ids vence.
    """
    if not isinstance(body, dict):
        # z.object sobre não-objeto → issue no path raiz "" (não começa em ids).
        return {"__erros__": {"": _zod_expected("object", body)}}

    erros: dict[str, str] = {}
    ids_falhou = False
    out: dict[str, Any] = {}

    # ids: z.array(uuidSchema).min(1).max(200) — QUALQUER issue neste path
    # (ausente, tipo, item, tamanho) dispara o 422 fixo do handler.
    ids = body.get("ids")
    if not isinstance(ids, list):
        ids_falhou = True
    else:
        if len(ids) < 1 or len(ids) > _MAX_IDS:
            ids_falhou = True
        for i in ids:
            if not isinstance(i, str) or not _UUID_ZOD_REGEX.match(i):
                ids_falhou = True
                break
        out["ids"] = ids

    # operacaoId: uuidSchema (obrigatório) — ausente é erro de TIPO (undefined).
    if "operacaoId" not in body:
        erros["operacaoId"] = "Invalid input: expected string, received undefined"
    else:
        op = body["operacaoId"]
        if not isinstance(op, str):
            erros["operacaoId"] = _zod_expected("string", op)
        elif not _UUID_ZOD_REGEX.match(op):
            erros["operacaoId"] = "ID inválido"
        else:
            out["operacaoId"] = op

    # papel: z.enum(PAPEIS_DOCUMENTO).optional() — null NÃO é aceito (erro de enum).
    if "papel" in body:
        if body["papel"] not in _PAPEIS:
            erros["papel"] = _zod_enum_msg(_PAPEIS)
        else:
            out["papel"] = body["papel"]

    if ids_falhou:
        return {"__ids__": True}
    if erros:
        return {"__erros__": erros}
    return {"data": out}


@router.post("/api/conformidade/cofre/documentos/vincular-operacao")
async def vincular_operacao_em_lote(
    request: Request,
    # requireAuth() → 401; papel checado À MÃO para o 403 SEM code.
    user: CurrentUser = Depends(get_current_user),
    db=Depends(get_db),
) -> JSONResponse:
    """Adota documentos órfãos por uma operação (nunca sobrescreve vínculo)."""
    if not _pode_gerenciar_documentos_habilitacao(user.role):
        return JSONResponse(status_code=403, content={"error": "Permissão negada"})

    try:
        body = _json_loads_js(await request.body())
    except Exception:  # noqa: BLE001 — JSON malformado
        return JSONResponse(status_code=400, content={"error": "JSON inválido"})

    parsed = _validar_vincular(body)
    if parsed.get("__ids__"):
        return JSONResponse(status_code=422, content={"error": _MSG_IDS_FIXA})
    if parsed.get("__erros__"):
        return JSONResponse(
            status_code=422,
            content={"error": "Dados inválidos", "detalhes": parsed["__erros__"]},
        )
    data = parsed["data"]
    ids: list[str] = data["ids"]
    operacao_id: str = data["operacaoId"]
    papel: str | None = data.get("papel")

    # ── Gate 5: a operação-alvo tem de existir. ───────────────────────────────
    existe = (
        await db.execute(
            text("SELECT 1 FROM operacoes WHERE id = CAST(:operacao_id AS uuid)"),
            {"operacao_id": operacao_id},
        )
    ).first()
    if existe is None:
        return JSONResponse(
            status_code=422,
            content={
                "error": "Operação não encontrada",
                "code": "OPERACAO_NAO_ENCONTRADA",
            },
        )

    # ── Passo 6.1: estado atual dos documentos pedidos. ───────────────────────
    rows = (
        await db.execute(
            text(
                "SELECT id, operacao_id, restrito FROM documentos_habilitacao "
                "WHERE id = ANY(CAST(:ids AS uuid[]))"
            ),
            {"ids": ids},
        )
    ).mappings().all()
    # O Postgres normaliza o uuid para minúsculo — indexamos pelo texto
    # canônico e consultamos com ``lower()`` para o id do request casar.
    por_id = {str(r["id"]): r for r in rows}

    eh_conf = is_conformidade(user.role)

    # ── Passo 6.2: classifica NA ORDEM dos ids do request (ordem é contrato). ──
    pulados: list[dict[str, str]] = []
    aprovados: list[str] = []
    for pid in ids:
        r = por_id.get(pid.lower())
        if r is None:
            pulados.append({"id": pid, "motivo": "NAO_ENCONTRADO"})
        elif r["restrito"] and not eh_conf:
            # Restrito é invisível fora de Conformidade — pular sem revelar mais.
            pulados.append({"id": pid, "motivo": "RESTRITO"})
        elif r["operacao_id"] is not None:
            pulados.append({"id": pid, "motivo": "JA_VINCULADO"})
        else:
            aprovados.append(pid)

    # ── Passo 6.3: UM UPDATE só, com a regra repetida no banco. ───────────────
    vinculados = 0
    if aprovados:
        set_papel = ", papel = :papel" if papel is not None else ""
        res = await db.execute(
            text(
                f"""
                UPDATE documentos_habilitacao
                SET operacao_id = CAST(:operacao_id AS uuid){set_papel},
                    atualizado_por = CAST(:user_id AS uuid),
                    atualizado_em = now()
                WHERE id = ANY(CAST(:ids AS uuid[])) AND operacao_id IS NULL
                """
            ),
            {
                "operacao_id": operacao_id,
                "user_id": user.id,
                "ids": aprovados,
                **({"papel": papel} if papel is not None else {}),
            },
        )
        vinculados = res.rowcount or 0

    detalhes_audit: dict[str, Any] = {
        "operacaoId": operacao_id,
        "ids": ids,
        "vinculados": vinculados,
        "pulados": pulados,
    }
    if papel is not None:
        detalhes_audit["papel"] = papel

    await registrar_audit(
        db,
        user_id=user.id,
        acao="VINCULAR_OPERACAO_EM_LOTE",
        entidade="documento_habilitacao",
        entidade_id=None,
        detalhes=detalhes_audit,
    )

    await db.commit()

    return JSONResponse(
        content={"ok": True, "vinculados": vinculados, "pulados": pulados}
    )
