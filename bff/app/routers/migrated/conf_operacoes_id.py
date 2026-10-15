"""Rota migrada (strangler-fig): /api/conformidade/operacoes/{id} (GET + PATCH).

Espelho 1:1 de ``app/src/app/api/conformidade/operacoes/[id]/route.ts`` — o
DOSSIÊ da operação (GET) e a edição do cadastro (PATCH, nasceu na 0034/R4).

──────────────────────────────────────────────────────────────────────────────
GUARDS
──────────────────────────────────────────────────────────────────────────────
GET → ``requireVisualizar()`` == :data:`app.core.security.require_visualizar`
      (ADMIN, LIDER, ORCAMENTISTA, TECNICO, SGI, VISUALIZADOR; barra EXTERNO).
      401 ``{"error":"Não autenticado","code":"UNAUTHENTICATED"}``
      403 ``{"error":"Permissão negada","code":"FORBIDDEN"}``  ← COM ``code``
      A ficha é a navegação do acervo (ADR-06) — por isso o guard NÃO subiu para
      Conformidade; o que fecha o vazamento é a OMISSÃO de ``valor``/``hh`` e o
      predicado ``restrito`` (abaixo).

PATCH → ``requireConformidade()`` == ``require_conformidade`` (ADMIN/LIDER/SGI).
      403 ``{"error":"Apenas Conformidade","code":"FORBIDDEN"}`` — editar
      cadastro (inclusive ``valor``) é ato de quem VÊ valor (P10).

Ordem GET  : guard(401/403) → 404 (operação) → 200.
Ordem PATCH: guard → 404 → 400 (JSON) → 422 (codigo no body) → 422 (zod)
             → UPDATE → audit → 200.

──────────────────────────────────────────────────────────────────────────────
SHAPE (GET — 0034/B4)
──────────────────────────────────────────────────────────────────────────────
200 ``{...operacao, "documentos":[{id, titulo, papel, subcategoria, nomeArquivo,
    tamanhoBytes, contentType, versao, revisao, criadoEm, emitidoEm, numeroDocumento,
    validadeFim, status, tipoDocumento, situacaoProva, detentora, sha256,
    restrito, origemPath, disciplinaId, familias:[{id, codigo}],
    disciplina:{id,codigo,nome}|null}], "disciplinas":[{id,codigo,nome}]}``.
    - ``valor`` e ``hh`` são OMITIDOS (a chave não existe — não é ``null``, que
      significaria "não preenchido" e mentiria) quando o papel NÃO é
      Conformidade;
    - documento ``restrito=true`` é FILTRADO da lista para papéis fora de
      Conformidade (predicado §3.2 — contagem nenhuma denuncia o oculto);
    - ``familias`` vem de UMA segunda query para todos os documentos (nada de
      N+1), ordenada ``codigo ASC, id ASC`` (a ordenação é contrato de
      paridade); documento sem família → ``[]``;
    - 0043: ``disciplinas`` (as da OBRA) vem de UMA query própria — ``[]``
      quando não há vínculo, nunca ``null`` — e cada documento ganha
      ``disciplinaId`` + ``disciplina`` aninhada (``null`` quando não há), pelo
      MESMO LEFT JOIN do Next. Disciplina NÃO é recortada por papel: não é dado
      comercial (o que some fora de Conformidade continua sendo ``valor``/``hh``
      e o documento restrito).
404 ``{"error":"Operação não encontrada"}`` (helper ``notFound()`` do Next).

ORDENAÇÃO das provas (``getDocumentosByOperacao``): por PAPEL na ordem de
exibição do dossiê (a ordem da tupla ``PAPEIS_DOCUMENTO`` de
``src/lib/conformidade/operacoes.ts``), depois ``criado_em`` crescente e, por
fim, ``id`` crescente (desempate que torna a ordem TOTAL). A ordenação fina por
SEÇÃO é responsabilidade do front, sobre o payload completo (dossiê não pagina).

──────────────────────────────────────────────────────────────────────────────
SHAPE (PATCH — R4)
──────────────────────────────────────────────────────────────────────────────
Request: JSON com QUALQUER subconjunto dos campos editáveis (EditarOperacaoSchema
= CriarOperacaoSchema com tudo optional, MENOS ``codigo`` e ``origem``):
``codigo`` presente no body (qualquer valor) → 422
``{"error":"Dados inválidos","detalhes":{"codigo":"não pode ser alterado"}}``
ANTES do parse; ``origem`` presente → ignorado em silêncio (strip do z.object).
Campo AUSENTE → coluna não muda; presente com ``null`` (nos nullable) → NULL.
200: a linha INTEIRA atualizada (mesmo shape/serialização do 201 do POST).
Sem 409 (``codigo`` não é editável ⇒ não há colisão possível).

──────────────────────────────────────────────────────────────────────────────
SERIALIZAÇÃO
──────────────────────────────────────────────────────────────────────────────
``timestamptz`` → :func:`_js_to_iso_string` (``toISOString``: UTC, ms, 'Z') —
vale para criadoEm/atualizadoEm E para emitidoEm/validadeFim dos documentos;
``date`` (periodo_*) → "YYYY-MM-DD" via :func:`_data_iso`; ``numeric``
(valor/hh) → STRING ``str(Decimal)``; ``uuid`` → ``str()``; ``jsonb`` → nativo.

``id`` NÃO-UUID: o Next chama ``ehUuid(id)`` ANTES de ir ao banco e devolve 404
(sem isso o Postgres estouraria no cast ``uuid = text`` e a rota daria 500).
Replicamos com :data:`_UUID_ZOD_REGEX` — a regex EXATA do ``z.string().uuid()``
do Zod v4.4.3 — e só então comparamos ``id = CAST(:id AS uuid)``. NÃO usamos o
``id::text = :id`` dos irmãos migrados de propósito: ele compararia texto contra
o uuid canônico (minúsculo) e devolveria 404 para um id em MAIÚSCULAS, que o
Next encontra (o Postgres normaliza o cast).

MANIA do ``date`` no asyncpg (bug real): com ``CAST(:x AS date)`` o
driver exige ``datetime.date`` no bind — a string "AAAA-MM-DD" já validada vira
objeto via :func:`_para_date` ANTES do bind (senão DataError → 500 só no BFF).
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
    require_conformidade,
    require_visualizar,
)
from app.db.session import get_db
from app.routers.migrated._restrito import is_conformidade, restricao_visivel_sql
from app.services.audit import registrar_audit

router = APIRouter()


# Regex LITERAL do ``z.string().uuid()`` do Zod v4.4.3 (lida do schema real):
# versão 1..8, variante 8/9/a/b, mais os dois uuids especiais (nil e max). É
# MAIS ESTRITA que o ``_UUID_REGEX`` genérico dos irmãos migrados — usá-la aqui
# é o que faz o 404 do ``ehUuid`` cair no mesmo conjunto de entradas.
_UUID_ZOD_REGEX = re.compile(
    r"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}"
    r"-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000"
    r"|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
)


# ══════════════════════════════════════════════════════════════════════════════
# Serialização (cópias locais — origem: conf_cofre_documentos.py:117 / conf_operacoes.py)
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


def _data_iso(valor) -> str | None:
    """``date`` → "YYYY-MM-DD" (o Drizzle ``date()`` devolve essa STRING)."""
    if valor is None:
        return None
    if isinstance(valor, _date):
        return valor.isoformat()
    return str(valor)


def _numerico(valor) -> str | None:
    """``numeric`` → STRING ("1234.50"), como o Drizzle entrega."""
    if valor is None:
        return None
    if isinstance(valor, Decimal):
        return str(valor)
    return str(valor)


# Colunas de ``operacoes`` na ordem do pgTable (schema.ts) → chave camelCase.
_OPERACAO_COLS: tuple[tuple[str, str], ...] = (
    ("id", "id"),
    ("codigo", "codigo"),
    ("cliente_nome", "clienteNome"),
    ("cliente_grupo", "clienteGrupo"),
    ("cliente_cnpj", "clienteCnpj"),
    ("contrato_numero", "contratoNumero"),
    ("unidade", "unidade"),
    # 0044 (item B5): a ÁREA dentro da planta. O Next a devolve de graça
    # (``getOperacaoById`` faz ``select()`` cru e o PATCH usa
    # ``.returning()``); sem esta tupla o espelho omitiria a chave em R3 e no
    # 200 do PATCH. Posição: a do pgTable, entre ``unidade`` e ``detentora``
    # (schema.ts:1107) — a ordem das chaves é contrato de paridade.
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
# GET — dossiê da operação (== handler GET do route.ts)
# ══════════════════════════════════════════════════════════════════════════════

# Ordem de exibição das provas = índice na tupla PAPEIS_DOCUMENTO (0..6), com
# ELSE 99 para papel NULL/desconhecido. O Next gera este mesmo CASE a partir da
# tupla (``ORDEM_PAPEL`` em operacoes/queries.ts); aqui ele vem escrito porque o
# BFF não importa o domínio do Next — os valores e a ordem TÊM de casar.
_ORDEM_PAPEL_SQL = """
        CASE d.papel
          WHEN 'ATESTADO'    THEN 0
          WHEN 'CAT_ART'     THEN 1
          WHEN 'CONTRATO'    THEN 2
          WHEN 'ADITIVO'     THEN 3
          WHEN 'NOTA_FISCAL' THEN 4
          WHEN 'DECLARACAO'  THEN 5
          WHEN 'OUTRO'       THEN 6
          ELSE 99
        END
"""


# 0043 (onda 4) — as disciplinas DA OBRA, numa query só (nada de N+1).
# Espelho de ``getDisciplinasByOperacao`` (disciplinas/queries.ts): INNER JOIN,
# SEM filtro por ``ativo`` (disciplina desativada que a obra teve continua sendo
# verdade sobre a obra — escondê-la falsearia o histórico) e ORDER BY
# ``ordem, codigo``, a MESMA ordem do ``json_agg`` de R1 e dos chips da ficha.
_DISCIPLINAS_DA_OPERACAO_SQL = text(
    """
    SELECT d.id, d.codigo, d.nome
      FROM operacao_disciplinas od
      JOIN disciplinas d ON d.id = od.disciplina_id
     WHERE od.operacao_id = CAST(:id AS uuid)
     ORDER BY d.ordem ASC, d.codigo ASC
    """
)


def _serializar_disciplinas(rows) -> list[dict[str, str]]:
    """Linhas de ``disciplinas`` -> ``[{id, codigo, nome}]`` (``uuid`` -> str).

    Lista VAZIA quando não há vínculo — nunca ``null``: a chave é contrato de
    array nos dois lados (o cliente não distingue "não tem" de "não veio").
    """
    return [
        {"id": str(r["id"]), "codigo": r["codigo"], "nome": r["nome"]} for r in rows
    ]


def _disciplina_aninhada(
    disciplina_id: Any, codigo: Any, nome: Any
) -> dict[str, str] | None:
    """As três colunas achatadas do LEFT JOIN -> objeto aninhado ou ``None``.

    Mesmo desmonte que o ``map`` do Next faz para ``operacao``: documento sem
    disciplina sai com ``disciplina: null``, NÃO com um objeto de campos nulos.
    """
    if disciplina_id is None or codigo is None or nome is None:
        return None
    return {"id": str(disciplina_id), "codigo": codigo, "nome": nome}


@router.get("/api/conformidade/operacoes/{id}")
async def obter_operacao(
    id: str,
    user: CurrentUser = Depends(require_visualizar),
    db=Depends(get_db),
) -> JSONResponse:
    """Devolve a operação inteira mais as provas dela que estão no cofre."""
    # ``ehUuid(id)`` do Next: id fora do formato é 404, não 500 nem 400.
    if not _UUID_ZOD_REGEX.match(id):
        return JSONResponse(
            status_code=404, content={"error": "Operação não encontrada"}
        )

    operacao = (
        await db.execute(
            text(
                f"SELECT {_OPERACAO_SELECT} FROM operacoes "
                f"WHERE id = CAST(:id AS uuid) LIMIT 1"
            ),
            {"id": id},
        )
    ).mappings().first()

    if operacao is None:
        return JSONResponse(
            status_code=404, content={"error": "Operação não encontrada"}
        )

    eh_conf = is_conformidade(user.role)

    # B4 (0034): além das 9 colunas originais, o dossiê carrega as colunas da
    # ficha — e o predicado restrito filtra a linha inteira para quem não é
    # Conformidade (mesma regra única de cofre/queries.ts, §3.2).
    docs = (
        await db.execute(
            text(
                f"""
                SELECT
                  d.id, d.titulo, d.papel, d.subcategoria, d.nome_arquivo,
                  d.tamanho_bytes, d.content_type, d.versao,
                  -- 0044 (B6): a revisão carimbada pela engenharia, logo depois
                  -- de ``versao`` — a posição do select de getDocumentosByOperacao
                  -- (operacoes/queries.ts:303). NÃO é ``versao``: aquela é o
                  -- versionamento de certidão do cofre (spec ONDA-5 §1h).
                  d.revisao,
                  d.criado_em,
                  d.emitido_em, d.numero_documento, d.validade_fim, d.status,
                  d.tipo_documento, d.situacao_prova, d.detentora, d.sha256,
                  d.restrito, d.origem_path,
                  -- 0043: a disciplina que ESTE documento prova. LEFT (documento
                  -- sem disciplina é a maioria e não pode sumir da ficha) e 1:1
                  -- por FK — não multiplica linha nem muda contagem nenhuma.
                  d.disciplina_id, disc.codigo AS disciplina_codigo,
                  disc.nome AS disciplina_nome
                FROM documentos_habilitacao d
                LEFT JOIN disciplinas disc ON disc.id = d.disciplina_id
                WHERE d.operacao_id = CAST(:id AS uuid)
                  AND {restricao_visivel_sql("d")}
                ORDER BY {_ORDEM_PAPEL_SQL}, d.criado_em ASC, d.id ASC
                """
            ),
            {"id": id, "is_conformidade": eh_conf},
        )
    ).mappings().all()

    # Famílias: UMA query para todos os documentos da resposta (nada de N+1),
    # agregada em ``familias:[{id, codigo}]`` por documento. A coluna real é
    # ``codigo_crc`` (schema.ts:825) — a chave JSON é ``codigo`` (contrato B4).
    familias_por_doc: dict[str, list[dict[str, str]]] = {}
    doc_ids = [str(r["id"]) for r in docs]
    if doc_ids:
        fam_rows = (
            await db.execute(
                text(
                    """
                    SELECT df.documento_id, f.id, f.codigo_crc
                    FROM documentos_familias df
                    JOIN familias f ON f.id = df.familia_id
                    WHERE df.documento_id = ANY(CAST(:ids AS uuid[]))
                    ORDER BY f.codigo_crc ASC, f.id ASC
                    """
                ),
                {"ids": doc_ids},
            )
        ).mappings().all()
        for fr in fam_rows:
            familias_por_doc.setdefault(str(fr["documento_id"]), []).append(
                {"id": str(fr["id"]), "codigo": fr["codigo_crc"]}
            )

    # 0043 — as disciplinas da OBRA (bloco à parte na ficha, nunca uma 10ª
    # seção). Query própria, sempre executada: o array vazio é resposta ("esta
    # obra não declarou disciplina"), não ausência de dado.
    disciplinas_rows = (
        await db.execute(_DISCIPLINAS_DA_OPERACAO_SQL, {"id": id})
    ).mappings().all()

    corpo = _serializar_operacao(operacao)

    # Omissão de valor/hh (fecha o vazamento na ficha): OMITIR, não ``null`` —
    # ``null`` significa "não preenchido" e mentiria (02-APIS §3.2).
    if not eh_conf:
        corpo.pop("valor", None)
        corpo.pop("hh", None)

    corpo["documentos"] = [
        {
            "id": str(r["id"]),
            "titulo": r["titulo"],
            "papel": r["papel"],
            "subcategoria": r["subcategoria"],
            "nomeArquivo": r["nome_arquivo"],
            "tamanhoBytes": r["tamanho_bytes"],
            "contentType": r["content_type"],
            "versao": r["versao"],
            # 0044 (B6): chave nova ENTRE ``versao`` e ``criadoEm`` (a posição do
            # select do Drizzle). ``null`` quando o documento não tem revisão.
            "revisao": r["revisao"],
            "criadoEm": _js_to_iso_string(r["criado_em"]),
            # 0034/B4 — colunas do dossiê (emitidoEm/validadeFim são timestamptz
            # → ISO com 'Z'; o resto é text/bool cru).
            "emitidoEm": _js_to_iso_string(r["emitido_em"]),
            "numeroDocumento": r["numero_documento"],
            "validadeFim": _js_to_iso_string(r["validade_fim"]),
            "status": r["status"],
            "tipoDocumento": r["tipo_documento"],
            "situacaoProva": r["situacao_prova"],
            "detentora": r["detentora"],
            "sha256": r["sha256"],
            "restrito": r["restrito"],
            "origemPath": r["origem_path"],
            # 0043: o id no topo (é por ele que o PATCH e o filtro trabalham) e
            # o rótulo aninhado logo depois de ``familias``, na MESMA posição em
            # que o ``map`` do Next o acrescenta.
            "disciplinaId": str(r["disciplina_id"])
            if r["disciplina_id"] is not None
            else None,
            "familias": familias_por_doc.get(str(r["id"]), []),
            "disciplina": _disciplina_aninhada(
                r["disciplina_id"], r["disciplina_codigo"], r["disciplina_nome"]
            ),
        }
        for r in docs
    ]

    # 0043 — chave nova NO FIM do corpo, ao lado de ``documentos`` (é onde o
    # Next a põe: ``{ ...operacao, documentos, disciplinas }``).
    corpo["disciplinas"] = _serializar_disciplinas(disciplinas_rows)

    return JSONResponse(content=corpo)


# ══════════════════════════════════════════════════════════════════════════════
# PATCH — edição do cadastro da operação (R4, nasce na 0034)
# ══════════════════════════════════════════════════════════════════════════════

_DETENTORAS = ("PROPONENTE", "COLIGADA", "PARCEIRO")

# Mensagens CUSTOM (operacoes/validations.ts — EditarOperacaoSchema). Literais.
_MSG_CLIENTE_CURTO = "Nome do cliente deve ter pelo menos 2 caracteres"
_MSG_CLIENTE_LONGO = "Nome do cliente muito longo"
_MSG_GRUPO_LONGO = "Grupo do cliente muito longo"
_MSG_CNPJ = "CNPJ deve conter 14 dígitos"
_MSG_CONTRATO_LONGO = "Número do contrato muito longo"
_MSG_UNIDADE_LONGA = "Unidade muito longa"
# 0044 (B5): área da planta — teto 200, o mesmo de ``unidade``.
_MSG_AREA_LONGA = "Área muito longa"
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

# Tetos do domínio (os MESMOS de valorSchema/hhSchema do Criar — não duplicar).
_TETO_VALOR = 999_999_999_999_99
_TETO_HH = 999_999_999_999
_MAX_FAMILIAS = 200

_CNPJ_REGEX = re.compile(r"^\d{14}$")
_DATA_REGEX = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _para_date(valor):
    """"YYYY-MM-DD" → ``datetime.date`` para o bind do asyncpg (None passa).

    Com ``CAST(:x AS date)`` o driver exige o objeto ``date`` — string estoura
    DataError ANTES do banco (bug real, mania 0.3-3). A validação de
    formato já rodou; valor inesperado volta como veio e deixa o erro aparecer
    no lugar certo.
    """
    if not isinstance(valor, str):
        return valor
    try:
        return _date.fromisoformat(valor)
    except ValueError:
        return valor


def _js_string_de_numero(valor) -> str | None:
    """Réplica de ``String(numero)`` do JS para os campos ``numeric``.

    Remove o sufixo ``.0`` dos inteiros que o Python inventaria (o JS imprime
    ``10``, não ``10.0``) — cópia da variante local de ``conf_operacoes.py``.
    """
    if valor is None:
        return None
    if isinstance(valor, float) and valor.is_integer() and abs(valor) < 1e16:
        return str(int(valor))
    return str(valor)


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


def _zod_enum_msg(valores: tuple[str, ...]) -> str:
    """``Invalid option: expected one of "A"|"B"`` (aspas duplas, sem espaços)."""
    return "Invalid option: expected one of " + "|".join(f'"{v}"' for v in valores)


def _json_loads_js(bruto: bytes) -> Any:
    """``JSON.parse`` do JS: ``NaN``/``Infinity`` NUS são erro de sintaxe."""

    def _rejeita(_constante: str):
        raise ValueError("constante JSON não permitida (NaN/Infinity)")

    return _json.loads(bruto, parse_constant=_rejeita)


def _validar_editar_operacao(body: Any) -> dict[str, Any]:
    """Réplica de ``EditarOperacaoSchema.safeParse(body)`` (Zod v4.4.3).

    O CriarOperacaoSchema com tudo ``.optional()`` — MENOS ``codigo`` e
    ``origem``, que não existem no schema (``codigo`` é recusado ANTES do parse
    pelo handler; ``origem`` sofre strip como campo desconhecido). ``ativo``
    entra aqui (não existe no Criar). Uma mensagem por campo (last-wins do
    ``formatZodErrors``, §0.3-1), na mesma ordem de checagem do zod — padrão de
    ``_validar_criar_operacao`` (conf_operacoes.py:740).
    """
    erros: dict[str, str] = {}

    if not isinstance(body, dict):
        return {"__erros__": {"": _zod_expected("object", body)}}

    out: dict[str, Any] = {}

    def _str_opt(campo: str, maximo: int, msg_max: str) -> None:
        """z.string().max(N).optional().nullable() — null é aceito e vira NULL."""
        if campo not in body:
            return
        v = body[campo]
        if v is None:
            out[campo] = None
            return
        if not isinstance(v, str):
            erros[campo] = _zod_expected("string", v)
        elif len(v) > maximo:
            erros[campo] = msg_max
        else:
            out[campo] = v

    def _num_opt(campo: str, msg_neg: str, teto: int, msg_teto: str) -> None:
        """z.number().nonnegative().max().optional().nullable()."""
        if campo not in body:
            return
        v = body[campo]
        if v is None:
            out[campo] = None
            return
        # bool é int em Python, mas boolean NÃO é number em JS.
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            erros[campo] = _zod_expected("number", v)
        elif isinstance(v, float) and not math.isfinite(v):
            # ``1e400`` vira Infinity nos DOIS lados; o ``number`` do Zod v4
            # exige finito e a mensagem é a de TIPO (conf_operacoes.py:791).
            erros[campo] = "Invalid input: expected number, received number"
        elif v < 0:
            erros[campo] = msg_neg
        elif v > teto:
            erros[campo] = msg_teto
        else:
            out[campo] = v

    def _data_opt(campo: str) -> None:
        """dataSchema.optional().nullable(): "AAAA-MM-DD" que EXISTE no calendário."""
        if campo not in body:
            return
        v = body[campo]
        if v is None:
            out[campo] = None
            return
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

    # clienteNome: optional SEM nullable — dá para não mexer, não para apagar.
    if "clienteNome" in body:
        v = body["clienteNome"]
        if not isinstance(v, str):
            erros["clienteNome"] = _zod_expected("string", v)
        elif len(v) < 2:
            erros["clienteNome"] = _MSG_CLIENTE_CURTO
        elif len(v) > 200:
            erros["clienteNome"] = _MSG_CLIENTE_LONGO
        else:
            out["clienteNome"] = v

    _str_opt("clienteGrupo", 200, _MSG_GRUPO_LONGO)

    # clienteCnpj: regex de 14 dígitos, optional().nullable().
    if "clienteCnpj" in body:
        cnpj = body["clienteCnpj"]
        if cnpj is None:
            out["clienteCnpj"] = None
        elif not isinstance(cnpj, str):
            erros["clienteCnpj"] = _zod_expected("string", cnpj)
        elif not _CNPJ_REGEX.match(cnpj):
            erros["clienteCnpj"] = _MSG_CNPJ
        else:
            out["clienteCnpj"] = cnpj

    _str_opt("contratoNumero", 100, _MSG_CONTRATO_LONGO)
    _str_opt("unidade", 200, _MSG_UNIDADE_LONGA)
    # 0044 (B5): ``area`` ao lado de ``unidade``, optional().nullable() — ``null``
    # LIMPA, valor troca, ausente não mexe. Sem esta linha o PATCH pelo BFF
    # ignoraria em silêncio a área que o usuário digitou (e o
    # ``{antes, depois}`` do audit nunca registraria a mudança), enquanto o
    # mesmo PATCH no Next gravaria — o pior tipo de divergência (§8.18).
    _str_opt("area", 200, _MSG_AREA_LONGA)

    # detentora: enum optional SEM nullable e SEM default (diferente do Criar:
    # aqui ausência = não mexer; ``null`` é erro de enum, como no Criar).
    if "detentora" in body:
        if body["detentora"] not in _DETENTORAS:
            erros["detentora"] = _zod_enum_msg(_DETENTORAS)
        else:
            out["detentora"] = body["detentora"]

    _str_opt("ramo", 200, _MSG_RAMO_LONGO)
    _str_opt("onshoreOffshore", 50, _MSG_ONOFF_LONGO)

    _data_opt("periodoInicio")
    _data_opt("periodoFim")

    _num_opt("valor", _MSG_VALOR_NEGATIVO, _TETO_VALOR, _MSG_VALOR_TETO)
    _num_opt("hh", _MSG_HH_NEGATIVO, _TETO_HH, _MSG_HH_TETO)

    _str_opt("escopo", 4000, _MSG_ESCOPO_LONGO)

    # familiasSugeridas: mesma validação do Criar (item + tamanho ACUMULAM;
    # não-array segue o last-wins medido — conf_operacoes.py:879-903).
    if "familiasSugeridas" in body:
        fam = body["familiasSugeridas"]
        if fam is None:
            out["familiasSugeridas"] = None
        elif isinstance(fam, list):
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
            if isinstance(fam, str) and len(fam) > _MAX_FAMILIAS:
                erros["familiasSugeridas"] = _MSG_FAMILIAS_MAX
            else:
                erros["familiasSugeridas"] = _zod_expected("array", fam)

    # ativo: z.boolean().optional() — o único jeito de desativar sem DELETE.
    if "ativo" in body:
        v = body["ativo"]
        if not isinstance(v, bool):
            erros["ativo"] = _zod_expected("boolean", v)
        else:
            out["ativo"] = v

    if erros:
        return {"__erros__": erros}
    return {"data": out}


# camelCase do body → (coluna, expressão SQL do bind). CAST explícito onde o
# tipo da coluna exige (manias 0.3-2/0.3-3): numeric/jsonb via CAST; date via
# CAST + objeto ``datetime.date`` no bind; texto/bool crus.
_PATCH_COL_SQL: dict[str, tuple[str, str]] = {
    "clienteNome": ("cliente_nome", ":cliente_nome"),
    "clienteGrupo": ("cliente_grupo", ":cliente_grupo"),
    "clienteCnpj": ("cliente_cnpj", ":cliente_cnpj"),
    "contratoNumero": ("contrato_numero", ":contrato_numero"),
    "unidade": ("unidade", ":unidade"),
    # 0044 (B5): texto cru, sem CAST (a coluna é ``text``).
    "area": ("area", ":area"),
    "detentora": ("detentora", ":detentora"),
    "ramo": ("ramo", ":ramo"),
    "onshoreOffshore": ("onshore_offshore", ":onshore_offshore"),
    "periodoInicio": ("periodo_inicio", "CAST(:periodo_inicio AS date)"),
    "periodoFim": ("periodo_fim", "CAST(:periodo_fim AS date)"),
    "valor": ("valor", "CAST(:valor AS numeric)"),
    "hh": ("hh", "CAST(:hh AS numeric)"),
    "escopo": ("escopo", ":escopo"),
    "familiasSugeridas": ("familias_sugeridas", "CAST(:familias_sugeridas AS jsonb)"),
    "ativo": ("ativo", ":ativo"),
}


@router.patch("/api/conformidade/operacoes/{id}")
async def editar_operacao(
    id: str,
    request: Request,
    user: CurrentUser = Depends(require_conformidade),
    db=Depends(get_db),
) -> JSONResponse:
    """Edita o cadastro da operação (B2 — fecha as lacunas do catálogo).

    Ordem dos gates (02-APIS §4.4):
      1. requireConformidade → 401/403 (com code, via Depends).
      2. ehUuid(id) / operação existe → 404 ``Operação não encontrada``.
      3. body JSON → 400 ``JSON inválido``.
      4. ``codigo`` no body → 422 ``não pode ser alterado`` (ANTES do parse).
      5. EditarOperacaoSchema → 422 ``Dados inválidos`` + detalhes.
      6. UPDATE dinâmico (+ atualizado_em=now(), não há trigger) → audit → 200.
    """
    if not _UUID_ZOD_REGEX.match(id):
        return JSONResponse(
            status_code=404, content={"error": "Operação não encontrada"}
        )

    atual = (
        await db.execute(
            text(
                f"SELECT {_OPERACAO_SELECT} FROM operacoes "
                f"WHERE id = CAST(:id AS uuid) LIMIT 1"
            ),
            {"id": id},
        )
    ).mappings().first()
    if atual is None:
        return JSONResponse(
            status_code=404, content={"error": "Operação não encontrada"}
        )

    try:
        body = _json_loads_js(await request.body())
    except Exception:  # noqa: BLE001 — JSON malformado
        return JSONResponse(status_code=400, content={"error": "JSON inválido"})

    # Gate 4 — ``codigo`` é chave de negócio, não editável: recusa ANTES do
    # parse (qualquer valor, inclusive o atual). ``origem`` presente cai no
    # strip do schema, como qualquer campo desconhecido.
    if isinstance(body, dict) and "codigo" in body:
        return JSONResponse(
            status_code=422,
            content={
                "error": "Dados inválidos",
                "detalhes": {"codigo": "não pode ser alterado"},
            },
        )

    parsed = _validar_editar_operacao(body)
    if parsed.get("__erros__"):
        return JSONResponse(
            status_code=422,
            content={"error": "Dados inválidos", "detalhes": parsed["__erros__"]},
        )
    data = parsed["data"]

    # ── UPDATE dinâmico (só os campos PRESENTES no body) ─────────────────────
    # ``atualizado_em`` SEMPRE (não há trigger — comentário da 0033). Mesmo com
    # body vazio ({}), o Next roda o UPDATE só com atualizadoEm — replicamos.
    set_cols: list[str] = ["atualizado_em = now()"]
    params: dict[str, Any] = {"id": id}
    for campo, valor in data.items():
        col, bind_expr = _PATCH_COL_SQL[campo]
        set_cols.append(f"{col} = {bind_expr}")
        if campo in ("periodoInicio", "periodoFim"):
            # Mania 0.3-3: CAST AS date exige datetime.date no bind (None passa).
            params[col] = _para_date(valor)
        elif campo in ("valor", "hh"):
            params[col] = _js_string_de_numero(valor)
        elif campo == "familiasSugeridas":
            params[col] = _json.dumps(valor) if valor is not None else None
        else:
            params[col] = valor

    nova = (
        await db.execute(
            text(
                f"UPDATE operacoes SET {', '.join(set_cols)} "
                f"WHERE id = CAST(:id AS uuid) RETURNING {_OPERACAO_SELECT}"
            ),
            params,
        )
    ).mappings().first()
    if nova is None:
        # Linha sumiu entre o SELECT e o UPDATE (corrida com DELETE) — 404.
        await db.rollback()
        return JSONResponse(
            status_code=404, content={"error": "Operação não encontrada"}
        )

    # ── Audit: APENAS os campos alterados (antes ≠ depois), com a serialização
    # da resposta (datas como string). Proibido despejar o body inteiro (§4.7).
    antes_ser = _serializar_operacao(atual)
    depois_ser = _serializar_operacao(nova)
    antes: dict[str, Any] = {}
    depois: dict[str, Any] = {}
    for chave in antes_ser:
        if antes_ser[chave] != depois_ser[chave]:
            antes[chave] = antes_ser[chave]
            depois[chave] = depois_ser[chave]

    await registrar_audit(
        db,
        user_id=user.id,
        acao="EDITAR_OPERACAO",
        entidade="operacao",
        entidade_id=str(nova["id"]),
        detalhes={"antes": antes, "depois": depois},
    )

    await db.commit()

    return JSONResponse(content=depois_ser)
