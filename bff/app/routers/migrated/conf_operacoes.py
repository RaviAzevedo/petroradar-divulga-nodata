"""Rota migrada (strangler-fig): /api/conformidade/operacoes (GET + POST).

Espelho 1:1 de ``app/src/app/api/conformidade/operacoes/route.ts`` (+ os helpers
``listOperacoes``/``getOperacaoByCodigo`` de
``src/lib/conformidade/operacoes/queries.ts`` e os schemas de
``src/lib/conformidade/operacoes/validations.ts``) — a lista da Relação de
Operações (a obra como entidade, migration 0033) e o cadastro manual de uma
operação que não veio do catálogo.

──────────────────────────────────────────────────────────────────────────────
GUARDS (os DOIS handlers usam guards DIFERENTES — e com shapes de 403 diferentes)
──────────────────────────────────────────────────────────────────────────────
GET  → ``requireConformidade()`` == :data:`app.core.security.require_conformidade`
       (SOMENTE ADMIN, LIDER, SGI — P10 da reestruturação do acervo: a lista
       expõe ``valor``, e a rota estava vazando o cadastro comercial a 6 papéis
       via ``requireVisualizar``. Consequência declarada e aceita: o
       ``SeletorOperacao`` do upload perde ORCAMENTISTA/TECNICO — o front trata).
       401 ``{"error":"Não autenticado","code":"UNAUTHENTICATED"}``
       403 ``{"error":"Apenas Conformidade","code":"FORBIDDEN"}``
       (o ``code`` aparece porque no Next esse 403 sai do ``ApiError`` via
       ``handleApiError``; no BFF, do ``require_role`` reescrito por main.py).

POST → ``requireAuth()`` (SÓ 401) e SÓ DEPOIS a checagem MANUAL de papel
       ``podeGerenciarDocumentosHabilitacao(role)`` = isConformidade(role) ||
       ORCAMENTISTA || TECNICO = {ADMIN, LIDER, SGI, ORCAMENTISTA, TECNICO} —
       o MESMO gate do POST de documento no cofre, que é MAIS AMPLO que
       Conformidade.
       401 ``{"error":"Não autenticado","code":"UNAUTHENTICATED"}``
       403 ``{"error":"Permissão negada"}``  ← objeto de UMA chave, SEM ``code``
       (o Next devolve ``NextResponse.json({error}, {status:403})`` cru). Por
       isso NÃO usamos ``Depends(require_conformidade)`` nem ``HTTPException``:
       o handler de ``main.py`` acrescentaria ``"code":"FORBIDDEN"`` e o corpo
       divergiria. Ordem contratual: 401 SEMPRE antes de 403.

──────────────────────────────────────────────────────────────────────────────
SHAPE
──────────────────────────────────────────────────────────────────────────────
GET  200 ``{"operacoes":[{id, codigo, clienteNome, clienteGrupo, contratoNumero,
         unidade, area, detentora, periodoInicio, periodoFim, valor, escopo,
         totalDocumentos, totalAtestados, totalArtCat, totalContratos,
         disciplinas}], "total": int, "filtros": {...}, "semPeriodo": int}``
         — ``totalArtCat``/``totalContratos`` nasceram na 0034 (barra da ficha);
         ``totalAtestados`` MUDOU de semântica: aplica a regra da barra
         (exclui RASCUNHO/SUPERADA/CANCELADA/MODELO — 00-ARQUITETURA §1.2);
         ``area`` é da 0044 (B5) e entra ENTRE ``unidade`` e ``detentora``;
         ``filtros`` (eco do recorte APLICADO — chave ausente = filtro ausente) e
         ``semPeriodo`` são da 0044 (D11) e SEMPRE saem, mesmo sem recorte.
     400 ``{"error":"Parâmetros inválidos","detalhes":{campo: msg}}``
POST 201 a LINHA criada crua (todas as colunas em camelCase, como o
         ``.returning()`` do Drizzle — NÃO embrulhada em ``{"data":...}``)
     400 ``{"error":"JSON inválido"}``
     422 ``{"error":"Dados inválidos","detalhes":{campo: msg}}``
     409 ``{"error":"Já existe operação com esse código"}``

──────────────────────────────────────────────────────────────────────────────
SERIALIZAÇÃO (é onde a paridade morre — cada tipo tem uma regra própria)
──────────────────────────────────────────────────────────────────────────────
- ``timestamptz`` (criado_em/atualizado_em) → :func:`_js_to_iso_string`, que
  replica ``Date.toISOString()`` (UTC, MILISSEGUNDOS, sufixo ``Z``). NÃO
  ``isoformat()``, que daria ``+00:00`` e microssegundos.
- ``date`` (periodo_inicio/periodo_fim) → ``date.isoformat()`` = "YYYY-MM-DD".
  O Drizzle ``date()`` (mode default) entrega essa STRING; passar por
  ``_js_to_iso_string`` inventaria hora e quebraria a paridade.
- ``numeric`` (valor/hh) → ``str(Decimal)``: o Drizzle devolve numeric como
  STRING ("1234.50") e o asyncpg como ``Decimal``. Nunca number.
- ``uuid`` → ``str()`` (com guarda de None); ``jsonb`` → dict/list nativo;
  ``boolean``/``text`` → nativo.
- contagens → ``::int`` no SQL. O ``count`` do Postgres é bigint e o driver ``pg``
  do Next o entregaria como STRING — o Drizzle já castou para int no
  ``sql<number>`` de ``contagensPorOperacao``, e o ``count()`` do total tem
  ``mapWith(Number)``. Nos dois lados o JSON leva número.

──────────────────────────────────────────────────────────────────────────────
RÉPLICA DO ZOD v4.4.3 (mensagens conferidas executando os schemas REAIS)
──────────────────────────────────────────────────────────────────────────────
FiltrosOperacaoSchema (query; defaults aplicados ANTES do parse, com o ``??``):
    busca      z.string().max(200, "Busca muito longa").optional()
    comProva   resolvido FORA do zod pelo handler ("1"/"true" → true), então
               nunca gera erro de validação
    detentora  z.enum(DETENTORAS).optional()
    ativo      0044/D11 — TRI-ESTADO, resolvido FORA do zod como ``comProva``:
               "1"/"true" → só ativas; "0"/"false" → só inativas; AUSENTE →
               TODAS (o conjunto de antes da onda). Sem default que corte, e
               sem erro de validação possível
    de / ate   0044/D11 — z.string().refine(ehDataIso, "Data no formato
               AAAA-MM-DD").optional(), mais o ``superRefine`` ``de > ate`` →
               path "ate", "Data inicial maior que a final"
    limit      z.coerce.number().int().min(1).max(200).default(50)
    offset     z.coerce.number().int().min(0).default(0)

CriarOperacaoSchema (body JSON): ver :func:`_validar_criar_operacao`, que
carrega campo a campo a mensagem EXATA de cada regra. Os opcionais são
``.optional().nullable()``: ``null`` explícito é ACEITO e vira NULL na coluna,
mas ``detentora: null`` NÃO cai no default (é erro de enum) — por isso todo
teste é por PRESENÇA da chave (``in body``), nunca por ``body.get(x) is None``,
que confundiria "ausente" (received undefined) com "null" (received null).
"""

from __future__ import annotations

import json as _json
import math
import re
from datetime import date as _date, timezone
from decimal import Decimal
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
    require_conformidade,
)
from app.db.session import get_db
from app.services.audit import registrar_audit

router = APIRouter()


# ══════════════════════════════════════════════════════════════════════════════
# Permissões (réplica de src/lib/permissions.ts — cópia local, como nos irmãos)
# ══════════════════════════════════════════════════════════════════════════════


def _is_conformidade(role: str) -> bool:
    """``isConformidade(role)`` — ADMIN, LIDER, SGI."""
    return role in ROLES_CONFORMIDADE


def _pode_gerenciar_documentos_habilitacao(role: str) -> bool:
    """``podeGerenciarDocumentosHabilitacao(role)`` (permissions.ts:120).

    isConformidade(role) || role === ORCAMENTISTA || role === TECNICO
    → {ADMIN, LIDER, SGI, ORCAMENTISTA, TECNICO}. Cópia local idêntica à de
    ``conf_cofre_documentos.py:98`` — o gate do cadastro de operação é o MESMO
    do upload de prova.
    """
    return _is_conformidade(role) or role == ROLE_ORCAMENTISTA or role == ROLE_TECNICO


# ══════════════════════════════════════════════════════════════════════════════
# Serialização (cópias locais — origem: conf_cofre_documentos.py:117)
# ══════════════════════════════════════════════════════════════════════════════


def _js_to_iso_string(dt) -> str | None:
    """Replica ``new Date(dt).toISOString()`` (UTC, milissegundos, sufixo 'Z').

    O ``NextResponse.json`` serializa o ``Date`` do Drizzle via ``toISOString()``;
    o ``isoformat()`` do asyncpg daria ``+00:00`` e microssegundos. Só para
    ``timestamptz`` — colunas ``date`` usam :func:`_data_iso`.
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


def _data_iso(valor) -> str | None:
    """``date`` do Postgres → "YYYY-MM-DD" (o que o Drizzle ``date()`` devolve)."""
    if valor is None:
        return None
    if isinstance(valor, _date):
        return valor.isoformat()
    return str(valor)


def _numerico(valor) -> str | None:
    """``numeric`` → STRING ("1234.50"), que é como o Drizzle o entrega."""
    if valor is None:
        return None
    if isinstance(valor, Decimal):
        return str(valor)
    return str(valor)


# Colunas de ``operacoes`` na ordem do pgTable (schema.ts) → chave camelCase.
# A ordem existe para o dict de saída do 201 sair igual ao ``.returning()``.
_OPERACAO_COLS: tuple[tuple[str, str], ...] = (
    ("id", "id"),
    ("codigo", "codigo"),
    ("cliente_nome", "clienteNome"),
    ("cliente_grupo", "clienteGrupo"),
    ("cliente_cnpj", "clienteCnpj"),
    ("contrato_numero", "contratoNumero"),
    ("unidade", "unidade"),
    # 0044 (item B5): a ÁREA dentro da planta ("U-10", "Área 20",
    # "Off-site"). O Next devolve a coluna de graça (``getOperacaoById`` usa
    # ``select()`` cru e o PATCH usa ``.returning()``); sem esta tupla o
    # espelho omitiria a chave e R3/POST/PATCH divergiriam entre dev (Next) e
    # produção (BFF) — o MESMO buraco em que ``detentora_cnpj`` caiu desde a
    # 0043 (spec ONDA-5 §1k). Posição: a do pgTable, entre ``unidade`` e
    # ``detentora`` (schema.ts:1107) — a ordem das chaves é contrato.
    ("area", "area"),
    ("detentora", "detentora"),
    # 0043 (item B4): CNPJ do estabelecimento detentor. O Next devolve a coluna
    # porque le a linha inteira (getOperacaoById usa select() sem lista e o PATCH
    # usa .returning()); sem esta linha o espelho omitia a chave e R1/R3/POST/PATCH
    # divergiam entre dev (Next) e producao (BFF).
    ("detentora_cnpj", "detentoraCnpj"),
    ("ramo", "ramo"),
    ("onshore_offshore", "onshoreOffshore"),
    ("periodo_inicio", "periodoInicio"),
    ("periodo_fim", "periodoFim"),
    ("valor", "valor"),
    ("hh", "hh"),
    ("escopo", "escopo"),
    ("familias_sugeridas", "familiasSugeridas"),
    ("origem", "origem"),
    ("ativo", "ativo"),
    ("criado_em", "criadoEm"),
    ("atualizado_em", "atualizadoEm"),
)

_OPERACAO_SELECT = ", ".join(col for col, _camel in _OPERACAO_COLS)


def _serializar_operacao(row) -> dict[str, Any]:
    """Linha de ``operacoes`` → dict camelCase com a serialização de cada tipo."""
    out: dict[str, Any] = {}
    for col, camel in _OPERACAO_COLS:
        v = row[col]
        if col == "id":
            out[camel] = str(v) if v is not None else None
        elif col in ("periodo_inicio", "periodo_fim"):
            out[camel] = _data_iso(v)
        elif col in ("valor", "hh"):
            out[camel] = _numerico(v)
        elif col in ("criado_em", "atualizado_em"):
            out[camel] = _js_to_iso_string(v)
        else:
            out[camel] = v
    return out


# ══════════════════════════════════════════════════════════════════════════════
# Réplica do Zod v4.4.3 — mensagens e coerções
# ══════════════════════════════════════════════════════════════════════════════

_DETENTORAS = ("PROPONENTE", "COLIGADA", "PARCEIRO")

# Mensagens CUSTOM em pt-BR (operacoes/validations.ts). Copiadas literalmente:
# qualquer diferença de acento/pontuação aparece no ``detalhes`` do 4xx.
_MSG_BUSCA_LONGA = "Busca muito longa"
_MSG_CODIGO = (
    "Código inválido. Use de 2 a 32 caracteres entre letras, números, "
    "ponto, hífen e sublinhado."
)
_MSG_CLIENTE_CURTO = "Nome do cliente deve ter pelo menos 2 caracteres"
_MSG_CLIENTE_LONGO = "Nome do cliente muito longo"
_MSG_GRUPO_LONGO = "Grupo do cliente muito longo"
_MSG_CNPJ = "CNPJ deve conter 14 dígitos"
_MSG_CONTRATO_LONGO = "Número do contrato muito longo"
_MSG_UNIDADE_LONGA = "Unidade muito longa"
# 0044 (B5): área da planta — texto livre, teto 200 como ``unidade``.
_MSG_AREA_LONGA = "Área muito longa"
# 0044 (D11): a janela de período do índice. Mensagem DIFERENTE da de
# ``periodoInicio``/``periodoFim`` do POST (_MSG_DATA) — são dois schemas
# distintos e as duas strings vão à tela campo a campo.
_MSG_DATA_JANELA = "Data no formato AAAA-MM-DD"
_MSG_JANELA_INVERTIDA = "Data inicial maior que a final"
_MSG_RAMO_LONGO = "Ramo muito longo"
_MSG_ONOFF_LONGO = "Valor muito longo"
_MSG_DATA = "Data inválida. Use o formato AAAA-MM-DD."
_MSG_VALOR_NEGATIVO = "Valor não pode ser negativo"
_MSG_VALOR_TETO = "Valor excede o limite permitido"
_MSG_HH_NEGATIVO = "HH não pode ser negativo"
_MSG_HH_TETO = "HH excede o limite permitido"
_MSG_ESCOPO_LONGO = "Escopo muito longo"
_MSG_FAMILIA_LONGA = "Código de família muito longo"
_MSG_FAMILIAS_MAX = "Máximo de 200 famílias sugeridas"

# Tetos do domínio (iguais aos do valorMonetarioSchema do cofre / numeric(14,2)).
_TETO_VALOR = 999_999_999_999_99
_TETO_HH = 999_999_999_999
_MAX_FAMILIAS = 200

_CODIGO_REGEX = re.compile(r"^[A-Za-z0-9._-]{2,32}$")
_CNPJ_REGEX = re.compile(r"^\d{14}$")
# "AAAA-MM-DD" — as colunas periodo_* são ``date``, não ``timestamptz``.
_DATA_REGEX = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _eh_data_iso(valor: str) -> bool:
    """Réplica de ``ehDataIso`` (operacoes/validations.ts:68).

    Formato E calendário: "2020-13-01" e "2019-02-31" passam na regex e o
    Postgres os recusaria com 22008 — 500 em vez de 400. O Next confere
    reconstruindo a data (``new Date(...).toISOString().slice(0,10) === v``);
    aqui o ``date.fromisoformat`` faz o mesmo serviço, como já faz o
    ``_data_opt`` do POST.
    """
    if not isinstance(valor, str) or not _DATA_REGEX.match(valor):
        return False
    try:
        _date.fromisoformat(valor)
    except ValueError:
        return False
    return True


def _para_date(valor):
    """"YYYY-MM-DD" → ``datetime.date`` para o bind do asyncpg (None passa).

    O driver exige o objeto quando o Postgres tipa o parâmetro como date; a
    validação de formato já rodou em ``_validar_data``, então aqui um valor
    inesperado volta como veio e deixa o erro aparecer no lugar certo.
    """
    if not isinstance(valor, str):
        return valor
    try:
        return _date.fromisoformat(valor)
    except ValueError:
        return valor

# ``.int()`` do Zod v4 também exige o intervalo de inteiro SEGURO do JS; fora
# dele a mensagem é de int (e não de min/max do campo).
_MAX_SAFE_INT = 9007199254740991


def _js_tipo(valor: Any) -> str:
    """Nome do tipo no estilo JS (p/ 'received <tipo>' das mensagens do Zod v4)."""
    if valor is None:
        return "null"
    if isinstance(valor, bool):
        return "boolean"
    if isinstance(valor, float) and math.isnan(valor):
        return "NaN"
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


def _zod_expected_undefined(esperado: str) -> str:
    return f"Invalid input: expected {esperado}, received undefined"


def _zod_enum_msg(valores: tuple[str, ...]) -> str:
    """``Invalid option: expected one of "A"|"B"`` (aspas duplas, sem espaços)."""
    return "Invalid option: expected one of " + "|".join(f'"{v}"' for v in valores)


# Regex de números aceitos pelo ``Number()`` do JS na forma decimal.
_JS_NUM_DEC = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")
_JS_NUM_HEX = re.compile(r"^0[xX][0-9a-fA-F]+$")
_JS_NUM_BIN = re.compile(r"^0[bB][01]+$")
_JS_NUM_OCT = re.compile(r"^0[oO][0-7]+$")


def _js_number(valor: str) -> float:
    """Réplica de ``Number(string)`` do JS (o que ``z.coerce.number()`` faz).

    Diferenças que o ``float()`` do Python NÃO cobre e que mudam a resposta:
      - ``Number("")``/só-espaços → 0 (não erro);
      - ``Number("0x10")`` → 16, e idem 0b/0o (o ``float()`` recusaria);
      - ``Number("Infinity")`` → ±∞ (o Zod recusa depois, com mensagem própria);
      - ``Number("1_0")``/``Number("nan")``/``Number("inf")`` → NaN, enquanto o
        ``float()`` do Python aceitaria os três (underscore, nan e inf).
    """
    s = valor.strip()
    if s == "":
        return 0.0
    if s in ("Infinity", "+Infinity"):
        return math.inf
    if s == "-Infinity":
        return -math.inf
    if _JS_NUM_HEX.match(s):
        return float(int(s, 16))
    if _JS_NUM_BIN.match(s):
        return float(int(s, 2))
    if _JS_NUM_OCT.match(s):
        return float(int(s, 8))
    if not _JS_NUM_DEC.match(s):
        return math.nan
    return float(s)


def _validar_coerce_int(
    raw: str, campo: str, minimo: int, maximo: int | None, detalhes: dict[str, str]
) -> int | None:
    """``z.coerce.number().int().min(minimo)[.max(maximo)]`` (Zod v4.4.3).

    ORDEM das checagens (conferida executando o schema real — inverter a ordem
    troca a mensagem):
      1. NaN            → "Invalid input: expected number, received NaN"
      2. ±Infinity      → "Invalid input: expected number, received number"
         (o tipo ``number`` do Zod v4 exige finito; a mensagem é de TIPO)
      3. não-inteiro    → "Invalid input: expected int, received number"
      4. fora do inteiro seguro → "Too big/small: expected int to be <=/>=…"
      5. < min          → "Too small: expected number to be >=N"
      6. > max          → "Too big: expected number to be <=N"

    ATENÇÃO — 4, 5 e 6 ACUMULAM no mesmo path e a ÚLTIMA vence: o Zod v4 não
    aborta no inteiro-seguro, ele segue avaliando min/max, e o
    ``formatZodErrors`` (cofre/validations.ts:136) é um reduce
    ``acc[path] = issue.message``. Medido com o ``FiltrosOperacaoSchema`` real:
      ``limit=1e30``  → duas issues, vence "Too big: expected number to be <=200"
      ``limit=-1e30`` → vence "Too small: expected number to be >=1"
      ``offset=1e30`` → UMA issue (offset não tem ``.max()``), fica a do int-seguro
    Por isso a mensagem é acumulada numa variável em vez de retornar na hora —
    retornar no primeiro check devolvia a mensagem do int-seguro e divergia do Next.
    """
    num = _js_number(raw)
    if math.isnan(num):
        detalhes[campo] = "Invalid input: expected number, received NaN"
        return None
    if math.isinf(num):
        detalhes[campo] = "Invalid input: expected number, received number"
        return None
    if num != math.floor(num):
        detalhes[campo] = "Invalid input: expected int, received number"
        return None

    msg: str | None = None
    if num > _MAX_SAFE_INT:
        msg = f"Too big: expected int to be <={_MAX_SAFE_INT}"
    elif num < -_MAX_SAFE_INT:
        msg = f"Too small: expected int to be >=-{_MAX_SAFE_INT}"

    # int() de um float gigante não estoura em Python; o valor só serve para
    # comparar com min/max, e quem passou do inteiro seguro já falha de todo jeito.
    n = int(num)
    if n < minimo:
        msg = f"Too small: expected number to be >={minimo}"
    elif maximo is not None and n > maximo:
        msg = f"Too big: expected number to be <={maximo}"

    if msg is not None:
        detalhes[campo] = msg
        return None
    return n


def _json_loads_js(bruto: bytes) -> Any:
    """``JSON.parse`` do JS: ``NaN``/``Infinity`` NUS são erro de sintaxe.

    O ``json.loads`` do Python aceita os três literais por padrão e o body
    ``{"valor": NaN}`` viraria 422 aqui e 400 ("JSON inválido") no Next.
    """

    def _rejeita(_constante: str):
        raise ValueError("constante JSON não permitida (NaN/Infinity)")

    return _json.loads(bruto, parse_constant=_rejeita)


# ══════════════════════════════════════════════════════════════════════════════
# GET — lista da Relação de Operações (== handler GET + listOperacoes)
# ══════════════════════════════════════════════════════════════════════════════

# Subconsulta agregada de ``contagensPorOperacao()``: uma linha por operação.
# ``count(*)::int`` (e não ``count(*)``) porque bigint chegaria como STRING no
# driver do Next — o Drizzle já emite o cast, e aqui ele é o mesmo.
#
# 0034 — regra da BARRA de comprovação (00-ARQUITETURA §1.2): rascunho/superada/
# cancelada/modelo NÃO contam (NULL conta — legado anterior à 0034). O fallback
# por ``papel`` quando ``tipo_documento IS NULL`` cobre os legados do
# backfill da 0033 — sem ele a barra da onda O1 nasceria zerada. SEM predicado
# restrito aqui de propósito: com P10 só Conformidade chega nesta rota, e
# Conformidade vê tudo (§3.2).
_CONTA_NA_BARRA = (
    "(situacao_prova IS NULL OR situacao_prova IN "
    "('ASSINADA_PROPONENTE','ASSINADA_CLIENTE','INDEFINIDA'))"
)

_CONTAGENS_SQL = f"""
        LEFT JOIN (
          SELECT
            operacao_id,
            count(*)::int AS total_documentos,
            count(*) FILTER (WHERE {_CONTA_NA_BARRA}
              AND (tipo_documento = 'ATESTADO'
                   OR (tipo_documento IS NULL AND papel = 'ATESTADO'))
            )::int AS total_atestados,
            count(*) FILTER (WHERE {_CONTA_NA_BARRA}
              AND (tipo_documento IN ('ART','CAT')
                   OR (tipo_documento IS NULL AND papel = 'CAT_ART'))
            )::int AS total_art_cat,
            count(*) FILTER (WHERE {_CONTA_NA_BARRA}
              AND (tipo_documento IN ('CONTRATO','ADITIVO','ANEXO_CONTRATO')
                   OR (tipo_documento IS NULL AND papel IN ('CONTRATO','ADITIVO')))
            )::int AS total_contratos
          FROM documentos_habilitacao
          WHERE operacao_id IS NOT NULL
          GROUP BY operacao_id
        ) contagens ON contagens.operacao_id = o.id
"""


# 0043 (onda 4) — DISCIPLINAS da operacao, por SUBCONSULTA CORRELACIONADA.
#
# Espelho LITERAL do ``sql`` de ``listOperacoes`` (operacoes/queries.ts). Nao e
# JOIN de proposito: um ``LEFT JOIN operacao_disciplinas`` no SELECT principal
# multiplicaria as linhas e, com elas, os QUATRO agregados de ``contagens``
# (total_documentos/atestados/art_cat/contratos) — o erro Q10.5, que corromperia
# a barra de comprovacao da ficha e a coluna do indice. A subconsulta e avaliada
# por linha de operacao e nao entra no FROM, entao nao ha como multiplicar.
#
# Dois detalhes que NAO sao estilo:
#   - ``ORDER BY d.ordem, d.codigo`` vai DENTRO do ``json_agg``: fora dele o
#     Postgres nao aplica a ordem ao array, e a ordem dos chips mudaria entre
#     chamadas e entre Next e BFF (paridade quebrada em silencio);
#   - ``coalesce(..., '[]'::json)``: operacao sem disciplina sai com array
#     VAZIO, nunca null — o cliente nao distingue "nao tem" de "nao veio".
_DISCIPLINAS_SQL = """(
            SELECT coalesce(json_agg(json_build_object('id', d.id, 'codigo', d.codigo, 'nome', d.nome)
                                     ORDER BY d.ordem, d.codigo), '[]'::json)
              FROM operacao_disciplinas od
              JOIN disciplinas d ON d.id = od.disciplina_id
             WHERE od.operacao_id = o.id
          )"""


def _disciplinas_do_agg(valor: Any) -> list[dict[str, str]]:
    """``json_agg`` -> lista de ``{id, codigo, nome}`` com ``uuid`` como string.

    O dialeto asyncpg do SQLAlchemy registra codec de ``json``/``jsonb``, entao
    o normal e ja chegar lista. Aceitamos ``str`` tambem porque um ambiente sem
    o codec devolveria o texto cru — e ai a chave viraria uma STRING no JSON da
    resposta, divergindo do Next sem nenhum erro visivel. ``None`` nunca ocorre
    (o ``coalesce`` do SQL garante ``[]``), mas vira ``[]`` por seguranca: a
    chave e contrato de ARRAY.
    """
    if valor is None:
        return []
    if isinstance(valor, str):
        valor = _json.loads(valor)
    return [
        {"id": str(d["id"]), "codigo": d["codigo"], "nome": d["nome"]} for d in valor
    ]


def _validar_filtros(qp) -> tuple[dict[str, Any], dict[str, str]]:
    """Réplica de ``FiltrosOperacaoSchema.safeParse({... ?? default})``.

    Recebe algo com ``.get(chave)`` no estilo do ``searchParams`` (Starlette
    devolve ``None`` para AUSENTE e ``''`` para presente-e-vazio) e devolve
    ``(filtros, detalhes)``. Função separada do handler porque é ela que carrega
    toda a mania do Zod — e assim dá para conferi-la contra o schema real sem
    subir banco.
    """
    # PARIDADE do ``??``: ``searchParams.get(k)`` devolve '' quando o param está
    # PRESENTE-mas-vazio e null só quando AUSENTE — o ``??`` só troca o null.
    # Nada de truthiness Python aqui: '' tem de chegar ao validador.
    # PRIMEIRA ocorrência, não a última: com o parâmetro repetido
    # (``?busca=a&busca=b``) o ``URLSearchParams.get`` do JS — que é o que o
    # ``request.nextUrl.searchParams`` do Next usa — devolve "a", enquanto o
    # ``QueryParams.get`` do Starlette devolve "b" (o ImmutableMultiDict monta
    # ``_dict`` por dict-comprehension sobre a lista ordenada, e o último vence).
    # ``getlist()[0]`` alinha os dois lados.
    def _qp_opt(k: str) -> str | None:
        valores = qp.getlist(k)
        return valores[0] if valores else None

    def _qp_def(k: str, default: str) -> str:
        v = _qp_opt(k)
        return default if v is None else v

    detalhes: dict[str, str] = {}

    # busca: z.string().max(200, "Busca muito longa").optional() — '' é válido.
    busca = _qp_opt("busca")
    if busca is not None and len(busca) > 200:
        detalhes["busca"] = _MSG_BUSCA_LONGA

    # comProva: o handler do Next resolve a flag ANTES do zod ("1"/"true" → true,
    # qualquer outra coisa → false), então este campo NUNCA gera erro 400.
    com_prova_raw = _qp_opt("comProva")
    com_prova = com_prova_raw == "1" or com_prova_raw == "true"

    # detentora: z.enum(DETENTORAS).optional() ('' → erro de enum).
    detentora = _qp_opt("detentora")
    if detentora is not None and detentora not in _DETENTORAS:
        detalhes["detentora"] = _zod_enum_msg(_DETENTORAS)

    # 0044 (D11) — ``ativo``: TRI-ESTADO resolvido FORA do zod, igual ao
    # ``comProva`` acima. "1"/"true" → True (só ativas); "0"/"false" → False (só
    # inativas); AUSENTE — e qualquer outro valor — → None, e aí NENHUMA condição
    # é empilhada: o conjunto devolvido continua sendo o de hoje (ativas E
    # inativas). Um default True aqui seria o corte escondido que o D11 existe
    # para não repetir (spec ONDA-5 §1c); por ser lido fora do zod, este campo
    # NUNCA gera erro de validação.
    ativo_raw = _qp_opt("ativo")
    if ativo_raw == "1" or ativo_raw == "true":
        ativo: bool | None = True
    elif ativo_raw == "0" or ativo_raw == "false":
        ativo = False
    else:
        ativo = None

    # 0044 (D11) — janela sobre o PERÍODO da obra, ambos ausentes por padrão:
    # z.string().refine(ehDataIso, "Data no formato AAAA-MM-DD").optional().
    # Param PRESENTE-e-vazio ('') chega ao validador e vira 400 (o ``?? undefined``
    # do Next só troca o null), como nos irmãos acima.
    de = _qp_opt("de")
    if de is not None and not _eh_data_iso(de):
        detalhes["de"] = _MSG_DATA_JANELA

    ate = _qp_opt("ate")
    if ate is not None and not _eh_data_iso(ate):
        detalhes["ate"] = _MSG_DATA_JANELA

    # limit: 1..200, default 50 (a lista alimenta um seletor, não um relatório).
    limit_v = _validar_coerce_int(_qp_def("limit", "50"), "limit", 1, 200, detalhes)

    # offset: >=0, default 0 (paginação por offset, não por page).
    offset_v = _validar_coerce_int(_qp_def("offset", "0"), "offset", 0, None, detalhes)

    # ``superRefine`` do schema (de > ate). DUAS manias do zod v4.4.3 medidas
    # executando o schema real, e as duas mudam o corpo do 400:
    #   1. o check de objeto roda MESMO quando um campo falhou o refine — então
    #      ``?de=2020-13-01&ate=2019-01-01`` sai com os DOIS erros, não só o de
    #      formato; a comparação é sobre as STRINGS CRUAS que chegaram;
    #   2. ele vem DEPOIS dos checks de campo e o ``formatZodErrors`` é um reduce
    #      (``acc[path] = msg``): duas issues no path "ate" → a ÚLTIMA vence.
    # Por isso este bloco fica no fim e SOBRESCREVE ``detalhes["ate"]``.
    # Comparação de string vale porque o formato é AAAA-MM-DD (ordem
    # lexicográfica == cronológica); truthiness do JS: '' não dispara o check.
    if de and ate and de > ate:
        detalhes["ate"] = _MSG_JANELA_INVERTIDA

    filtros = {
        "busca": busca,
        "comProva": com_prova,
        "detentora": detentora,
        # 0044 (D11): os três recortes explícitos. ``ativo`` é None quando
        # ausente (sem condição), ``de``/``ate`` são None quando ausentes.
        "ativo": ativo,
        "de": de,
        "ate": ate,
        "limit": limit_v if limit_v is not None else 50,
        "offset": offset_v if offset_v is not None else 0,
    }
    return filtros, detalhes


@router.get("/api/conformidade/operacoes")
async def listar_operacoes(
    request: Request,
    # P10: era require_visualizar; a lista expõe ``valor`` e ficou restrita a
    # Conformidade (403 ``Apenas Conformidade`` COM code — guard que LANÇA).
    user: CurrentUser = Depends(require_conformidade),
    db=Depends(get_db),
) -> JSONResponse:
    """Lista operações com busca/filtros e a contagem de provas de cada uma.

    A lista enxerga TODAS as operações do catálogo; quem quiser só as que já
    têm prova passa ``comProva=1`` — é assim que a tela do cofre agrupa por obra
    sem perder a busca no acervo inteiro.

    0044 (D11): o histórico passou a ser RECORTE EXPLÍCITO — ``ativo`` (tri-estado)
    e a janela ``de``/``ate`` sobre o período da obra. Nenhum deles tem default que
    corte: sem parâmetro o conjunto devolvido é EXATAMENTE o de antes da onda
    (ativas E inativas, sem janela). O que foi aplicado volta ecoado em
    ``filtros`` e o que a janela não pôde avaliar volta contado em ``semPeriodo``
    — número que existe para a conta fechar na tela (spec ONDA-5 §1c/§5.7).
    """
    filtros, detalhes = _validar_filtros(request.query_params)
    if detalhes:
        return JSONResponse(
            status_code=400,
            content={"error": "Parâmetros inválidos", "detalhes": detalhes},
        )

    busca = filtros["busca"]
    detentora = filtros["detentora"]
    com_prova = filtros["comProva"]
    # 0044 (D11) — os três recortes explícitos (None = filtro ausente).
    ativo = filtros["ativo"]
    de = filtros["de"]
    ate = filtros["ate"]
    limit = filtros["limit"]
    offset = filtros["offset"]

    # ── WHERE (fragmentos com literais internos; valores em named param) ──────
    conds: list[str] = []
    params: dict[str, Any] = {}

    if busca:
        # Busca única sobre código, cliente e nº do contrato: é como o usuário
        # procura a obra ("12345", "Petrobras", "1234567890").
        params["busca"] = f"%{busca}%"
        conds.append(
            "(o.codigo ILIKE :busca OR o.cliente_nome ILIKE :busca "
            "OR o.contrato_numero ILIKE :busca)"
        )

    if detentora:
        params["detentora"] = detentora
        conds.append("o.detentora = :detentora")

    if com_prova:
        # gt(contagens.totalDocumentos, 0): predicado sobre a subconsulta, que
        # faz o LEFT JOIN se comportar como INNER (NULL > 0 é NULL → fora).
        conds.append("contagens.total_documentos > 0")

    # 0044 (D11): recorte explícito. ``None`` não empilha condição nenhuma — o
    # conjunto de hoje continua sendo o default (spec ONDA-5 §1c).
    if ativo is not None:
        params["ativo"] = ativo
        conds.append("o.ativo = :ativo")

    # Fotografia do recorte ANTES da janela: é sobre ela que ``semPeriodo`` conta
    # (mesma busca, mesma detentora, mesmo ``comProva``, mesmo ``ativo`` — só sem
    # o período), senão o número que "explica a diferença" seria de outro
    # conjunto. Cópia rasa das DUAS estruturas: a lista e o dicionário de binds,
    # porque a terceira query não pode receber ``:de``/``:ate`` que o seu SQL não
    # tem.
    conds_sem_janela = list(conds)
    params_sem_janela = dict(params)

    # Janela: a obra tem de ter os DOIS extremos para ser comparável; obra sem
    # período fica FORA e é CONTADA à parte (``semPeriodo``), nunca some calada.
    # ⚠️ ``CAST(:x AS date)`` e NUNCA ``:x::date`` — o ``::`` colado no bind não
    # compila no ``text()``; e o bind vai como ``datetime.date`` (com o CAST o
    # Postgres tipa o parâmetro como date e o asyncpg exige o objeto, não a
    # string — a mesma armadilha documentada no INSERT do POST).
    if de:
        params["de"] = _para_date(de)
        conds.append("o.periodo_fim IS NOT NULL AND o.periodo_fim >= CAST(:de AS date)")
    if ate:
        params["ate"] = _para_date(ate)
        conds.append(
            "o.periodo_inicio IS NOT NULL AND o.periodo_inicio <= CAST(:ate AS date)"
        )

    where_sql = (" WHERE " + " AND ".join(conds)) if conds else ""

    sql_rows = text(
        f"""
        SELECT
          o.id, o.codigo, o.cliente_nome, o.cliente_grupo, o.contrato_numero,
          o.unidade,
          -- 0044 (B5): a área da planta, entre ``unidade`` e ``detentora`` — a
          -- posição do select do Drizzle em listOperacoes (queries.ts:176).
          o.area,
          o.detentora, o.periodo_inicio, o.periodo_fim, o.valor,
          o.escopo,
          coalesce(contagens.total_documentos, 0) AS total_documentos,
          coalesce(contagens.total_atestados, 0)  AS total_atestados,
          coalesce(contagens.total_art_cat, 0)    AS total_art_cat,
          coalesce(contagens.total_contratos, 0)  AS total_contratos,
          {_DISCIPLINAS_SQL} AS disciplinas
        FROM operacoes o
        {_CONTAGENS_SQL}
        {where_sql}
        ORDER BY o.codigo ASC
        LIMIT :limit OFFSET :offset
        """
    )
    rows = (
        await db.execute(sql_rows, {**params, "limit": limit, "offset": offset})
    ).mappings().all()

    # O total repete o MESMO join (o Next também): a subconsulta é 1:1 por
    # operação, então ela não multiplica linha — mas o WHERE de comProva depende
    # dela, e é o mesmo objeto ``where`` nas duas queries do Drizzle.
    sql_total = text(
        f"SELECT count(*)::int AS total FROM operacoes o {_CONTAGENS_SQL} {where_sql}"
    )
    total_row = (await db.execute(sql_total, params)).mappings().first()
    total = total_row["total"] if total_row and total_row["total"] is not None else 0

    # 0044 (D11) — ``semPeriodo``: quantas obras a janela NÃO pôde avaliar por
    # não terem um dos extremos. Só existe quando ``de``/``ate`` vieram: sem
    # janela NENHUMA query extra roda e o número é 0 literal (§4.7), que é o que
    # mantém o custo da lista igual ao de antes da onda para quem não recorta.
    sem_periodo = 0
    if de or ate:
        conds_sp = conds_sem_janela + [
            "(o.periodo_inicio IS NULL OR o.periodo_fim IS NULL)"
        ]
        sql_sem_periodo = text(
            f"SELECT count(*)::int AS total FROM operacoes o {_CONTAGENS_SQL} "
            f" WHERE {' AND '.join(conds_sp)}"
        )
        sp_row = (
            await db.execute(sql_sem_periodo, params_sem_janela)
        ).mappings().first()
        sem_periodo = sp_row["total"] if sp_row and sp_row["total"] is not None else 0

    operacoes = [
        {
            "id": str(r["id"]),
            "codigo": r["codigo"],
            "clienteNome": r["cliente_nome"],
            "clienteGrupo": r["cliente_grupo"],
            "contratoNumero": r["contrato_numero"],
            "unidade": r["unidade"],
            # 0044 (B5): chave nova entre ``unidade`` e ``detentora`` — a MESMA
            # posição do select do Drizzle. Sai ``null`` quando vazia, nunca "".
            "area": r["area"],
            "detentora": r["detentora"],
            "periodoInicio": _data_iso(r["periodo_inicio"]),
            "periodoFim": _data_iso(r["periodo_fim"]),
            "valor": _numerico(r["valor"]),
            "escopo": r["escopo"],
            "totalDocumentos": r["total_documentos"],
            "totalAtestados": r["total_atestados"],
            # 0034 — contadores da barra (mesma subquery; chaves novas no fim).
            "totalArtCat": r["total_art_cat"],
            "totalContratos": r["total_contratos"],
            # 0043 — disciplinas da obra: SEMPRE array (o coalesce garante), na
            # ordem do catalogo. Alimenta o card do painel (C5) e o filtro
            # client-side da tela de operacoes.
            "disciplinas": _disciplinas_do_agg(r["disciplinas"]),
        }
        for r in rows
    ]

    # 0044 (D11) — ECO do recorte: só o que foi APLICADO (chave AUSENTE = filtro
    # ausente, nunca ``null``), na ordem do contrato: busca > detentora >
    # comProva > ativo > de > ate > limit > offset. É a mesma ordem em que o
    # objeto é montado no Next (queries.ts:225-234) e é ela que a tela lê para
    # escrever a frase do cabeçalho sem adivinhar (§5.7).
    filtros_aplicados: dict[str, Any] = {}
    if busca:
        filtros_aplicados["busca"] = busca
    if detentora:
        filtros_aplicados["detentora"] = detentora
    filtros_aplicados["comProva"] = com_prova
    if ativo is not None:
        filtros_aplicados["ativo"] = ativo
    if de:
        filtros_aplicados["de"] = de
    if ate:
        filtros_aplicados["ate"] = ate
    filtros_aplicados["limit"] = limit
    filtros_aplicados["offset"] = offset

    return JSONResponse(
        content={
            "operacoes": operacoes,
            "total": total,
            "filtros": filtros_aplicados,
            # Sempre presente (0 quando não há janela) — chave nova no fim do
            # corpo, como o Next a devolve.
            "semPeriodo": sem_periodo,
        }
    )


# ══════════════════════════════════════════════════════════════════════════════
# POST — cadastro manual de operação (== handler POST do route.ts)
# ══════════════════════════════════════════════════════════════════════════════


@router.post("/api/conformidade/operacoes")
async def criar_operacao(
    request: Request,
    # requireAuth() → 401. O papel é checado À MÃO logo abaixo para reproduzir o
    # 403 SEM ``code`` do Next (ver bloco GUARDS do docstring do módulo).
    user: CurrentUser = Depends(get_current_user),
    db=Depends(get_db),
) -> JSONResponse:
    """Cria uma operação digitada na tela (origem='MANUAL').

    Ordem das checagens (igual ao Next):
      1. requireAuth() → 401 (via get_current_user).
      2. podeGerenciarDocumentosHabilitacao(role) → 403 ``Permissão negada``.
      3. body JSON → 400 ``JSON inválido``.
      4. CriarOperacaoSchema → 422 ``Dados inválidos`` + detalhes.
      5. unicidade do código → 409.
      6. INSERT ... RETURNING → audit_log → commit → 201 com a linha criada.
    """
    if not _pode_gerenciar_documentos_habilitacao(user.role):
        return JSONResponse(status_code=403, content={"error": "Permissão negada"})

    try:
        body = _json_loads_js(await request.body())
    except Exception:  # noqa: BLE001 — JSON malformado
        return JSONResponse(status_code=400, content={"error": "JSON inválido"})

    parsed = _validar_criar_operacao(body)
    if parsed.get("__erros__"):
        return JSONResponse(
            status_code=422,
            content={"error": "Dados inválidos", "detalhes": parsed["__erros__"]},
        )
    data = parsed["data"]

    # ── Unicidade do código (UNIQUE simples na coluna, comparação exata) ──────
    existente = (
        await db.execute(
            text("SELECT id FROM operacoes WHERE codigo = :codigo LIMIT 1"),
            {"codigo": data["codigo"]},
        )
    ).first()
    if existente is not None:
        return JSONResponse(
            status_code=409,
            content={"error": "Já existe operação com esse código"},
        )

    # ── INSERT ────────────────────────────────────────────────────────────────
    # CAST explícito em numeric/jsonb: sem ele o Postgres infere o tipo do
    # parâmetro pela coluna de destino. A forma ``:x::numeric`` NÃO serve — o
    # ``::`` colado no bind não compila no ``text()`` do SQLAlchemy.
    #
    # DATE É O CASO CONTRÁRIO — e o CAST sozinho PIORA: com ``CAST(:x AS date)``
    # o Postgres tipa o bind como date, o asyncpg passa a exigir um
    # ``datetime.date`` e estoura DataError ("'str' object has no attribute
    # 'toordinal'") ANTES de chegar ao banco. Resultado medido: todo
    # POST com periodoInicio/periodoFim devolvia 500, enquanto o espelho Next
    # (Drizzle date() em string-mode) devolvia 201 — quebra de paridade.
    # Por isso a string vira ``date`` aqui. O formato já foi validado por
    # ``_validar_data`` (regex + ``date.fromisoformat``), então não relança.
    insert_params = {
        "codigo": data["codigo"],
        "cliente_nome": data["clienteNome"],
        "cliente_grupo": data.get("clienteGrupo"),
        "cliente_cnpj": data.get("clienteCnpj"),
        "contrato_numero": data.get("contratoNumero"),
        "unidade": data.get("unidade"),
        # 0044 (B5): ``data.area ?? null`` do Next — ``.get`` já devolve None.
        "area": data.get("area"),
        "detentora": data["detentora"],
        "ramo": data.get("ramo"),
        "onshore_offshore": data.get("onshoreOffshore"),
        "periodo_inicio": _para_date(data.get("periodoInicio")),
        "periodo_fim": _para_date(data.get("periodoFim")),
        # numeric via STRING: réplica do ``numeroParaNumeric`` (String(valor)) do
        # Next — a coluna numeric é string no Drizzle e é string que sai na
        # resposta. ``_js_string_de_numero`` cuida do 1e21/inteiro sem ".0".
        "valor": _js_string_de_numero(data.get("valor")),
        "hh": _js_string_de_numero(data.get("hh")),
        "escopo": data.get("escopo"),
        "familias_sugeridas": _json.dumps(data["familiasSugeridas"])
        if data.get("familiasSugeridas") is not None
        else None,
    }

    sql_insert = text(
        f"""
        INSERT INTO operacoes (
          codigo, cliente_nome, cliente_grupo, cliente_cnpj, contrato_numero,
          unidade, area, detentora, ramo, onshore_offshore, periodo_inicio,
          periodo_fim, valor, hh, escopo, familias_sugeridas, origem
        ) VALUES (
          :codigo, :cliente_nome, :cliente_grupo, :cliente_cnpj,
          :contrato_numero, :unidade, :area, :detentora, :ramo, :onshore_offshore,
          CAST(:periodo_inicio AS date), CAST(:periodo_fim AS date),
          CAST(:valor AS numeric), CAST(:hh AS numeric), :escopo,
          CAST(:familias_sugeridas AS jsonb), 'MANUAL'
        )
        RETURNING {_OPERACAO_SELECT}
        """
    )
    nova = (await db.execute(sql_insert, insert_params)).mappings().first()

    # audit_log na MESMA sessão (registrar_audit NÃO commita — o commit é daqui).
    await registrar_audit(
        db,
        user_id=user.id,
        acao="CRIAR_OPERACAO",
        entidade="operacao",
        entidade_id=str(nova["id"]),
        detalhes={
            "codigo": nova["codigo"],
            "clienteNome": nova["cliente_nome"],
            "detentora": nova["detentora"],
        },
    )

    await db.commit()

    return JSONResponse(status_code=201, content=_serializar_operacao(nova))


def _js_string_de_numero(valor) -> str | None:
    """Réplica de ``String(numero)`` do JS para os campos ``numeric``.

    O Python imprimiria ``10.0`` onde o JS imprime ``10`` (e ``1e+21`` onde o JS
    também usa ``1e+21``, mas ``100000000000000000000`` onde o JS usa
    ``100000000000000000000``). Como o valor entra num ``numeric``, o que
    importa é não mandar sufixo ``.0`` inexistente nem notação que o Postgres
    recuse — ele aceita exponencial, então basta remover o ``.0`` dos inteiros.
    """
    if valor is None:
        return None
    if isinstance(valor, float) and valor.is_integer() and abs(valor) < 1e16:
        return str(int(valor))
    return str(valor)


# ══════════════════════════════════════════════════════════════════════════════
# Validação do corpo (réplica de CriarOperacaoSchema)
# ══════════════════════════════════════════════════════════════════════════════


def _validar_criar_operacao(body: Any) -> dict[str, Any]:
    """Valida ``body`` contra CriarOperacaoSchema. Retorna {data} ou {__erros__}.

    O dict de erros sai no formato do ``formatZodErrors`` (path com pontos →
    mensagem), que é o que vai em ``detalhes``. Campos desconhecidos são
    IGNORADOS (o ``z.object`` do Zod v4 faz strip, não erro) — é assim que
    ``origem``/``ativo`` mandados pela tela não viram 422 nem entram no INSERT.
    """
    erros: dict[str, str] = {}

    if not isinstance(body, dict):
        # z.object() sobre não-objeto → erro no path raiz "".
        return {"__erros__": {"": _zod_expected("object", body)}}

    out: dict[str, Any] = {}

    def _obrigatorio_str(campo: str, minimo: int, msg_min: str, maximo: int, msg_max: str) -> None:
        """z.string().min().max() obrigatório — distingue ausente de null."""
        if campo not in body:
            erros[campo] = _zod_expected_undefined("string")
            return
        v = body[campo]
        if not isinstance(v, str):
            erros[campo] = _zod_expected("string", v)
        elif len(v) < minimo:
            erros[campo] = msg_min
        elif len(v) > maximo:
            erros[campo] = msg_max
        else:
            out[campo] = v

    def _str_opt(campo: str, maximo: int, msg_max: str) -> None:
        """z.string().max(N).optional().nullable() — null é aceito e vira NULL."""
        if campo not in body or body[campo] is None:
            return
        v = body[campo]
        if not isinstance(v, str):
            erros[campo] = _zod_expected("string", v)
        elif len(v) > maximo:
            erros[campo] = msg_max
        else:
            out[campo] = v

    def _num_opt(campo: str, msg_neg: str, teto: int, msg_teto: str) -> None:
        """z.number().nonnegative().max().optional().nullable()."""
        if campo not in body or body[campo] is None:
            return
        v = body[campo]
        # bool é int em Python, mas boolean NÃO é number em JS.
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            erros[campo] = _zod_expected("number", v)
        elif isinstance(v, float) and not math.isfinite(v):
            # ``1e400`` no corpo vira Infinity nos DOIS lados (o JSON.parse do JS
            # também estoura para Infinity). O ``number`` do Zod v4 exige finito
            # e a mensagem que sai é a de TIPO, não a de teto. (NaN nu não chega
            # aqui: ``_json_loads_js`` já recusou o literal com 400.)
            erros[campo] = "Invalid input: expected number, received number"
        elif v < 0:
            erros[campo] = msg_neg
        elif v > teto:
            erros[campo] = msg_teto
        else:
            out[campo] = v

    def _data_opt(campo: str) -> None:
        """Coluna ``date``: "AAAA-MM-DD" que EXISTE no calendário.

        Só o formato não basta — "2019-02-31" passaria na regex e estouraria no
        INSERT (500 em vez de 422). O Next resolve com round-trip pelo ``Date``;
        aqui, com ``date.fromisoformat``, que recusa mês 13 e dia inexistente.
        """
        if campo not in body or body[campo] is None:
            return
        v = body[campo]
        if not isinstance(v, str):
            erros[campo] = _zod_expected("string", v)
            return
        if not _DATA_REGEX.match(v):
            erros[campo] = _MSG_DATA
            return
        try:
            _date.fromisoformat(v)
        except ValueError:
            erros[campo] = _MSG_DATA
        else:
            out[campo] = v

    # codigo* : z.string().regex(...) — a regex já cobre o tamanho 2..32.
    if "codigo" not in body:
        erros["codigo"] = _zod_expected_undefined("string")
    elif not isinstance(body["codigo"], str):
        erros["codigo"] = _zod_expected("string", body["codigo"])
    elif not _CODIGO_REGEX.match(body["codigo"]):
        erros["codigo"] = _MSG_CODIGO
    else:
        out["codigo"] = body["codigo"]

    _obrigatorio_str("clienteNome", 2, _MSG_CLIENTE_CURTO, 200, _MSG_CLIENTE_LONGO)

    _str_opt("clienteGrupo", 200, _MSG_GRUPO_LONGO)

    # clienteCnpj : só dígitos (14), como o VincularDocumentoProjetoSchema.
    if "clienteCnpj" in body and body["clienteCnpj"] is not None:
        cnpj = body["clienteCnpj"]
        if not isinstance(cnpj, str):
            erros["clienteCnpj"] = _zod_expected("string", cnpj)
        elif not _CNPJ_REGEX.match(cnpj):
            erros["clienteCnpj"] = _MSG_CNPJ
        else:
            out["clienteCnpj"] = cnpj

    _str_opt("contratoNumero", 100, _MSG_CONTRATO_LONGO)
    _str_opt("unidade", 200, _MSG_UNIDADE_LONGA)
    # 0044 (B5): área da planta, ao lado de ``unidade`` nos DOIS schemas
    # (Criar e Editar). Sem esta linha o cadastro manual pelo BFF gravaria a
    # obra SEM a área que o usuário digitou — e ainda aceitaria 500 caracteres
    # onde o Next devolve 422.
    _str_opt("area", 200, _MSG_AREA_LONGA)

    # detentora : enum com default "PROPONENTE". ATENÇÃO — ``null`` NÃO cai no
    # default (o .default() do Zod só troca ``undefined``): é erro de enum.
    if "detentora" not in body:
        out["detentora"] = "PROPONENTE"
    elif body["detentora"] not in _DETENTORAS:
        erros["detentora"] = _zod_enum_msg(_DETENTORAS)
    else:
        out["detentora"] = body["detentora"]

    _str_opt("ramo", 200, _MSG_RAMO_LONGO)
    _str_opt("onshoreOffshore", 50, _MSG_ONOFF_LONGO)

    # Sem checagem cruzada início≤fim (igual ao Next): o catálogo tem pares
    # invertidos na origem e recusar o cadastro por isso travaria o usuário.
    _data_opt("periodoInicio")
    _data_opt("periodoFim")

    _num_opt("valor", _MSG_VALOR_NEGATIVO, _TETO_VALOR, _MSG_VALOR_TETO)
    _num_opt("hh", _MSG_HH_NEGATIVO, _TETO_HH, _MSG_HH_TETO)

    _str_opt("escopo", 4000, _MSG_ESCOPO_LONGO)

    # familiasSugeridas : códigos CRC de referência (o vínculo real é
    # documentos_familias). O Zod v4 reporta os erros de ITEM **e** o de tamanho
    # do array quando os dois falham — daí os dois blocos, sem ``else``.
    if "familiasSugeridas" in body and body["familiasSugeridas"] is not None:
        fam = body["familiasSugeridas"]
        if isinstance(fam, list):
            ok = True
            for i, f in enumerate(fam):
                if not isinstance(f, str):
                    erros[f"familiasSugeridas.{i}"] = _zod_expected("string", f)
                    ok = False
                elif len(f) > 50:
                    erros[f"familiasSugeridas.{i}"] = _MSG_FAMILIA_LONGA
                    ok = False
            if len(fam) > _MAX_FAMILIAS:
                erros["familiasSugeridas"] = _MSG_FAMILIAS_MAX
                ok = False
            if ok:
                out["familiasSugeridas"] = fam
        else:
            # Não-array: no Zod v4 o check de tamanho ainda roda sobre
            # ``valor.length`` (existe em string) e a mensagem dele VENCE a de
            # tipo, por vir depois. Sem ``.length`` (número, objeto), sobra a de
            # tipo. Conferido executando o schema real.
            if isinstance(fam, str) and len(fam) > _MAX_FAMILIAS:
                erros["familiasSugeridas"] = _MSG_FAMILIAS_MAX
            else:
                erros["familiasSugeridas"] = _zod_expected("array", fam)

    if erros:
        return {"__erros__": erros}
    return {"data": out}
