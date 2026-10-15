"""Rota migrada (strangler-fig): /api/admin/users.

Espelho 1:1 de ``src/app/api/admin/users/route.ts`` (Next.js) — paridade de
resposta com o BFF FastAPI.

Métodos (iguais ao Next):
  - GET  /api/admin/users — Lista TODOS os usuários (incl. inativos) p/ o painel
        de admin. Guard: ``requireAdmin`` → :data:`require_admin`.
        Projeção: id, nome, email, role, ativo, criadoEm.
        Ordem: ``criado_em DESC`` (desc(users.criadoEm)).
        Shape: ``{ "users": [...] }`` (NÃO usa ``{data}``).

  - POST /api/admin/users — Cria novo usuário. Guard: ``requireAdmin``.
        Body JSON: { nome?, email, senha, role }.
        Validações (mesma ORDEM, mesmos status/mensagens do Next):
          * JSON inválido            → 400 { error: "JSON inválido" }
          * faltam email|senha|role  → 422 { error: "Campos obrigatórios: email, senha, role" }
          * email regex falha        → 422 { error: "Email inválido" }
          * senha < 8                → 422 { error: "Senha deve ter ao menos 8 caracteres" }
          * role fora de ROLES       → 422 { error: "Role inválido" }
        Hash da senha: bcrypt com cost 12 (espelha ``bcrypt.hash(senha, 12)`` do
        ``bcryptjs`` — gera ``$2b$12$...``, verificável pelo bcryptjs no Next).
        INSERT em ``users`` (email, nome, password_hash, role, ativo=true)
        com RETURNING id, email, nome, role.
        Sucesso: 201 com o objeto cru ``{ id, email, nome, role }`` (SEM ``{data}``).
        Email duplicado (unique violation) → 409 { error: "Email já cadastrado" }.

Serialização (paridade JSON):
  - ``id`` (uuid) → str (o Drizzle/pg devolve uuid como string).
  - ``criado_em`` (timestamp s/ timezone) → ISO via ``isoformat()``.
  - ``ativo`` (boolean) → bool.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.core.security import (
    ALL_ROLES,
    CurrentUser,
    require_admin,
)
from app.db.session import get_db

router = APIRouter()

# Deriva a lista de roles válidos do enum canônico ROLES (inclui SGI) — espelha
# ``ROLES_VALIDOS = Object.values(ROLES)`` do Next (que usa o ROLES de
# permissions.ts). ALL_ROLES já replica ROLES fielmente (7 papéis, incl. SGI).
ROLES_VALIDOS: tuple[str, ...] = ALL_ROLES

# Mesmo regex de e-mail da rota Next: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
import re as _re

_EMAIL_RE = _re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def _jsonable(value):
    """Normaliza um valor de coluna para algo JSON-serializável (paridade Next).

    - ``UUID``      → ``str`` (uuid → string, igual ao Drizzle/pg).
    - ``datetime``  → ISO 8601 via ``isoformat()`` (``criado_em``).
    - ``date``      → ISO 8601 via ``isoformat()``.
    - ``Decimal``   → ``float`` (numeric → number).
    - bool/int/str/None já são serializáveis.
    """
    if value is None:
        return None
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


def _linha(row) -> dict:
    """Converte uma Row do SQLAlchemy num dict com valores JSON-ready."""
    return {chave: _jsonable(valor) for chave, valor in row._mapping.items()}


@router.get("/api/admin/users")
async def listar_users(
    request: Request,
    user: CurrentUser = Depends(require_admin),
    db=Depends(get_db),
):
    """GET /api/admin/users — lista TODOS os usuários (incl. inativos).

    Guard ``requireAdmin`` (apenas ADMIN). Replica a query Drizzle:

        db.select({ id, nome, email, role, ativo, criadoEm })
          .from(users)
          .orderBy(desc(users.criadoEm))

    e o shape ``{ "users": [...] }``.
    """
    sql = text(
        """
        SELECT
            id        AS "id",
            nome      AS "nome",
            email     AS "email",
            role      AS "role",
            ativo     AS "ativo",
            criado_em AS "criadoEm"
        FROM users
        ORDER BY criado_em DESC
        """
    )
    result = await db.execute(sql)
    lista = [_linha(row) for row in result.all()]
    return JSONResponse(content={"users": lista})


@router.post("/api/admin/users")
async def criar_user(
    request: Request,
    user: CurrentUser = Depends(require_admin),
    db=Depends(get_db),
):
    """POST /api/admin/users — cria novo usuário (espelha o POST do Next)."""
    # ── Body JSON (mesmo tratamento de "JSON inválido" → 400) ─────────────────
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(content={"error": "JSON inválido"}, status_code=400)

    if not isinstance(body, dict):
        # O Next desestrutura ``const { nome, email, senha, role } = body``; um
        # body não-objeto resulta em campos undefined → cai na validação 422
        # abaixo. Normaliza para dict vazio p/ replicar esse comportamento.
        body = {}

    nome = body.get("nome")
    email = body.get("email")
    senha = body.get("senha")
    role = body.get("role")

    # ── Validações (MESMA ORDEM e status/mensagens do Next) ───────────────────
    if not email or not senha or not role:
        return JSONResponse(
            content={"error": "Campos obrigatórios: email, senha, role"},
            status_code=422,
        )
    if not (isinstance(email, str) and _EMAIL_RE.match(email)):
        return JSONResponse(content={"error": "Email inválido"}, status_code=422)
    if not (isinstance(senha, str) and len(senha) >= 8):
        return JSONResponse(
            content={"error": "Senha deve ter ao menos 8 caracteres"},
            status_code=422,
        )
    if role not in ROLES_VALIDOS:
        return JSONResponse(content={"error": "Role inválido"}, status_code=422)

    # ── Hash bcrypt cost 12 (espelha bcrypt.hash(senha, 12) do bcryptjs) ──────
    # Import local: bcrypt só é necessário no caminho de criação; produz
    # ``$2b$12$...``, formato que o bcryptjs do Next verifica sem problemas.
    import bcrypt

    password_hash = bcrypt.hashpw(
        senha.encode("utf-8"), bcrypt.gensalt(rounds=12)
    ).decode("utf-8")

    # ── INSERT com RETURNING (id, email, nome, role) ──────────────────────────
    # ``nome || null`` do Next: string vazia/None vira NULL.
    nome_val = nome if nome else None

    sql = text(
        """
        INSERT INTO users (email, nome, password_hash, role, ativo)
        VALUES (:email, :nome, :password_hash, :role, true)
        RETURNING
            id    AS "id",
            email AS "email",
            nome  AS "nome",
            role  AS "role"
        """
    )
    try:
        result = await db.execute(
            sql,
            {
                "email": email,
                "nome": nome_val,
                "password_hash": password_hash,
                "role": role,
            },
        )
        row = result.first()
        await db.commit()
    except IntegrityError as exc:
        # Violação de unique (email) → 409, igual ao ramo do Next que checa
        # ``e.message.includes("unique")``.
        await db.rollback()
        if "unique" in str(exc.orig).lower() or "unique" in str(exc).lower():
            return JSONResponse(
                content={"error": "Email já cadastrado"}, status_code=409
            )
        # Erro inesperado → 500 (espelha handleApiError → "Erro interno").
        return JSONResponse(content={"error": "Erro interno"}, status_code=500)
    except Exception:
        await db.rollback()
        return JSONResponse(content={"error": "Erro interno"}, status_code=500)

    novo = _linha(row)
    return JSONResponse(content=novo, status_code=201)
