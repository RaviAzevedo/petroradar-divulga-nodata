"""Lista de revogação de tokens (jti denylist) sobre Redis.

Endereça as LACUNAS 12 (JWT stateless sem revogação) e a Decisão 4 do plano:
o NextAuth continua EMITINDO o token (JWS HS256), mas precisamos que desativar
um usuário (``ativo=false``) ou rebaixar seu papel tenha efeito **imediato**, em
vez de esperar o token expirar. Hoje, com JWT puramente stateless, um token
roubado/obsoleto vale até o ``exp``; isso é inaceitável para LGPD/segurança.

Mecanismo (denylist por ``jti``):
  - O lado Next.js, no callback ``jwt`` (``src/lib/auth.ts``), passa a gerar um
    ``jti`` (UUID) por sessão e gravá-lo no token. Ao desativar/rebaixar um
    usuário, ou no logout, ele adiciona esse ``jti`` ao set ``auth:revogados``
    do Redis **db2** (sessão/revogação — alocação travada nas matrizes).
  - Este módulo, chamado por ``get_current_user`` no BFF, REJEITA qualquer token
    cujo ``jti`` esteja revogado, retornando ``401`` na hora.
  - Também suportamos revogação em MASSA por usuário (``revoke_all_for_user``):
    grava um carimbo ``auth:revogado:user:<sub>`` com o epoch do corte; tokens
    emitidos ANTES desse corte (``iat`` < corte) são rejeitados. Útil quando o
    Next.js não tem o ``jti`` à mão (ex.: "encerrar todas as sessões").

Alocação Redis (consistente com rate_limit.py / worker / matrizes):
    db0 = cache / rate-limit
    db1 = broker Celery
    db2 = sessão / revogação JWT   (ESTE módulo)
    db3 = reservado (lado web)

TTL: cada ``jti`` revogado expira sozinho após ``JWT_REVOCATION_TTL_SECONDS``
(config atual default = 28800 = 8h, igual ao ``maxAge`` da Decisão 4). Como o
TTL NÃO pode expirar antes do próprio token (senão um jti/corte revogado
voltaria a ser aceito enquanto o token ainda vale), este módulo aplica um PISO
de 9h (maxAge 8h + 1h de folga p/ clock-skew) em :func:`_revocation_ttl` —
independente do config.py. Recomenda-se subir o default do config para 32400
(9h) para casar com o piso. Depois do TTL o próprio ``exp`` já invalida o token.

================================================================================
WIRING NECESSÁRIO (este arquivo é NOVO; não edita nenhum existente)
================================================================================

1) requirements.txt (bff/) — JÁ contém ``redis==5.2.1``. Nada a adicionar.

2) app/core/config.py — adicionar uma URL Redis dedicada ao db2 (com fallback
   inteligente). Aplicar este diff ao corpo da classe ``Settings`` (logo após o
   campo ``redis_url``):

       # Redis db2 (sessão / revogação de JWT). Se não setado, deriva de
       # REDIS_URL trocando o número do db para 2 (ver revocation.py).
       redis_revocation_url: str = Field(default="", alias="REDIS_REVOCATION_URL")

   (Opcional, recomendado) campo de TTL da denylist:

       jwt_revocation_ttl_seconds: int = Field(
           default=60 * 60 * 9, alias="JWT_REVOCATION_TTL_SECONDS"
       )  # 9h: maxAge 8h (Decisão 4) + 1h de folga

3) app/core/security.py — fazer ``get_current_user`` consultar a denylist. Como
   este módulo NÃO pode editar o existente, aqui vai o diff EXATO a aplicar em
   ``security.py``. Há duas formas; preferir a (A) por ser async-nativa:

   (A) Transformar ``get_current_user`` em ``async def`` e consultar o Redis:

       # --- topo de security.py ---
       from app.core.revocation import assert_nao_revogado

       # --- assinatura: async def ---
       async def get_current_user(request: Request) -> CurrentUser:
           ...
           # logo após decodificar o payload e validar `sub`/`exp`:
           jti = payload.get("jti")
           iat = payload.get("iat")
           await assert_nao_revogado(sub=str(sub), jti=jti, iat=iat)
           ...
           return CurrentUser(...)

   ``assert_nao_revogado`` levanta ``401`` se o token estiver revogado (por jti
   OU por corte de usuário). Todas as dependencies derivadas (``require_role``,
   ``require_admin`` etc.) herdam a checagem automaticamente — basta que elas
   passem a usar ``await get_current_user`` (FastAPI resolve dependency async
   transparentemente; ``require_role`` já usa ``Depends(get_current_user)``).

   (Alternativa síncrona, se não quiser tornar get_current_user async: usar
   ``is_revoked_sync`` com um client redis síncrono — porém o BFF é async, então
   a opção A é a recomendada e a única implementada como dependency aqui.)

4) app/main.py — fechar o pool no encerramento (lifespan), igual ao rate-limit:

       from app.core.revocation import close_revocation_redis
       # dentro de lifespan(), após o yield:
       await close_revocation_redis()

5) Lado Next.js (``src/lib/auth.ts`` / rotas de admin) — DOCUMENTADO na Decisão 4:
   gerar ``jti`` no callback ``jwt`` e, ao desativar usuário / logout, adicionar
   o ``jti`` (ou chamar o corte por usuário) ao set ``auth:revogados`` / chave
   ``auth:revogado:user:<sub>`` no Redis db2. As funções ``add_revoked_jti`` e
   ``revoke_all_for_user`` deste módulo documentam o contrato exato das chaves
   para que o TS escreva no MESMO formato (ou exponha-se um endpoint BFF
   ``POST /bff/admin/revogar`` protegido por ``require_admin`` que as chame).
"""

from __future__ import annotations

import os
import time

from fastapi import HTTPException, status

from app.core.config import settings
from app.core.logging import get_logger

try:  # redis==5.2.1 já declarado em requirements.txt
    import redis.asyncio as aioredis
except Exception:  # pragma: no cover
    aioredis = None  # type: ignore[assignment]

log = get_logger("petro_radar_bff.revocation")

# ── Convenção de chaves (contrato compartilhado com o Next.js) ────────────────
#: Set de ``jti`` revogados individualmente (logout / token específico).
REVOKED_JTI_SET = "auth:revogados"
#: Prefixo do "corte por usuário": tokens com ``iat`` < valor são revogados.
REVOKED_USER_PREFIX = "auth:revogado:user:"


def _revocation_redis_url() -> str:
    """URL do Redis db2 (sessão/revogação).

    Usa ``REDIS_REVOCATION_URL`` se setado; senão deriva da ``REDIS_URL``
    trocando o número do db para ``2`` (db0 = cache/rate-limit por convenção).
    """
    explicit = getattr(settings, "redis_revocation_url", "") or ""
    if explicit:
        return explicit
    base = settings.redis_url
    # Troca o "/<db>" final por "/2". Se não houver db explícito, anexa.
    if "/" in base.split("://", 1)[-1]:
        prefixo, _, _db = base.rpartition("/")
        # Só troca se o sufixo for um número de db (evita estragar caminhos).
        if _db.isdigit():
            return f"{prefixo}/2"
    return base.rstrip("/") + "/2"


# maxAge da sessão emitida pelo NextAuth (Decisão 4 — ver src/lib/auth.ts).
_SESSION_MAXAGE_SECONDS = 8 * 60 * 60  # 8h
# Folga sobre o maxAge para cobrir clock-skew entre Next.js e BFF.
_TTL_BUFFER_SECONDS = 60 * 60  # 1h
# Piso do TTL da denylist: NUNCA pode expirar antes do próprio token, senão um
# jti/corte revogado "reviveria" enquanto o token ainda é válido (janela de
# aceite indevido). 9h = maxAge 8h + 1h de folga.
_MIN_REVOCATION_TTL = _SESSION_MAXAGE_SECONDS + _TTL_BUFFER_SECONDS


def _revocation_ttl() -> int:
    """TTL (s) da denylist, com piso de segurança.

    Lê ``jwt_revocation_ttl_seconds`` das settings (env
    ``JWT_REVOCATION_TTL_SECONDS``; default do config atual = 28800 = 8h, igual
    ao maxAge). Aplica um PISO de ``_MIN_REVOCATION_TTL`` (9h = maxAge + folga)
    para garantir que a denylist cubra toda a vida do token mesmo com clock-skew
    — sem depender de alterar o config.py. Se o valor configurado for menor que
    o piso, usamos o piso e logamos um aviso (a config deveria subir para >= 9h).
    """
    configurado = int(getattr(settings, "jwt_revocation_ttl_seconds", _MIN_REVOCATION_TTL))
    if configurado < _MIN_REVOCATION_TTL:
        log.warning(
            "revocation.ttl_abaixo_do_piso",
            extra={
                "configurado_s": configurado,
                "piso_s": _MIN_REVOCATION_TTL,
                "maxage_s": _SESSION_MAXAGE_SECONDS,
            },
        )
        return _MIN_REVOCATION_TTL
    return configurado


def _revocation_failclosed() -> bool:
    """Modo fail-CLOSED da revogação, controlado por env (default desligado).

    Com ``REVOCATION_FAILCLOSED=1``, se o Redis db2 estiver indisponível (lib
    ausente ou erro de I/O) tratamos o token como REVOGADO (401) em vez de
    aceitá-lo até o ``exp``. Default ``0`` (fail-open) para não travar dev nem
    ambientes sem Redis proposital. Lido diretamente do ambiente para não exigir
    alteração no config.py (fora do escopo deste módulo).
    """
    return os.getenv("REVOCATION_FAILCLOSED", "0") == "1"


_redis_client: "aioredis.Redis | None" = None  # type: ignore[name-defined]


def _get_redis() -> "aioredis.Redis | None":  # type: ignore[name-defined]
    """Client Redis singleton (lazy) para o db2. ``None`` se a lib faltar."""
    global _redis_client
    if aioredis is None:
        return None
    if _redis_client is None:
        _redis_client = aioredis.from_url(
            _revocation_redis_url(),
            encoding="utf-8",
            decode_responses=True,
        )
    return _redis_client


async def close_revocation_redis() -> None:
    """Fecha o pool Redis da revogação. Chamar no encerramento (lifespan)."""
    global _redis_client
    if _redis_client is not None:
        try:
            await _redis_client.aclose()
        except Exception as exc:  # noqa: BLE001
            log.warning("revocation.redis_close_falhou", extra={"erro": str(exc)})
        finally:
            _redis_client = None


# ── Escrita: revogar (chamado pelo admin / logout, ou pelo endpoint BFF) ──────


async def add_revoked_jti(jti: str) -> None:
    """Adiciona um ``jti`` à denylist (revogação de UM token/sessão).

    Implementação: usa uma chave com TTL por jti (``auth:revogados`` como
    prefixo lógico) — assim cada entrada expira sozinha após o TTL, evitando
    crescimento infinito do set. Mantemos também o set ``auth:revogados`` para
    compatibilidade de inspeção/contrato com o Next.js (``SADD``), mas a
    checagem rápida usa a chave com TTL.
    """
    client = _get_redis()
    if client is None or not jti:
        return
    ttl = _revocation_ttl()
    try:
        pipe = client.pipeline(transaction=True)
        pipe.setex(f"{REVOKED_JTI_SET}:{jti}", ttl, "1")
        pipe.sadd(REVOKED_JTI_SET, jti)  # contrato/inspeção (Next.js)
        await pipe.execute()
        log.info("revocation.jti_revogado", extra={"jti": jti})
    except Exception as exc:  # noqa: BLE001
        log.error("revocation.add_jti_falhou", extra={"erro": str(exc), "jti": jti})


async def revoke_all_for_user(sub: str) -> None:
    """Revoga TODAS as sessões de um usuário (corte por ``iat``).

    Grava o epoch atual em ``auth:revogado:user:<sub>`` com TTL. Qualquer token
    cujo ``iat`` seja anterior a esse corte é rejeitado por
    :func:`assert_nao_revogado`. Use ao desativar (``ativo=false``) ou rebaixar
    o papel de um usuário — efeito imediato, sem precisar do jti.
    """
    client = _get_redis()
    if client is None or not sub:
        return
    ttl = _revocation_ttl()
    corte = int(time.time())
    try:
        await client.setex(f"{REVOKED_USER_PREFIX}{sub}", ttl, str(corte))
        log.info("revocation.usuario_revogado", extra={"sub": sub, "corte": corte})
    except Exception as exc:  # noqa: BLE001
        log.error(
            "revocation.revoke_user_falhou", extra={"erro": str(exc), "sub": sub}
        )


# ── Leitura: checagem usada pelo get_current_user ─────────────────────────────


async def is_revoked(
    *, sub: str, jti: str | None = None, iat: int | float | None = None
) -> bool:
    """Retorna True se o token deve ser considerado revogado.

    Verifica, nesta ordem:
      1. ``jti`` na denylist (revogação individual);
      2. ``iat`` anterior ao corte por usuário (revogação em massa).

    Comportamento quando o Redis db2 está indisponível (lib ausente ou erro de
    I/O), controlado por ``REVOCATION_FAILCLOSED`` (ver :func:`_revocation_failclosed`):
      - FAIL-OPEN (default): retorna ``False`` (não revogado) para não derrubar
        o acesso de todos por falha de infra; a segurança recai sobre o ``exp``
        (maxAge 8h). Alinhado ao comportamento tolerante do /health.
      - FAIL-CLOSED (``=1``): retorna ``True`` (revogado) — nega o acesso. Em
        AMBOS os casos de indisponibilidade logamos em nível CRÍTICO para que a
        queda do Redis de revogação seja observável (alerta), não silenciosa.
    """
    failclosed = _revocation_failclosed()
    client = _get_redis()
    if client is None:
        # Sem client (lib redis ausente / não inicializado) = revogação cega.
        log.critical(
            "revocation.redis_indisponivel",
            extra={"sub": sub, "motivo": "client_none", "failclosed": failclosed},
        )
        return failclosed
    try:
        if jti:
            existe = await client.exists(f"{REVOKED_JTI_SET}:{jti}")
            if existe:
                return True
        if sub:
            corte_raw = await client.get(f"{REVOKED_USER_PREFIX}{sub}")
            if corte_raw is not None and iat is not None:
                try:
                    corte = int(corte_raw)
                except (TypeError, ValueError):
                    corte = 0
                if corte and float(iat) < corte:
                    return True
    except Exception as exc:  # noqa: BLE001 - falha de infra do Redis de revogação
        # CRÍTICO/observável: sem o Redis não conseguimos afirmar se o token foi
        # revogado. fail-closed nega (seguro); fail-open aceita (disponível).
        log.critical(
            "revocation.check_falhou",
            extra={"erro": str(exc), "sub": sub, "failclosed": failclosed},
        )
        return failclosed
    return False


_TOKEN_REVOGADO = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Sessão revogada",
    headers={"WWW-Authenticate": "Bearer"},
)


async def assert_nao_revogado(
    *, sub: str, jti: str | None = None, iat: int | float | None = None
) -> None:
    """Levanta ``401`` se o token estiver revogado. Usar no ``get_current_user``.

    Conveniência sobre :func:`is_revoked` para o caminho de autenticação manter
    o padrão "levanta HTTPException" do ``security.py``.
    """
    if await is_revoked(sub=sub, jti=jti, iat=iat):
        log.warning("revocation.acesso_negado", extra={"sub": sub, "jti": jti})
        raise _TOKEN_REVOGADO


__all__ = [
    "REVOKED_JTI_SET",
    "REVOKED_USER_PREFIX",
    "add_revoked_jti",
    "revoke_all_for_user",
    "is_revoked",
    "assert_nao_revogado",
    "close_revocation_redis",
]
