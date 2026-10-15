"""Rota migrada (strangler-fig): POST /api/conformidade/import/token.

Equivalente 1:1 de
``src/app/api/conformidade/import/token/route.ts`` (ÚNICO handler: POST).

O QUE A ROTA FAZ (paridade com o Next):
  Gera um token efêmero JWT HS256 (assinado com ``AUTH_SECRET``) para o CLI
  de sincronização (máquina do SGI na rede de arquivos). NÃO toca o banco:
  sem ``get_db``, sem query, sem transação/lock/soft-delete. A lógica de geração
  do token (``gerarImportToken`` de ``src/lib/conformidade/import-tokens.ts``) é
  inteiramente em memória (HMAC-SHA256 via Web Crypto no Next → ``hmac`` aqui).

GUARD (ordem EXATA do Next — sessão ANTES da permissão):
  1) ``auth()`` ausente            → 401 ``{ "error": "Não autenticado" }``
  2) ``!podeImportarConformidade`` → 403 ``{ "error": "Permissão negada" }``
  ``podeImportarConformidade`` → ``isConformidade`` → {ADMIN, LIDER, SGI}
  (= ROLES_CONFORMIDADE = :data:`app.core.security.ROLES_CONFORMIDADE`).

  NÃO usamos ``Depends(require_conformidade)`` como guard porque o FastAPI
  serializa ``HTTPException(detail=...)`` como ``{"detail": ...}``, ao passo que o
  Next devolve ``{"error": <string>}``. Para manter o SHAPE/MENSAGENS idênticos
  ao Next, validamos a sessão via ``get_current_user`` e checamos o papel à mão,
  devolvendo ``JSONResponse({"error": ...})`` com o status correspondente.

BODY (paridade EXATA):
  ``await request.json()`` envolto em try/except (body vazio permitido → ``{}``).
  Validação Zod: ``ttlHoras`` int em [1, 168] (=7*24), default 24.
  Falha de validação → 400 ``{ "error": "Parâmetros inválidos" }``.

BUG DE PRODUÇÃO REPLICADO (clamp do TTL):
  O ``BodySchema`` aceita ``ttlHoras`` até 168 (7*24), MAS ``gerarImportToken``
  clampa o TTL efetivo do token em [1, 24] horas (``TTL_MAX_HORAS = 24``). A
  resposta, no entanto, devolve ``ttlHoras: parsed.data.ttlHoras`` (até 168). Ou
  seja: para ``ttlHoras > 24`` o ``exp`` do token reflete 24h, mas o campo
  ``ttlHoras`` da resposta mostra o valor pedido. Replicamos essa divergência.

RESPOSTA (paridade EXATA):
  status 200 (default do ``NextResponse.json``); corpo::

    {
      "token":      "<jwt hs256>",
      "expiraEm":   "<ISO 8601 do exp efetivo (clampado)>",
      "ttlHoras":   <valor pedido, NÃO clampado>,
      "instrucoes": "Use este token via header ..."
    }
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from app.core.config import settings
from app.core.security import ROLES_CONFORMIDADE, get_current_user

router = APIRouter()

# ── Constantes de TTL (réplica EXATA de import-tokens.ts) ──────────────────────
TTL_PADRAO_HORAS = 2   # default interno do gerador (NÃO é o default do BodySchema!)
TTL_MAX_HORAS = 24     # clamp do token efetivo — fonte do bug replicado

# Limites do BodySchema (Zod: z.number().int().min(1).max(7*24).default(24)).
_TTL_MIN = 1
_TTL_MAX = 7 * 24      # 168
_TTL_DEFAULT = 24


# ── Geração do token (réplica EXATA de gerarImportToken) ───────────────────────


def _b64url_encode(raw: bytes) -> str:
    """base64url SEM padding (idêntico ao base64UrlEncode do TS)."""
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _js_to_iso_string(dt: datetime) -> str:
    """Replica ``new Date(...).toISOString()`` (UTC, MILISSEGUNDOS, sufixo 'Z').

    O Next devolve ``expiraEm.toISOString()``: o ``NextResponse.json`` sempre emite
    UTC com 3 casas de milissegundo e sufixo ``Z`` (ex.: ``...:00.000Z``). O
    ``isoformat()`` puro divergiria (``+00:00`` e sem ms), então formatamos à mão
    como os demais routers migrados. Como ``exp`` é em segundos inteiros, o ms é
    sempre ``000``.
    """
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    ms = dt.microsecond // 1000
    return (
        f"{dt.year:04d}-{dt.month:02d}-{dt.day:02d}"
        f"T{dt.hour:02d}:{dt.minute:02d}:{dt.second:02d}.{ms:03d}Z"
    )


def _gerar_import_token(
    user_id: str,
    role: str,
    ttl_horas: int = TTL_PADRAO_HORAS,
) -> tuple[str, datetime]:
    """Replica ``gerarImportToken(userId, role, ttlHoras)`` de import-tokens.ts.

    - ``now`` = epoch em segundos (``Math.floor(Date.now()/1000)``).
    - ``horas`` = clamp(ttl, 1, 24) → ``Math.min(Math.max(ttl, 1), 24)``.
    - ``exp`` = now + horas*3600.
    - payload (ORDEM PRESERVADA p/ paridade byte-a-byte do JWT):
        {sub, role, kind:"import_cli", jti, iat, exp}
    - header: {"alg":"HS256","typ":"JWT"} (nessa ordem).
    - assinatura HMAC-SHA256 do "<headerB64>.<payloadB64>" com AUTH_SECRET.

    Retorna ``(token, expiraEm)`` onde ``expiraEm`` é o datetime do ``exp``
    EFETIVO (já clampado), em UTC.
    """
    secret = settings.jwt_secret
    if not secret:
        # Espelha o getKey() do TS: lança se AUTH_SECRET/NEXTAUTH_SECRET ausente.
        raise RuntimeError("AUTH_SECRET / NEXTAUTH_SECRET não configurado")

    now = int(time.time())
    # Clampa o TTL ao máximo permitido (e a um mínimo positivo).
    horas = min(max(ttl_horas, 1), TTL_MAX_HORAS)
    exp = now + horas * 3600
    jti = str(uuid.uuid4())  # crypto.randomUUID()

    # JSON sem espaços (como JSON.stringify) e com a MESMA ordem de chaves.
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "sub": user_id,
        "role": role,
        "kind": "import_cli",
        "jti": jti,
        "iat": now,
        "exp": exp,
    }
    header_json = json.dumps(header, separators=(",", ":"), ensure_ascii=False)
    payload_json = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)

    header_b64 = _b64url_encode(header_json.encode("utf-8"))
    payload_b64 = _b64url_encode(payload_json.encode("utf-8"))
    data = f"{header_b64}.{payload_b64}"

    sig = hmac.new(
        secret.encode("utf-8"),
        data.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    sig_b64 = _b64url_encode(sig)

    token = f"{data}.{sig_b64}"
    expira_em = datetime.fromtimestamp(exp, tz=timezone.utc)
    return token, expira_em


# ── Validação do corpo (réplica do BodySchema Zod) ─────────────────────────────


def _validar_body(body: object) -> int | None:
    """Replica ``BodySchema.safeParse(body)`` → devolve ``ttlHoras`` ou ``None``.

    Zod: ``z.object({ ttlHoras: z.number().int().min(1).max(168).default(24) })``.
      - Body que não é objeto (ex.: lista, número, string) → inválido (None).
      - Chave ausente / ``undefined`` → aplica o default (24).
      - ``ttlHoras`` precisa ser número inteiro (não bool) em [1, 168].
        (``true``/``false`` em JS NÃO são ``number`` p/ o Zod → inválido.)

    Retorna ``None`` quando o parse falha (chamador → 400). Note que o objeto
    pode ter chaves extras: o Zod (sem ``.strict()``) as ignora — não invalida.
    """
    if not isinstance(body, dict):
        return None

    if "ttlHoras" not in body or body.get("ttlHoras") is None:
        return _TTL_DEFAULT

    valor = body["ttlHoras"]
    # bool é subclasse de int em Python, mas em JS não é number → rejeita.
    if isinstance(valor, bool) or not isinstance(valor, (int, float)):
        return None
    # z.number().int(): precisa ser inteiro (sem parte fracionária).
    if isinstance(valor, float) and not valor.is_integer():
        return None
    ttl = int(valor)
    if ttl < _TTL_MIN or ttl > _TTL_MAX:
        return None
    return ttl


_INSTRUCOES = (
    "Use este token via header `Authorization: Bearer <token>` nos endpoints "
    "/api/conformidade/import/familias e /api/conformidade/import/scan. O CLI "
    "já faz isso automaticamente."
)


@router.post("/api/conformidade/import/token")
async def post_import_token(request: Request) -> JSONResponse:
    """POST /api/conformidade/import/token — emite token efêmero p/ o CLI de import.

    Paridade EXATA com o handler POST do route.ts:
      1) Sessão ausente            → 401 ``{"error": "Não autenticado"}``.
      2) Papel fora de {ADMIN,LIDER,SGI} → 403 ``{"error": "Permissão negada"}``.
      3) Body inválido (Zod)       → 400 ``{"error": "Parâmetros inválidos"}``.
      4) Sucesso                   → 200 ``{token, expiraEm, ttlHoras, instrucoes}``.

    O ``expiraEm`` reflete o ``exp`` EFETIVO (TTL clampado em 24h), mas o campo
    ``ttlHoras`` ecoa o valor pedido (até 168) — bug de produção replicado.
    """
    # ── 1) Sessão (auth()) — 401 com o shape/mensagem do Next ─────────────────
    # ``get_current_user`` valida o JWT da sessão (NextAuth). Se faltar/for
    # inválido ele levanta HTTPException 401 (detail="Não autenticado" / "Token
    # expirado") — mas no shape do FastAPI ({"detail": ...}). Convertimos para o
    # shape do Next ({"error": ...}) preservando o status 401.
    try:
        user = await get_current_user(request)
    except HTTPException as exc:
        if exc.status_code == 401:
            # Next não diferencia: sessão ausente/expirada → "Não autenticado".
            return JSONResponse({"error": "Não autenticado"}, status_code=401)
        # 500 (sem AUTH_SECRET) ou outros: propaga como veio.
        raise

    # ── 2) Permissão (podeImportarConformidade) — 403 ─────────────────────────
    if user.role not in ROLES_CONFORMIDADE:
        return JSONResponse({"error": "Permissão negada"}, status_code=403)

    # ── 3) Corpo: await request.json() tolerante (body vazio permitido) ───────
    body: object = {}
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 — espelha o catch vazio do Next
        body = {}

    ttl_horas = _validar_body(body)
    if ttl_horas is None:
        return JSONResponse({"error": "Parâmetros inválidos"}, status_code=400)

    # ── 4) Gera o token (mesma lógica/clamp do gerarImportToken) ──────────────
    token, expira_em = _gerar_import_token(user.id, user.role, ttl_horas)

    return JSONResponse(
        {
            "token": token,
            "expiraEm": _js_to_iso_string(expira_em),
            "ttlHoras": ttl_horas,  # valor pedido (NÃO clampado) — paridade c/ Next
            "instrucoes": _INSTRUCOES,
        },
        status_code=200,
    )
