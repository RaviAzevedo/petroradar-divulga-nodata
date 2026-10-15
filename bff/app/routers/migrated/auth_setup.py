"""Rota migrada (strangler-fig): POST /api/auth/setup.

Espelho 1:1 de ``src/app/api/auth/setup/route.ts`` (Next.js) — cria o PRIMEIRO
admin do sistema. NÃO é o handler do NextAuth; é endpoint próprio.

GUARDS (defesa em camadas — MESMA ORDEM do Next):
  1) Em produção, exige ``SETUP_TOKEN`` configurado. Sem ele → 503
     ``{ error: "Setup desabilitado: SETUP_TOKEN não configurado no ambiente." }``.
     Não há "modo aberto" em produção.
  2) Quando ``SETUP_TOKEN`` está configurado, exige header ``x-setup-token``
     válido (comparação constant-time via :func:`_safe_equal`). Inválido → 401
     ``{ error: "Token de setup inválido" }``.
  3) Fail-closed: em produção sem rate-limit distribuído (Upstash/Redis ausente),
     loga ``logger.error`` e nega → 503
     ``{ error: "Setup indisponível: rate limit distribuído não configurado." }``.
  4) Rate limit por IP: 3 tentativas em 15 minutos (chave ``setup:<ip>``).
     Estouro → 429 ``{ error: "Muitas tentativas. Aguarde 15 minutos." }``.
  5) Bloqueia se já existe QUALQUER user com ``role = 'ADMIN'`` (independente de
     hash). Já existe → 403 ``{ error: "Setup já realizado" }``.

CRIAÇÃO DO PRIMEIRO ADMIN (paridade EXATA):
  - Body JSON tolerante (``request.json().catch(() => ({}))``).
  - ``{ email, password, nome }`` desestruturados.
  - ``!email || !password`` → 400 ``{ error: "Email e senha obrigatórios" }``.
  - ``password.length < 8`` → 400
    ``{ error: "Senha deve ter no mínimo 8 caracteres" }``.
  - Hash bcrypt cost 12 (espelha ``bcrypt.hash(password, 12)`` do bcryptjs —
    gera ``$2b$12$...``, verificável pelo bcryptjs no Next).
  - SELECT user por email (limit 1):
      * existe   → UPDATE password_hash = hash, nome = nome || existing.nome,
                   role = 'ADMIN' WHERE id = existing.id.
      * não existe → DELETE WHERE email = 'admin@example.com' (remove
                     placeholder) e INSERT (email, nome=nome||'Admin',
                     password_hash, role='ADMIN').
  - Sucesso: 200 ``{ ok: true, message: "Usuário <email> configurado com sucesso" }``.

NOTAS DE PARIDADE:
  - ``process.env.NODE_ENV`` / ``process.env.SETUP_TOKEN`` são lidos via
    ``settings`` (campos-espelho ``node_env``/``setup_token``, default "" =
    ausente — mesma truthiness do ``process.env`` indefinido).
  - ``safeEqual`` (``src/lib/security/secrets.ts``): SHA-256 dos dois lados +
    ``timingSafeEqual`` → replicado com ``hashlib.sha256`` + ``hmac.compare_digest``.
  - ``isRateLimitDistributed`` / ``rateLimit`` → ``app.core.rate_limit``
    (``is_rate_limit_distributed`` / ``check_rate_limit``). Janela 15 min,
    fail_open por padrão (a porta de segurança real é o Guard 3 acima).
  - ``getClientIp``: primeiro IP do ``x-forwarded-for``; senão ``x-real-ip``;
    senão ``"unknown"`` (réplica literal do helper do Next, NÃO o ``_client_ip``
    do core que cai no peer TCP).
"""

from __future__ import annotations

import hashlib
import hmac

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.config import settings
from app.core.logging import get_logger
from app.core.rate_limit import check_rate_limit, is_rate_limit_distributed
from app.db.session import get_db

router = APIRouter()

logger = get_logger("petro_radar_bff.auth_setup")

# Constantes do rate limit (réplica de RATE_MAX / RATE_WINDOW do Next).
RATE_MAX = 3
RATE_WINDOW = 15 * 60 * 1000  # ms (15 minutos), igual ao Next


def _safe_equal(a: str | None, b: str | None) -> bool:
    """Réplica de ``safeEqual`` (src/lib/security/secrets.ts).

    Compara dois segredos de forma resistente a timing attack: aplica SHA-256
    nos dois lados (comprimento fixo) e usa ``hmac.compare_digest``
    (equivalente ao ``timingSafeEqual`` do Node). ``None`` em qualquer lado → False.
    """
    if a is None or b is None:
        return False
    ha = hashlib.sha256(a.encode("utf-8")).digest()
    hb = hashlib.sha256(b.encode("utf-8")).digest()
    return hmac.compare_digest(ha, hb)


def _get_client_ip(request: Request) -> str:
    """Réplica literal de ``getClientIp`` do route.ts.

    Primeiro IP do ``x-forwarded-for`` (trim); se vazio, ``x-real-ip``; senão
    ``"unknown"``.
    """
    xff = request.headers.get("x-forwarded-for") or ""
    partes = xff.split(",")
    first = partes[0].strip() if partes else ""
    if first:
        return first
    return request.headers.get("x-real-ip") or "unknown"


@router.post("/api/auth/setup")
async def post_setup(request: Request) -> JSONResponse:
    """POST /api/auth/setup — cria o primeiro admin do sistema (espelha o Next)."""
    is_prod = settings.node_env == "production"
    setup_token = settings.setup_token

    # ── Guard 1 — em produção, SETUP_TOKEN é obrigatório ──────────────────────
    if is_prod and not setup_token:
        return JSONResponse(
            {"error": "Setup desabilitado: SETUP_TOKEN não configurado no ambiente."},
            status_code=503,
        )

    # ── Guard 2 — quando SETUP_TOKEN está configurado, exige header (constant-time) ──
    if setup_token:
        provided = request.headers.get("x-setup-token") or ""
        if not _safe_equal(provided, setup_token):
            return JSONResponse({"error": "Token de setup inválido"}, status_code=401)

    # ── Guard 3 — fail-closed: produção sem rate-limit distribuído → nega ─────
    if is_prod and not is_rate_limit_distributed():
        logger.error(
            "Rate limit de setup não distribuído em produção (Upstash ausente) — negando setup"
        )
        return JSONResponse(
            {"error": "Setup indisponível: rate limit distribuído não configurado."},
            status_code=503,
        )

    # ── Guard 4 — rate limit por IP (3 tentativas / 15 min) ───────────────────
    ip = _get_client_ip(request)
    rl = await check_rate_limit(
        key=f"setup:{ip}",
        max_hits=RATE_MAX,
        window_seconds=RATE_WINDOW // 1000,
    )
    if not rl.allowed:
        return JSONResponse(
            {"error": "Muitas tentativas. Aguarde 15 minutos."},
            status_code=429,
        )

    # ── Guard 5 — bloqueia se já existe QUALQUER admin (independente de hash) ──
    async for db in get_db():
        count_sql = text(
            """
            SELECT count(*) AS "count"
            FROM users
            WHERE role = :role
            """
        )
        admins_row = (await db.execute(count_sql, {"role": "ADMIN"})).first()
        admins_count = int(admins_row._mapping["count"]) if admins_row else 0

        if admins_count > 0:
            return JSONResponse({"error": "Setup já realizado"}, status_code=403)

        # ── Cria o primeiro admin ──────────────────────────────────────────────
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001 — espelha o .catch(() => ({})) do Next
            body = {}
        if not isinstance(body, dict):
            # O Next desestrutura ``const { email, password, nome } = body``; um
            # body não-objeto resulta em campos undefined → cai nas validações.
            body = {}

        email = body.get("email")
        password = body.get("password")
        nome = body.get("nome")

        if not email or not password:
            return JSONResponse(
                {"error": "Email e senha obrigatórios"}, status_code=400
            )
        if not (isinstance(password, str) and len(password) >= 8):
            return JSONResponse(
                {"error": "Senha deve ter no mínimo 8 caracteres"}, status_code=400
            )

        # ── Hash bcrypt cost 12 (espelha bcrypt.hash(password, 12) do bcryptjs) ──
        import bcrypt

        hash_ = bcrypt.hashpw(
            password.encode("utf-8"), bcrypt.gensalt(rounds=12)
        ).decode("utf-8")

        existing_sql = text(
            """
            SELECT *
            FROM users
            WHERE email = :email
            LIMIT 1
            """
        )
        existing = (await db.execute(existing_sql, {"email": email})).first()

        if existing:
            existing_map = existing._mapping
            update_sql = text(
                """
                UPDATE users
                SET password_hash = :password_hash,
                    nome = :nome,
                    role = :role
                WHERE id = :id
                """
            )
            await db.execute(
                update_sql,
                {
                    "password_hash": hash_,
                    "nome": nome or existing_map["nome"],
                    "role": "ADMIN",
                    "id": existing_map["id"],
                },
            )
        else:
            # Remove o placeholder, se existir.
            delete_sql = text(
                """
                DELETE FROM users
                WHERE email = :email
                """
            )
            await db.execute(delete_sql, {"email": "admin@example.com"})
            insert_sql = text(
                """
                INSERT INTO users (email, nome, password_hash, role)
                VALUES (:email, :nome, :password_hash, :role)
                """
            )
            await db.execute(
                insert_sql,
                {
                    "email": email,
                    "nome": nome or "Admin",
                    "password_hash": hash_,
                    "role": "ADMIN",
                },
            )

        await db.commit()

        return JSONResponse(
            {"ok": True, "message": f"Usuário {email} configurado com sucesso"}
        )
