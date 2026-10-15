"""Rota migrada (strangler-fig): GET /api/licitacoes/export.

Equivalente 1:1 do handler GET de
``src/app/api/licitacoes/export/route.ts``.

Exporta o catálogo de licitações (numero/objeto/empresa/status/fase/datas/
classificação) ordenado por ``score_interesse DESC``, limite 5000. O Next
suporta dois formatos via ``?format=`` (default ``csv``):

  - ``format=json``  → ``NextResponse.json(data)`` — devolve o ARRAY CRU do
    Drizzle (sem wrapper ``{"data": ...}``); chaves camelCase = props do
    Drizzle.
  - ``format=csv`` (ou ausente) → texto CSV (``text/csv``).

PARIDADE JSON: o teste de paridade parseia JSON; a única resposta JSON do Next
é o caminho ``format=json``, que serializa exatamente o array ``data``. Esta
réplica devolve esse MESMO array cru. O caminho CSV do Next NÃO produz JSON
(``Content-Type: text/csv``), então é reproduzido aqui com fidelidade byte-a-byte
para o estrangulador, mas fora do escopo do ``JSON.parse``.

Guard Next:
    ``requireVisualizar()`` → ``requireAuth()`` (401 se sem sessão) +
    ``podeVisualizar(role)`` → role ∈ {ADMIN, LIDER, ORCAMENTISTA, TECNICO,
    SGI, VISUALIZADOR}, senão 403 ``{ "error": "Permissão negada" }``.
Equivalente no BFF: :data:`app.core.security.require_visualizar`.

Query params lidos:
    ``?format=`` — "csv" (default) ou "json".
    + TODOS os filtros de ``/api/licitacoes`` (search, empresa, fonte, relevancia,
      natureza, fase, segmento, score_min, estado, abrangencia, perfil, prazo,
      data_*_de/ate, novas, com_circulares) — ver ``_licitacoes_filtros.py``.

DIVERGENCIA DELIBERADA DO NEXT:
    1. O Next IGNORA a query string e exporta a base inteira; aqui os filtros da
       tela sao honrados (o usuario que filtra /explorar espera exportar aquilo).
    2. O CSV usa ``csv.writer``; o Next cita so 3 das 14 colunas e desloca as
       colunas de qualquer linha com virgula em segmento/tipo_servico.
    O route.ts recebeu as duas correcoes tambem, mas a rota efetiva
    (NGINX manda /api/licitacoes/export ao BFF) e esta.

Lógica replicada do Drizzle (mesma projeção/ordem/limite):
    SELECT (projeção camelCase IGUAL às props do Drizzle):
        numero, objeto, empresa, status, fase, dataFim, dataPublicacao,
        natureza, tipoServico, segmento, relevancia, scoreInteresse,
        regioes, abrangencia
    FROM licitacoes
    ORDER BY score_interesse DESC   (Drizzle ``desc(scoreInteresse)`` — sem
                                     NULLS LAST; Postgres põe NULL primeiro)
    LIMIT 5000

Colunas (snake_case no banco → camelCase no Drizzle/alias):
    licitacoes.numero          (text)    → "numero"
    licitacoes.objeto          (text)    → "objeto"
    licitacoes.empresa         (text)    → "empresa"
    licitacoes.status          (text)    → "status"
    licitacoes.fase            (text)    → "fase"
    licitacoes.data_fim        (text)    → "dataFim"
    licitacoes.data_publicacao (text)    → "dataPublicacao"
    licitacoes.natureza        (text)    → "natureza"
    licitacoes.tipo_servico    (text)    → "tipoServico"
    licitacoes.segmento        (text)    → "segmento"
    licitacoes.relevancia      (text)    → "relevancia"
    licitacoes.score_interesse (integer) → "scoreInteresse"
    licitacoes.regioes         (text)    → "regioes"
    licitacoes.abrangencia     (text)    → "abrangencia"
"""

from __future__ import annotations

import csv
import io
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy import text

from app.core.security import CurrentUser, require_visualizar
from app.db.session import get_db

from app.routers.migrated._licitacoes_filtros import construir_where_licitacoes

# Serializador canônico (a cópia local era idêntica) — ver _shared.py.
from app.routers.migrated._shared import serializar as _serializar

router = APIRouter()


# Ordem EXATA das chaves do objeto projetado pelo Drizzle (define a ordem dos
# campos no JSON e a ordem das colunas no CSV — paridade com o Next).
_CAMPOS: tuple[str, ...] = (
    "numero",
    "objeto",
    "empresa",
    "status",
    "fase",
    "dataFim",
    "dataPublicacao",
    "natureza",
    "tipoServico",
    "segmento",
    "relevancia",
    "scoreInteresse",
    "regioes",
    "abrangencia",
)

# Cabeçalho do CSV (espelha o array ``headers`` do Next, mesma ordem).
_CSV_HEADERS: list[str] = [
    "NUMERO",
    "OBJETO",
    "EMPRESA",
    "STATUS",
    "FASE",
    "DATA_FIM",
    "DATA_PUBLICACAO",
    "NATUREZA",
    "TIPO_SERVICO",
    "SEGMENTO",
    "RELEVANCIA",
    "SCORE",
    "REGIOES",
    "ABRANGENCIA",
]

# Projeção SQL com aliases camelCase IGUAIS às props do Drizzle.
# ``{where}`` recebe o WHERE montado por construir_where_licitacoes (ou vazio).
_SQL_TEMPLATE = """
    SELECT
        numero          AS "numero",
        objeto          AS "objeto",
        empresa         AS "empresa",
        status          AS "status",
        fase            AS "fase",
        data_fim        AS "dataFim",
        data_publicacao AS "dataPublicacao",
        natureza        AS "natureza",
        tipo_servico    AS "tipoServico",
        segmento        AS "segmento",
        relevancia      AS "relevancia",
        score_interesse AS "scoreInteresse",
        regioes         AS "regioes",
        abrangencia     AS "abrangencia"
    FROM licitacoes
    {where}
    ORDER BY score_interesse DESC
    LIMIT 5000
"""


def _csv_str(valor: Any) -> str:
    """Coerção JS-like p/ campo CSV não-citado (``${row.x}``).

    No JS template string, ``undefined``/``null`` viram a string vazia. Como o
    Drizzle entrega ``null`` (que o JS interpola como ``""``), replicamos isso.
    Números viram sua representação decimal.
    """
    if valor is None:
        return ""
    return str(valor)


@router.get("/api/licitacoes/export")
async def exportar_licitacoes(
    request: Request,
    user: CurrentUser = Depends(require_visualizar),
    db=Depends(get_db),
) -> Response:
    """GET /api/licitacoes/export?format=csv|json.

    Réplica fiel do handler GET do Next: projeção camelCase, ordenado por
    ``score_interesse DESC``, limite 5000. ``format=json`` devolve o array cru
    (paridade ``JSON.parse``); qualquer outro valor (default ``csv``) devolve o
    CSV.
    """
    # ── Query param ``format`` (default "csv"), igual ao Next. ────────────────
    format_ = request.query_params.get("format") or "csv"

    # ── Filtros ───────────────────────────────────────────────────────────────
    # Antes o export IGNORAVA a query string inteira: o
    # usuario filtrava /explorar, clicava em "Exportar" e levava a base toda
    # achando que levava a selecao. Agora usa o MESMO construtor de WHERE da
    # listagem (_licitacoes_filtros.construir_where_licitacoes), entao filtrar a
    # tela e exportar concordam por construcao.
    conds, params = construir_where_licitacoes(request.query_params)
    where_sql = (" WHERE " + " AND ".join(conds)) if conds else ""

    result = await db.execute(text(_SQL_TEMPLATE.format(where=where_sql)), params)
    rows = result.mappings().all()

    # Array de objetos camelCase (ordem dos campos = ordem das props do Drizzle).
    data = [
        {campo: _serializar(row[campo]) for campo in _CAMPOS} for row in rows
    ]

    if format_ == "json":
        # NextResponse.json(data) → ARRAY CRU (sem wrapper). Header de download
        # replicado para fidelidade do estrangulador.
        return JSONResponse(
            content=data,
            headers={
                "Content-Disposition": (
                    'attachment; filename="petro_radar_export.json"'
                )
            },
        )

    # ── CSV ───────────────────────────────────────────────────────────────────
    # Usa csv.writer da stdlib. A versao anterior so citava 3 das 14
    # colunas e montava a linha com ",".join: qualquer virgula em segmento ou
    # tipo_servico DESLOCAVA as colunas seguintes — parte das linhas saia com
    # SCORE mostrando texto e REGIAO mostrando numero, sem aviso nenhum.
    # O writer resolve virgula, aspas e quebra de linha.
    buffer = io.StringIO()
    escritor = csv.writer(buffer, lineterminator="\n")
    escritor.writerow(_CSV_HEADERS)
    for row in data:
        score = row["scoreInteresse"]
        escritor.writerow(
            [
                _csv_str(row["numero"]),
                _csv_str(row["objeto"]),
                _csv_str(row["empresa"]),
                _csv_str(row["status"]),
                _csv_str(row["fase"]),
                _csv_str(row["dataFim"]),
                _csv_str(row["dataPublicacao"]),
                _csv_str(row["natureza"]),
                _csv_str(row["tipoServico"]),
                _csv_str(row["segmento"]),
                _csv_str(row["relevancia"]),
                str(score) if score is not None else "0",
                _csv_str(row["regioes"]),
                _csv_str(row["abrangencia"]),
            ]
        )

    return Response(
        content=buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": (
                'attachment; filename="petro_radar_export.csv"'
            )
        },
    )
