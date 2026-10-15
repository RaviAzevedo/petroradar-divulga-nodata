"""Rota migrada (strangler-fig): PATCH/DELETE /api/admin/users/{id}.

Espelho 1:1 de ``src/app/api/admin/users/[id]/route.ts`` (Next.js) — paridade de
resposta com o BFF FastAPI.

A rota Next expõe SOMENTE dois métodos:

  - ``PATCH /api/admin/users/[id]`` — atualiza nome, role, ativo e/ou senha.
    Mexer em ``ativo`` também mantém o rastro ``desativado_em`` (false → now();
    true → NULL), igual ao Next.
  - ``DELETE /api/admin/users/[id]`` — soft-delete (marca ``ativo=false`` e
    carimba ``desativado_em``; NÃO remove a linha do banco).

Não há ``GET``/``POST``/``PUT`` neste arquivo do Next, portanto não migramos.

GUARD (idêntico ao Next — ``requireAdmin()`` chamado DENTRO do handler, em
try/catch que converte para ``handleApiError``):
    ``requireAdmin()`` → ``requireAuth()`` (401 ``{error:"Não autenticado",
    code:"UNAUTHENTICATED"}`` se sem sessão) + ``isAdmin(role)`` (403
    ``{error:"Apenas administrador", code:"FORBIDDEN"}`` se role != ADMIN).

    Replicamos a ORDEM do Next: o guard roda ANTES de ``await params`` e do parse
    do body. Como o Next chama o guard manualmente (não como middleware), e o
    ``handleApiError`` produz o shape ``{error, code}`` (DIFERENTE do ``{detail}``
    default do FastAPI), NÃO usamos ``Depends(require_admin)`` — chamamos
    ``get_current_user`` à mão e checamos ``ROLE_ADMIN``, devolvendo o MESMO shape
    ``{error, code}`` que o ``handleApiError`` do Next devolve.

SHAPE de erro (paridade exata com o Next):
    - 401/403  → ``{"error": <msg>, "code": <code>}`` (via handleApiError).
    - 400/404/422 do corpo → ``{"error": <msg>}`` (SEM ``code``; é o
      ``NextResponse.json({error:...})`` direto da rota).

SERIALIZAÇÃO (paridade JSON com o Drizzle/pg via ``.returning({...})``):
    O Next devolve apenas ``{id, email, nome, role, ativo}`` (projeção do
    ``.returning``). ``id`` é uuid (Drizzle → string); ``ativo`` é boolean;
    demais são text. Convertemos uuid→str para casar.

SENHA: o Next faz ``bcrypt.hash(senha, 12)`` (cost 12) e grava em
``password_hash``. Replicamos com ``bcrypt`` (cost 12) — mesmo algoritmo do
bcryptjs (formato ``$2`` compatível).
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.revocation import revoke_all_for_user
from app.core.security import ROLE_ADMIN, get_current_user
from app.db.session import get_db

router = APIRouter()

# Lista canônica de roles válidos (espelha ``ROLES_VALIDOS = Object.values(ROLES)``
# da rota Next — inclui SGI). Deriva do enum canônico para não divergir do
# sistema de permissões. (Os 7 papéis de permissions.ts.)
ROLES_VALIDOS: tuple[str, ...] = (
    "ADMIN",
    "LIDER",
    "ORCAMENTISTA",
    "TECNICO",
    "SGI",
    "VISUALIZADOR",
    "EXTERNO",
)


class _ApiError(Exception):
    """Espelha a ``ApiError`` de ``src/lib/api/guards.ts`` (status + code + msg)."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _handle_api_error(err: Exception) -> JSONResponse:
    """Espelha ``handleApiError`` do Next: ApiError → ``{error, code}``; resto → 500.

    O shape de erro do guard no Next é ``{"error": <msg>, "code": <code>}`` (NÃO o
    ``{detail}`` default do FastAPI). Erros inesperados viram 500 ``{error:"Erro
    interno"}`` (mesma string do Next).
    """
    if isinstance(err, _ApiError):
        return JSONResponse(
            content={"error": err.message, "code": err.code},
            status_code=err.status,
        )
    return JSONResponse(content={"error": "Erro interno"}, status_code=500)


async def _require_admin(request: Request):
    """Espelha ``requireAdmin()`` de guards.ts: 401 sem sessão, 403 se não-ADMIN.

    Retorna o ``CurrentUser`` validado (para o ``session.user.id`` dos
    anti-self-lockout). Levanta ``_ApiError`` (capturada pelo handler → mesmo
    shape ``{error, code}`` do ``handleApiError`` do Next).
    """
    try:
        user = await get_current_user(request)
    except Exception as exc:
        # ``requireAuth()`` joga ApiError(401, "UNAUTHENTICATED", "Não autenticado")
        # quando não há sessão. Qualquer falha de auth (token ausente/inválido/
        # expirado/revogado) cai aqui e vira o mesmo 401 do Next.
        raise _ApiError(401, "UNAUTHENTICATED", "Não autenticado") from exc

    # ``requireAdmin()``: isAdmin(role) — role normalizado == ADMIN.
    if user.role != ROLE_ADMIN:
        raise _ApiError(403, "FORBIDDEN", "Apenas administrador")
    return user


def _serialize_returning(row) -> dict:
    """Monta ``{id, email, nome, role, ativo}`` do ``.returning`` (paridade Drizzle).

    O Next projeta exatamente essas 5 colunas. ``id`` (uuid) vira string como no
    Drizzle/pg; ``ativo`` boolean; demais text (ou null).
    """
    m = row._mapping
    id_val = m["id"]
    return {
        "id": str(id_val) if isinstance(id_val, UUID) else id_val,
        "email": m["email"],
        "nome": m["nome"],
        "role": m["role"],
        "ativo": m["ativo"],
    }


@router.patch("/api/admin/users/{id}")
async def patch_user(
    id: str, request: Request, db=Depends(get_db)
) -> JSONResponse:
    """PATCH /api/admin/users/{id} — atualiza nome/role/ativo/senha (paridade 1:1).

    Ordem EXATA do Next:
      1. ``requireAdmin()`` (401/403 via handleApiError → ``{error, code}``).
      2. ``await params`` (id).
      3. parse do body (400 ``{error:"JSON inválido"}`` se inválido).
      4. anti-self-lockout (própria conta: não desativa / não muda próprio role).
      5. valida role (422 se fora de ROLES_VALIDOS).
      6. monta ``updates`` (só campos presentes); ``ativo`` também seta
         ``desativado_em`` (false → now(); senão NULL); senha → bcrypt(12) em
         password_hash (422 se < 8 chars).
      7. 400 se nenhum campo para atualizar.
      8. UPDATE ... RETURNING; 404 se não encontrou.
      9. 200 com a linha atualizada (sem envelope).
    """
    # 1) Guard — fora do try do corpo; converte ApiError → {error, code}.
    try:
        user = await _require_admin(request)
    except _ApiError as e:
        return _handle_api_error(e)

    # 2) params.id já chega como path param (id).

    # 3) Body — JSON; erro de parse → 400 {error:"JSON inválido"}.
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(content={"error": "JSON inválido"}, status_code=400)
    if not isinstance(body, dict):
        # ``await req.json()`` no Next aceita só objeto p/ os acessos ``body.x``;
        # um JSON não-objeto faria os campos virarem undefined. Tratamos como dict
        # vazio para preservar o fluxo (cai no 400 "Nenhum campo para atualizar").
        body = {}

    nome = body.get("nome")
    role = body.get("role")
    ativo = body.get("ativo")
    senha = body.get("senha")

    # 4) Anti-self-lockout — o próprio admin não se desativa nem se rebaixa.
    if id == user.id:
        if ativo is False:
            return JSONResponse(
                content={"error": "Não é possível desativar sua própria conta"},
                status_code=400,
            )
        if role and role != "ADMIN":
            return JSONResponse(
                content={"error": "Não é possível alterar seu próprio role"},
                status_code=400,
            )

    # 5) Role inválido → 422.
    if role and role not in ROLES_VALIDOS:
        return JSONResponse(content={"error": "Role inválido"}, status_code=422)

    # 6) Monta updates (só campos !== undefined, igual ao Next).
    updates: dict = {}
    if "nome" in body:
        updates["nome"] = nome
    if "role" in body:
        updates["role"] = role
    if "ativo" in body:
        updates["ativo"] = ativo
        # Rastro do soft-delete (0017, espelha o Next): desativar (ativo===false)
        # carimba desativado_em = agora; qualquer outro valor (reativar) limpa.
        updates["desativado_em"] = (
            datetime.now(timezone.utc) if ativo is False else None
        )
    if senha:
        # body.senha truthy (no Next: ``if (body.senha)`` — string vazia é falsy).
        if isinstance(senha, str) and len(senha) < 8:
            return JSONResponse(
                content={"error": "Senha deve ter ao menos 8 caracteres"},
                status_code=422,
            )
        updates["password_hash"] = _bcrypt_hash(senha)

    # 7) Nenhum campo → 400.
    if len(updates) == 0:
        return JSONResponse(
            content={"error": "Nenhum campo para atualizar"}, status_code=400
        )

    # 8) UPDATE ... RETURNING {id,email,nome,role,ativo}.
    set_cols = ", ".join(f"{col} = :{col}" for col in updates)
    sql = text(
        f"""
        UPDATE users
        SET {set_cols}
        WHERE id = :__id
        RETURNING id AS "id",
                  email AS "email",
                  nome AS "nome",
                  role AS "role",
                  ativo AS "ativo"
        """
    )
    result = await db.execute(sql, {**updates, "__id": id})
    row = result.first()
    if row is None:
        # Nada atualizado → usuário não encontrado (não há nada a persistir).
        return JSONResponse(
            content={"error": "Usuário não encontrado"}, status_code=404
        )
    await db.commit()

    # ── PRODUTOR da revogação (Decisão 4 / WIRING #4) ─────────────────────────
    # Desativar (ativo=false), rebaixar/trocar role ou trocar a senha deve ter
    # efeito IMEDIATO nas sessões existentes: grava o corte por usuário no Redis
    # db2 (auth:revogado:user:<id>) — o get_current_user do BFF rejeita tokens
    # com iat anterior ao corte. Roda APÓS o commit (não revoga sem persistir).
    if updates.get("ativo") is False or "role" in updates or "password_hash" in updates:
        await revoke_all_for_user(id)

    return JSONResponse(content=_serialize_returning(row))


@router.delete("/api/admin/users/{id}")
async def delete_user(
    id: str, request: Request, db=Depends(get_db)
) -> JSONResponse:
    """DELETE /api/admin/users/{id} — soft-delete (ativo=false) (paridade 1:1).

    Ordem EXATA do Next:
      1. ``requireAdmin()`` (401/403 via handleApiError → ``{error, code}``).
      2. ``await params`` (id).
      3. anti-self-lockout: admin não desativa a própria conta (400).
      4. UPDATE users SET ativo=false, desativado_em=now() ... RETURNING;
         404 se não encontrou.
      5. 200 com a linha atualizada (sem envelope).
    """
    # 1) Guard.
    try:
        user = await _require_admin(request)
    except _ApiError as e:
        return _handle_api_error(e)

    # 3) Anti-self-lockout.
    if id == user.id:
        return JSONResponse(
            content={"error": "Não é possível desativar sua própria conta"},
            status_code=400,
        )

    # 4) Soft-delete: ativo=false (NÃO remove a linha) + carimbo desativado_em
    #    (rastro de quando a conta foi desativada — 0017, espelha o Next).
    sql = text(
        """
        UPDATE users
        SET ativo = false,
            desativado_em = :__agora
        WHERE id = :__id
        RETURNING id AS "id",
                  email AS "email",
                  nome AS "nome",
                  role AS "role",
                  ativo AS "ativo"
        """
    )
    result = await db.execute(
        sql, {"__id": id, "__agora": datetime.now(timezone.utc)}
    )
    row = result.first()
    if row is None:
        return JSONResponse(
            content={"error": "Usuário não encontrado"}, status_code=404
        )
    await db.commit()

    # PRODUTOR da revogação (Decisão 4): soft-delete derruba as sessões na hora.
    await revoke_all_for_user(id)

    return JSONResponse(content=_serialize_returning(row))


def _bcrypt_hash(senha) -> str:
    """Espelha ``bcrypt.hash(senha, 12)`` do bcryptjs (cost 12).

    Usa o pacote ``bcrypt`` (compatível com bcryptjs: prefixo ``$2`` / ``$2b``,
    cost 12). Import local para não pesar o caminho que não troca senha.

    PARIDADE COM bcryptjs (NÃO coagir não-string):
        No Next, ``bcrypt.hash(senha, 12)`` do bcryptjs valida o tipo internamente:
        se ``typeof senha !== "string"`` (ex.: ``senha`` numérica que passou o
        ``if (body.senha)`` truthy e cujo ``.length`` undefined driblou o 422), o
        promise é REJEITADO com ``Error("Illegal arguments: <tipo>, number")`` —
        ele NÃO coage o número para string. Como a rota Next faz
        ``await bcrypt.hash(...)`` SEM try/catch ao redor, o erro propaga e o Next
        devolve 500, ANTES do UPDATE — sem trocar a senha nem persistir nada.

        Para casar fielmente, NÃO usamos ``str(senha)``: levantamos um erro aqui
        (antes do UPDATE/commit em ``patch_user``), que sobe até o handler global
        do ``main.py`` e vira 500 ``{"error": "Erro interno"}`` — mesmo desfecho do
        Next (sem 200, sem persistência da troca de senha).
    """
    import bcrypt as _bcrypt

    if not isinstance(senha, str):
        # Espelha o branch ``else`` de ``bcrypt.hash`` (bcryptjs): tipo inválido →
        # rejeita em vez de coagir. Mensagem no formato "Illegal arguments: <tipo do
        # password>, number" (o salt no Next é o número 12 → "number").
        raise TypeError(f"Illegal arguments: {type(senha).__name__}, number")
    return _bcrypt.hashpw(senha.encode("utf-8"), _bcrypt.gensalt(12)).decode("utf-8")
