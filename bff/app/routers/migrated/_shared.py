"""Helpers CANÔNICOS compartilhados pelos routers migrados (estrangulador).

REGRA DE PARIDADE (leia ANTES de editar qualquer função deste módulo)
──────────────────────────────────────────────────────────────────────
Os routers de ``app/routers/migrated/`` espelham byte-a-byte as rotas
``app/src/app/api/**`` do Next.js — a suite e2e caixa-preta compara os corpos
JSON dos dois lados. Cada helper abaixo é a versão CANÔNICA de cópias que
existiam duplicadas (e IDÊNTICAS) em vários routers; alterar QUALQUER detalhe
de comportamento aqui (arredondamento, coerção, tratamento de NaN/None/"" )
muda bytes de resposta em dezenas de rotas ao mesmo tempo.

Regras:
  1. Só mova um helper de um router para cá se a cópia local for
     COMPORTAMENTALMENTE IDÊNTICA à canônica. Variantes divergentes (ex.:
     ``_serializar`` com ``Decimal→str``, ``_parse_int_js`` que propaga NaN
     como float) DEVEM permanecer locais no router que as usa.
  2. Nunca "melhore" a semântica JS replicada (Math.round half-up, parseInt
     com parse parcial de prefixo, truthiness de ``||``/``??``, flag()/num()
     do config.ts). O objetivo é ser bug-a-bug igual ao Next.
  3. Este módulo começa com ``_`` de propósito: ``include_migrated`` ignora
     módulos com esse prefixo ao descobrir routers (não é uma rota).

Conteúdo:
  - ``PROPONENTE_CNPJ``: constante espelhada de ``config.proponente.cnpj``.
  - ``js_round``: réplica de ``Math.round`` do JS.
  - ``serializar`` / ``serializar_row``: serializador JSON paritário
    (datetime→ISO, Decimal→str como o Drizzle, uuid→str, nativos passam).
  - ``parse_int_js_or_default``: ``parseInt(x ?? "<d>") || <d>`` do JS.
  - ``parse_int_js_nan_fallback``: ``parseInt(x ?? "<d>")`` com NaN→default.
  - ``flag`` / ``num``: réplicas dos helpers de ``src/lib/config.ts``.
  - ``feature_resultados_habilitada``:
    gates de feature lidos do ``settings`` com a semântica de ``flag()``.
"""

from __future__ import annotations

import math
import uuid as _uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from app.core.config import settings

# ── CNPJ Proponente ──────────────────────────────────────────────────────────────
# Espelha o DEFAULT de ``config.proponente.cnpj`` (src/lib/config.ts):
#   process.env.NEXT_PUBLIC_PROPONENTE_CNPJ ?? "11222333000181"
# Routers que replicam rotas onde o Next INLINA o default usam esta constante.
# Routers que espelham a leitura dinâmica da env (cron_cnpj_watch,
# cron_convocacao_watch, resultados_list) leem ``settings.proponente_cnpj``.
PROPONENTE_CNPJ = "11222333000181"


def js_round(x: float) -> float:
    """Replica o ``Math.round`` do JS (arredonda .5 para +Infinito).

    O ``round`` do Python usa banker's rounding (.5 -> par), o que divergiria do
    Next em valores como 2.5/0.05. ``Math.round(n) == floor(n + 0.5)`` — vale
    inclusive para negativos (Math.round(-0.5) === 0, Math.round(-1.5) === -1).
    """
    return math.floor(x + 0.5)


def serializar(valor: Any) -> Any:
    """Serializa um valor para JSON paritário com o Next/Drizzle.

    - ``datetime`` → ISO 8601 (``datetime.isoformat()``), igual ao Date do Next.
    - ``Decimal`` (pg ``numeric``) → ``str`` ("1234.50"): o driver do Next
      (Drizzle sem ``.mode``) devolve ``numeric`` como STRING; o asyncpg devolve
      ``Decimal``. Converter para string iguala o ``JSON.parse`` dos dois lados.
    - ``uuid.UUID`` → ``str()``.
    - ``dict``/``list`` (jsonb), ``int``/``float``, ``bool``/``str`` → nativo.
    - ``None`` → ``None``; demais tipos → ``str()``.

    NOTA de equivalência: as cópias locais que este helper substituiu vinham em
    duas formas — com branch explícito ``Decimal→str`` e sem ele. As duas eram
    JÁ idênticas em comportamento (sem o branch, ``Decimal`` caía no fallback
    ``str(valor)``, produzindo a MESMA string). Os branches explícitos ficam
    aqui por clareza, não por diferença de output.
    """
    if valor is None:
        return None
    if isinstance(valor, datetime):
        return valor.isoformat()
    if isinstance(valor, Decimal):
        return str(valor)
    if isinstance(valor, _uuid.UUID):
        return str(valor)
    if isinstance(valor, (dict, list, int, float, bool, str)):
        return valor
    return str(valor)


def serializar_row(row) -> dict[str, Any]:
    """Aplica :func:`serializar` a cada valor de um mapping (linha de query)."""
    return {chave: serializar(valor) for chave, valor in row.items()}


def parse_int_js_or_default(valor: str | None, default: int) -> int:
    """Replica ``parseInt(x ?? "<default>") || <default>`` do JS.

    parseInt do JS lê o prefixo numérico ("12abc" → 12) e, em caso de NaN/0
    inválido, o ``|| default`` cai no default. Aqui: tenta extrair o prefixo
    de dígitos (com sinal). Resultado 0 ou inválido → default (igual ao ``||``).
    """
    if valor is None:
        bruto = default
    else:
        s = valor.strip()
        # Extrai prefixo numérico inteiro (estilo parseInt): sinal opcional + dígitos.
        i = 0
        n = len(s)
        if i < n and s[i] in "+-":
            i += 1
        j = i
        while j < n and s[j].isdigit():
            j += 1
        if j == i:  # sem dígitos → NaN
            bruto = 0
        else:
            try:
                bruto = int(s[:j])
            except ValueError:
                bruto = 0
    # ``|| default``: 0 (ou NaN→0) cai no default.
    return bruto if bruto else default


def parse_int_js_nan_fallback(raw: str | None, fallback: int) -> int:
    """Replica ``parseInt(raw ?? "<fallback>")`` do JS (base 10, prefixo numérico).

    ``parseInt`` do JS lê o maior prefixo inteiro (com sinal opcional) e ignora
    o resto; ``""``/só-lixo → NaN. Aqui ``raw is None`` usa o fallback (o Next
    passa a string default ao parseInt) e NaN também cai no fallback.

    NÃO use esta variante quando a rota Next PROPAGA o NaN (Math.min/max com
    NaN, interval 'NaN months' → 500): esses routers mantêm variantes locais
    que devolvem ``float('nan')``.
    """
    if raw is None:
        return fallback
    s = raw.strip()
    i = 0
    if i < len(s) and s[i] in "+-":
        i += 1
    j = i
    while j < len(s) and s[j].isdigit():
        j += 1
    if j == i:
        return fallback  # NaN → fallback (paridade prática)
    try:
        return int(s[:j])
    except ValueError:
        return fallback


# ── Réplicas dos helpers de env de src/lib/config.ts (flag / num) ──────────────


def flag(value: str | None, default_enabled: bool) -> bool:
    """Réplica de ``flag`` (config.ts): ''/ausente → default; senão 'true'|'1'.

    ATENÇÃO: NÃO substituir por coerção bool do pydantic — ``flag("yes")`` é
    False no Next, mas ``bool`` do pydantic aceitaria "yes"/"on" como True.
    """
    if value is None or value == "":
        return default_enabled
    return value == "true" or value == "1"


def num(value: str | None, fallback: int) -> int:
    """Réplica de ``num`` (config.ts): ''/ausente → fallback; ignora não-numérico.

    ``Number(value)`` + ``Number.isFinite`` do Next: NaN/Infinity caem no
    fallback; "1.5" → 1 (truncado no int(), igual ao uso do Next em budgets).
    """
    if value is None or value == "":
        return fallback
    try:
        n = float(value)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(n):
        return fallback
    return int(n)


# ── Gates de feature (espelham config.features.* — flag(env, false)) ───────────


def feature_resultados_habilitada() -> bool:
    """Espelha ``config.features.resultados`` = flag(NEXT_PUBLIC_FEATURE_RESULTADOS, false).

    flag(): undefined/"" → default (False aqui); "true"/"1" → True; senão False.
    """
    return flag(settings.feature_resultados, False)
