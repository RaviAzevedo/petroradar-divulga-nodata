"""Segurança / autenticação da camada BFF.

CONTRATO DE TOKEN (travado entre os três agentes):

  - O EMISSOR do token é o container Next.js (NextAuth v5). O FastAPI APENAS
    VALIDA. O login NÃO migra agora.
  - Claims esperadas: ``id`` (users.id — o identificador que vale; ``sub`` é só
    fallback e no SSO vem com um UUID aleatório), ``email``, ``role``, ``exp``.
  - O segredo compartilhado é o ``settings.jwt_secret`` (``AUTH_SECRET`` com
    fallback ``NEXTAUTH_SECRET``).

VALIDAÇÃO EM MODO DUPLO (JWE real + JWS de teste):
  A configuração real do app (``src/lib/auth.ts``: ``session.strategy = "jwt"``,
  SEM override de ``jwt.encode``/``jwt.decode``) faz o NextAuth v5 emitir o token
  de sessão como **JWE** (token CRIPTOGRAFADO), não como um JWS assinado. Por isso
  ``get_current_user`` decide pelo NÚMERO DE SEGMENTOS do token:

    (a) 5 segmentos  → JWE (token REAL do Auth.js v5). Decripta no padrão Auth.js:
        chave derivada por HKDF-SHA256 a partir do ``AUTH_SECRET`` e, em seguida,
        decode JWE ``dir`` + ``A256CBC-HS512``. Ver :func:`_derivar_chave_jwe` e
        :func:`_decodificar_jwe`.

    (b) 3 segmentos  → JWS HS256 (fallback). Mantém a validação ``PyJWT``/HS256
        usada pelos tokens de teste forjados em ``tests/`` (e por uma eventual
        configuração que sobrescreva ``jwt.encode`` no Next para emitir JWS).

  Em ambos os casos o segredo compartilhado é o ``AUTH_SECRET``.

CAVEAT da derivação de chave (Auth.js v5 — replicar EXATAMENTE o lado Next):
  O Auth.js v5 deriva a chave de cifragem com::

      HKDF-SHA256(
          ikm   = AUTH_SECRET,
          salt  = <nome do cookie>,                     # ex.: "authjs.session-token"
          info  = "Auth.js Generated Encryption Key (<salt>)",
          length= 64 se enc == "A256CBC-HS512" senão 32,
      )

  O default do v5 é ``enc = "A256CBC-HS512"`` → chave de 64 bytes. (Versões
  antigas/v4 usavam ``A256GCM`` → 32 bytes e ``info`` SEM o sufixo ``(<salt>)``;
  tratamos esse caso legado por compatibilidade lendo o cabeçalho do JWE.)
  O ``salt`` precisa bater com ``settings.auth_cookie_name`` E com o cookie que o
  Next realmente emite (em HTTPS o Next prefixa ``__Secure-`` — ver derivação).
"""

from __future__ import annotations

from datetime import datetime, timezone

import jwt
from fastapi import Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from app.core.config import settings
from app.core.revocation import assert_nao_revogado

# ── Papéis (replicados de src/lib/permissions.ts da PRODUÇÃO) ─────────────────
#
# OBS: a produção (permissions.ts) inclui o papel SGI (Sistema de Gestão
# Integrada / Conformidade), que NÃO constava na lista do briefing. Replicamos
# fielmente o que existe em produção — incluindo SGI — para manter os guards
# consistentes com o app Next.js. Total: 7 papéis.

ROLE_ADMIN = "ADMIN"
ROLE_LIDER = "LIDER"
ROLE_ORCAMENTISTA = "ORCAMENTISTA"
ROLE_TECNICO = "TECNICO"
ROLE_SGI = "SGI"
ROLE_VISUALIZADOR = "VISUALIZADOR"
ROLE_EXTERNO = "EXTERNO"

#: Todos os papéis conhecidos (espelha ROLES de permissions.ts).
ALL_ROLES: tuple[str, ...] = (
    ROLE_ADMIN,
    ROLE_LIDER,
    ROLE_ORCAMENTISTA,
    ROLE_TECNICO,
    ROLE_SGI,
    ROLE_VISUALIZADOR,
    ROLE_EXTERNO,
)

#: Papel padrão para tokens sem role válida (espelha DEFAULT_ROLE).
DEFAULT_ROLE = ROLE_VISUALIZADOR

# ── Grupos de papéis (espelham os ROLES_* de permissions.ts) ──────────────────

ROLES_ADMIN: tuple[str, ...] = (ROLE_ADMIN,)
ROLES_GESTAO: tuple[str, ...] = (ROLE_ADMIN, ROLE_LIDER)
ROLES_PROPOR: tuple[str, ...] = (
    ROLE_ADMIN,
    ROLE_LIDER,
    ROLE_ORCAMENTISTA,
    ROLE_TECNICO,
)
ROLES_VISUALIZAR: tuple[str, ...] = (
    ROLE_ADMIN,
    ROLE_LIDER,
    ROLE_ORCAMENTISTA,
    ROLE_TECNICO,
    ROLE_SGI,
    ROLE_VISUALIZADOR,
)
ROLES_CONFORMIDADE: tuple[str, ...] = (ROLE_ADMIN, ROLE_LIDER, ROLE_SGI)

# ── Mapa de papéis legados (espelha normalizeRole de auth.ts) ─────────────────

_LEGACY_ROLE_MAP: dict[str, str] = {
    "admin": ROLE_ADMIN,
    "editor": ROLE_LIDER,
    "viewer": ROLE_VISUALIZADOR,
}


def normalize_role(role: str | None) -> str:
    """Normaliza papéis legados (admin/editor/viewer) para o padrão novo.

    Espelha ``normalizeRole`` de ``src/lib/auth.ts``: papéis desconhecidos caem
    para :data:`DEFAULT_ROLE` (VISUALIZADOR).
    """
    if not role:
        return DEFAULT_ROLE
    if role in ALL_ROLES:
        return role
    return _LEGACY_ROLE_MAP.get(role, DEFAULT_ROLE)


# ── Funções de verificação (espelham permissions.ts) ──────────────────────────


def is_admin(role: str) -> bool:
    """Verdadeiro se o papel for ADMIN."""
    return role == ROLE_ADMIN


def is_gestao(role: str) -> bool:
    """Verdadeiro para gestão (ADMIN, LIDER)."""
    return role in ROLES_GESTAO


def is_conformidade(role: str) -> bool:
    """Verdadeiro para o setor de Conformidade (ADMIN, LIDER, SGI)."""
    return role in ROLES_CONFORMIDADE



def pode_visualizar(role: str) -> bool:
    """Verdadeiro se o papel pode visualizar (todos exceto EXTERNO)."""
    return role in ROLES_VISUALIZAR


# ── Usuário autenticado ───────────────────────────────────────────────────────


class CurrentUser(BaseModel):
    """Usuário extraído e validado do JWT.

    ``id`` e ``sub`` são o mesmo identificador (alias para conveniência) e
    valem SEMPRE o ``users.id`` do banco — ver :func:`_claims_para_usuario`
    (o claim ``sub`` cru do Auth.js é um UUID aleatório, não o id do usuário).
    """

    sub: str = Field(..., description="Identificador do usuário (users.id).")
    email: str | None = Field(default=None, description="E-mail do usuário.")
    role: str = Field(default=DEFAULT_ROLE, description="Papel normalizado.")

    @property
    def id(self) -> str:
        """Alias de ``sub`` — o id do usuário."""
        return self.sub


# ── Extração do token ─────────────────────────────────────────────────────────


def _extrair_token(request: Request) -> str | None:
    """Extrai o token bruto do header Authorization (Bearer) ou do cookie.

    Preferência: ``Authorization: Bearer <token>``; em seguida, o cookie de
    sessão emitido pelo NextAuth (``settings.auth_cookie_name`` e variantes
    seguras ``__Secure-...``).
    """
    auth_header = request.headers.get("authorization") or request.headers.get(
        "Authorization"
    )
    if auth_header and auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip() or None

    # Fallback: cookie de sessão do NextAuth.
    cookie_name = settings.auth_cookie_name
    for nome in (cookie_name, f"__Secure-{cookie_name}"):
        valor = request.cookies.get(nome)
        if valor:
            return valor
    return None


_CREDENCIAIS_INVALIDAS = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Não autenticado",
)


# ── Decode do JWE real do Auth.js v5 (token de sessão criptografado) ───────────
#
# O Auth.js v5 NÃO assina o token de sessão: ele o CIFRA (JWE, 5 segmentos). Para
# validar precisamos (1) derivar a mesma chave que o Next deriva e (2) decriptar.


def _salts_candidatos() -> tuple[str, ...]:
    """Nomes de cookie usados como ``salt`` da derivação HKDF.

    O Auth.js usa o NOME DO COOKIE de sessão como salt. Em HTTP o cookie é
    ``authjs.session-token``; em HTTPS o Next prefixa ``__Secure-``. Quando o
    token chega via header ``Authorization: Bearer`` não sabemos qual variante o
    Next usou, então tentamos ambas (a base primeiro). Mantém ordem determinística.
    """
    base = settings.auth_cookie_name
    return (base, f"__Secure-{base}")


def _derivar_chave_jwe(secret: str, salt: str, length: int) -> bytes:
    """Deriva a chave de cifragem do Auth.js v5 via HKDF-SHA256.

    Replica EXATAMENTE a derivação do lado Next (Auth.js v5)::

        HKDF-SHA256(ikm=AUTH_SECRET, salt=<cookie>,
                    info="Auth.js Generated Encryption Key (<cookie>)",
                    length=<64 p/ A256CBC-HS512 | 32 p/ A256GCM>)

    O ``info`` com o sufixo ``(<salt>)`` é o formato do v5. O formato legado (v4)
    usava ``"NextAuth.js Generated Encryption Key"`` SEM sufixo e enc A256GCM/32;
    :func:`_decodificar_jwe` cobre esse caso variando ``length`` e ``info``.
    """
    # Import local: mantém o cryptography (já em requirements) fora do caminho
    # quente quando o token é JWS, e evita custo de import em ambientes só-HS256.
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    from cryptography.hazmat.primitives import hashes

    if length == 32:
        # Compat v4/legado: info sem sufixo (e enc A256GCM).
        info = b"NextAuth.js Generated Encryption Key"
    else:
        info = f"Auth.js Generated Encryption Key ({salt})".encode("utf-8")
    hkdf = HKDF(
        algorithm=hashes.SHA256(),
        length=length,
        salt=salt.encode("utf-8"),
        info=info,
    )
    return hkdf.derive(secret.encode("utf-8"))


def _ler_enc_do_header(token: str) -> str:
    """Lê o ``enc`` do cabeçalho protegido do JWE (1º segmento), SEM chave.

    O cabeçalho é o primeiro segmento, base64url (sem padding) de um JSON. Define
    o tamanho da chave: ``A256CBC-HS512`` → 64 bytes (default v5); ``A256GCM`` →
    32 bytes (legado v4). Em caso de erro, assume o default do v5.
    """
    import base64
    import json as _json

    try:
        protegido = token.split(".", 1)[0]
        # Restaura o padding que o base64url do JWT omite.
        protegido += "=" * (-len(protegido) % 4)
        header = _json.loads(base64.urlsafe_b64decode(protegido).decode("utf-8"))
        if isinstance(header, dict) and isinstance(header.get("enc"), str):
            return header["enc"]
    except Exception:  # noqa: BLE001 — header ilegível: assume default do v5
        pass
    return "A256CBC-HS512"


def _decodificar_jwe(token: str, secret: str) -> dict:
    """Decripta o JWE do Auth.js v5 e devolve as claims (dict).

    Escolhe o tamanho de chave pelo ``enc`` do cabeçalho (64 p/ A256CBC-HS512,
    default v5; 32 p/ A256GCM, legado) e tenta cada salt candidato (cookie com/sem
    prefixo ``__Secure-``). Levanta ``ValueError`` se nenhuma combinação
    decriptar — o chamador converte em 401.
    """
    # joserfc implementa JWE "dir" + A256CBC-HS512 / A256GCM. A chave bruta
    # derivada por HKDF é embrulhada em OctKey (chave simétrica) p/ o decrypt.
    import json as _json

    from joserfc import jwe
    from joserfc.errors import JoseError
    from joserfc.jwk import OctKey

    enc = _ler_enc_do_header(token)
    length = 32 if enc == "A256GCM" else 64

    ultimo_erro: Exception | None = None
    for salt in _salts_candidatos():
        chave = OctKey.import_key(_derivar_chave_jwe(secret, salt, length))
        try:
            resultado = jwe.decrypt_compact(
                token,
                chave,
                # Só aceitamos "dir" + o enc anunciado (sem downgrade de algoritmo).
                algorithms=["dir", enc],
            )
            return _json.loads(resultado.plaintext.decode("utf-8"))
        except (JoseError, ValueError, KeyError) as exc:  # tenta o próximo salt
            ultimo_erro = exc
            continue

    raise ValueError(
        f"Falha ao decriptar JWE do Auth.js v5 (enc={enc}): {ultimo_erro}"
    )


def _claims_para_usuario(payload: dict) -> CurrentUser:
    """Valida o identificador/``exp`` das claims já decodificadas e monta o CurrentUser.

    PRECEDÊNCIA ``id`` ANTES de ``sub`` — NÃO inverter. No login SSO o
    ``@auth/core`` DESCARTA o id devolvido por ``profile()`` e grava
    ``id: crypto.randomUUID()`` (``lib/actions/callback/oauth/callback.js``,
    "the user's id is intentionally not set based on the profile id"); é esse
    UUID aleatório — que não existe em ``users`` — que vira o claim ``sub`` do
    token. O id REAL (``users.id``) é o que o callback ``jwt`` de
    ``src/lib/auth.ts`` grava em ``token.id``. Ler ``sub`` primeiro fazia TODO
    write do BFF com FK para ``users`` estourar ``ForeignKeyViolationError``
    (upload do cofre → 500 "Erro interno") e o corte de revogação por usuário
    (``auth:revogado:user:<id>``, gravado pelo Next com o id do banco) nunca
    casar. ``sub`` fica como fallback dos JWS forjados em ``tests/``, que só
    gravam ``sub``. Levanta ``401`` se faltar identificador ou se ``exp`` passou.
    """
    sub = payload.get("id") or payload.get("sub")
    if not sub:
        raise _CREDENCIAIS_INVALIDAS

    # Validação de expiração (o caminho JWE não passa pelo verify_exp do PyJWT).
    exp = payload.get("exp")
    if isinstance(exp, (int, float)):
        if datetime.now(tz=timezone.utc).timestamp() >= float(exp):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Não autenticado",
            )

    # Papel: o app grava em ``role``; aceitamos ``papel`` como sinônimo PT-BR.
    role = payload.get("role")
    if role is None:
        role = payload.get("papel")

    return CurrentUser(
        sub=str(sub),
        email=payload.get("email"),
        role=normalize_role(role),
    )


async def get_current_user(request: Request) -> CurrentUser:
    """Dependency: valida o token de sessão e retorna o :class:`CurrentUser`.

    Modo DUPLO, decidido pelo número de segmentos do token:
      - 5 segmentos → JWE (token REAL do NextAuth/Auth.js v5): decripta com a
        chave derivada por HKDF e extrai as claims.
      - 3 segmentos → JWS HS256 (fallback; tokens de teste forjados em ``tests/``).

    Após decodificar (em qualquer um dos modos) e validar ``sub``/``exp``,
    CONSULTA a lista de revogação (``app/core/revocation.py``): se o ``jti`` do
    token estiver na denylist OU o ``iat`` for anterior ao corte por usuário,
    levanta ``401`` na hora (efeito imediato de logout / desativação de usuário).
    Async-nativo: a checagem da denylist é assíncrona (consulta ao Redis db2).

    Levanta ``401`` se o token estiver ausente, malformado, com assinatura
    inválida, indecifrável, expirado ou revogado.
    """
    secret = settings.jwt_secret
    if not secret:
        # Falha-fechado: sem segredo não há como validar — nega o acesso.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Servidor sem AUTH_SECRET/NEXTAUTH_SECRET configurado",
        )

    token = _extrair_token(request)
    if not token:
        raise _CREDENCIAIS_INVALIDAS

    n_segmentos = token.count(".") + 1

    # ── (a) JWE (5 segmentos): token real do Auth.js v5 ───────────────────────
    if n_segmentos == 5:
        try:
            payload = _decodificar_jwe(token, secret)
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001 — qualquer falha de decode = 401
            raise _CREDENCIAIS_INVALIDAS from exc
    else:
        # ── (b) JWS HS256 (3 segmentos): fallback / token de teste ────────────
        try:
            payload = jwt.decode(
                token,
                secret,
                algorithms=["HS256"],
                options={"require": ["exp", "sub"], "verify_exp": True},
            )
        except jwt.ExpiredSignatureError as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Não autenticado",
            ) from exc
        except jwt.PyJWTError as exc:
            raise _CREDENCIAIS_INVALIDAS from exc

    # Valida claims e monta o usuário (checa sub/exp/role).
    user = _claims_para_usuario(payload)

    # ── Lista de revogação (denylist por jti + corte por usuário) ─────────────
    # Levanta 401 se o token estiver revogado. Fail-open se o Redis cair (a
    # política de fail-open vive no próprio revocation.py); o ``exp`` continua
    # sendo a garantia mínima nesse caso degradado.
    await assert_nao_revogado(
        sub=user.sub,
        jti=payload.get("jti"),
        iat=payload.get("iat"),
    )

    return user


# ── Autorização por papel ─────────────────────────────────────────────────────


def require_role(*roles: str, mensagem: str = "Permissão negada"):
    """Factory de dependency que exige que o usuário tenha um dos ``roles``.

    Retorna uma dependency FastAPI. Levanta ``403`` se o papel do usuário não
    estiver na lista. ``mensagem`` espelha o texto exato do guard equivalente em
    ``api/guards.ts`` (handleApiError devolve ``{error: mensagem, code:"FORBIDDEN"}``).
    Use diretamente nas rotas::

        @router.get("/admin", dependencies=[Depends(require_role(ROLE_ADMIN))])

    ou para receber o usuário::

        async def rota(user: CurrentUser = Depends(require_role(ROLE_ADMIN))):
            ...
    """
    permitidos = set(roles) if roles else set(ALL_ROLES)

    def _dependency(
        user: CurrentUser = Depends(get_current_user),
    ) -> CurrentUser:
        if user.role not in permitidos:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=mensagem,
            )
        return user

    return _dependency


# ── Dependencies semânticas (espelham os require* de api/guards.ts) ───────────
# As mensagens batem EXATAMENTE com os ApiError(403,"FORBIDDEN",<msg>) do Next.

#: Sessão + permissão de visualização (todos exceto EXTERNO).
require_visualizar = require_role(*ROLES_VISUALIZAR, mensagem="Permissão negada")
#: Sessão + permissão de gestão (ADMIN, LIDER).
require_gestao = require_role(*ROLES_GESTAO, mensagem="Apenas gestão")
#: Sessão + setor Conformidade (ADMIN, LIDER, SGI).
require_conformidade = require_role(*ROLES_CONFORMIDADE, mensagem="Apenas Conformidade")
#: Sessão + papel ADMIN.
require_admin = require_role(*ROLES_ADMIN, mensagem="Apenas administrador")
#: Sessão + permissão para propor participação.
require_propor = require_role(*ROLES_PROPOR, mensagem="Sem permissão de propor")
#: Acesso ao acervo técnico (RAG): hoje = qualquer usuário que pode visualizar.
require_acervo = require_role(*ROLES_VISUALIZAR, mensagem="Sem acesso ao acervo")
