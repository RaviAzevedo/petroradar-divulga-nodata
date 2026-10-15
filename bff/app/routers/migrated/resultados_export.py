"""Rota migrada (strangler-fig): GET /api/resultados/export.

Equivalente 1:1 do handler GET de
``src/app/api/resultados/export/route.ts``.

Exporta o resumo de RESULTADOS de licitação (vencedor/valor/participantes/
status/confiança) enriquecido com a tabela V2 (``petronect_lic_resultado``) e
com a MÉDIA orçada das propostas válidas. Ordenado por ``criado_em DESC``,
limite 5000. O Next suporta dois formatos via ``?format=`` (default ``csv``):

  - ``format=json``  → ``NextResponse.json(data)`` — devolve o ARRAY CRU do
    merge (sem wrapper ``{"data": ...}``); chaves camelCase = props do Drizzle.
  - ``format=csv`` (ou ausente) → texto CSV (``text/csv``).

PARIDADE JSON: o teste de paridade parseia JSON; a única resposta JSON do Next
é o caminho ``format=json``, que serializa exatamente o array ``data`` montado
pelo merge legacy+V2+valorMedio. Esta réplica devolve esse MESMO array. O
caminho CSV do Next NÃO produz JSON (``Content-Type: text/csv``), então é
reproduzido aqui com fidelidade para o estrangulador, mas fora do escopo do
``JSON.parse``.

GATE de feature (ANTES do auth, igual ao Next):
    ``if (!config.features.resultados) -> 503 {"error":"Módulo em reconstrução"}``
    onde ``config.features.resultados = flag(NEXT_PUBLIC_FEATURE_RESULTADOS,
    false)``. Por rodar ANTES do ``requireVisualizar`` no Next, NÃO usamos
    ``Depends(require_visualizar)`` (que devolveria 401 antes do 503); chamamos
    o mesmo dependency manualmente, na ordem correta.

Guard Next:
    ``requireVisualizar()`` → ``requireAuth()`` (401 se sem sessão) +
    ``podeVisualizar(role)`` → role ∈ {ADMIN, LIDER, ORCAMENTISTA, TECNICO,
    SGI, VISUALIZADOR}, senão 403 ``{ "error": "Permissão negada" }``.
Equivalente no BFF: :data:`app.core.security.require_visualizar`.

Query params lidos (iguais ao Next):
    ``?format=``       — "csv" (default) ou "json".
    ``?search=``       — ilike em numero_licitacao OR fornecedor_vencedor OR objeto.
    ``?segmento=``     — eq segmento.
    ``?natureza=``     — eq natureza.
    ``?empresa=``      — ilike empresa.
    ``?cnpj_vencedor=``— eq cnpj_vencedor.
    ``?periodo=``      — "7d"/"30d"/"90d" → criado_em >= NOW() - INTERVAL.

Lógica replicada do Drizzle (3 queries + merge):
  (1) LEGACY: SELECT projeção camelCase FROM resultados_licitacao WHERE <filtros>
      ORDER BY criado_em DESC LIMIT 5000.
  (2) V2: SELECT FROM petronect_lic_resultado WHERE numero IN (<numeros>).
  (3) VALOR MÉDIO: SELECT AVG(valor_total) FROM propostas_licitacao
      WHERE numero_licitacao IN (<numeros>) AND declinou = false
        AND valor_total IS NOT NULL AND valor_total > 0
      GROUP BY numero_licitacao.
  MERGE: spread legacy; V2 sobrescreve fornecedor/cnpj/valor/participantes
  QUANDO a linha V2 existe E o campo V2 é não-nulo (``v2?.x ?? r.x``); acrescenta
  valorMedio (ou null), statusResultado (V2 ou null), confidenceLevel (V2 ou null).

Colunas (snake_case no banco → camelCase no Drizzle/alias):
  resultados_licitacao:
    numero_licitacao    (text)    → "numeroLicitacao"
    objeto              (text)    → "objeto"
    empresa             (text)    → "empresa"
    fornecedor_vencedor (text)    → "fornecedorVencedor"
    cnpj_vencedor       (text)    → "cnpjVencedor"
    valor_vencedor      (numeric) → "valorVencedor"      (string "1234.50")
    total_participantes (integer) → "totalParticipantes" (número)
    segmento            (text)    → "segmento"
    natureza            (text)    → "natureza"
    data_fim            (text)    → "dataFim"
    criado_em           (tstz)    → ordenação (não projetado)
  petronect_lic_resultado:
    numero              (text)    → "numero"
    cnpj_vencedor       (text)    → "cnpjVencedor"
    fornecedor_vencedor (text)    → "fornecedorVencedor"
    valor_vencedor      (numeric) → "valorVencedor"      (string)
    total_participantes (integer) → "totalParticipantes"
    status_resultado    (text)    → "statusResultado"
    confidence_level    (text)    → "confidenceLevel"
  propostas_licitacao:
    numero_licitacao    (text)    → "numero"
    valor_total         (numeric) → AVG → "valorMedio"   (string ou null)
    declinou            (boolean)
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy import bindparam, text

from app.core.security import (
    CurrentUser,
    get_current_user,
    require_visualizar,
)
from app.db.session import get_db
from app.routers.migrated._shared import feature_resultados_habilitada, serializar

router = APIRouter()


# Serializador (incl. Decimal→str do Drizzle) e gate de feature: canônicos de
# _shared (as cópias locais eram idênticas).
_serializar = serializar
_feature_resultados_habilitada = feature_resultados_habilitada


# Ordem EXATA das chaves do objeto final (define a ordem do JSON e do CSV).
# JS: `{...r, fornecedorVencedor, cnpjVencedor, valorVencedor,
#       totalParticipantes, valorMedio, statusResultado, confidenceLevel}`.
# Como o spread `...r` já fixou fornecedorVencedor/cnpjVencedor/valorVencedor/
# totalParticipantes nas posições originais, a reatribuição NÃO muda a ordem
# (JS preserva a 1ª inserção). Logo a ordem é a de `r` + as 3 chaves NOVAS.
_CAMPOS: tuple[str, ...] = (
    "numeroLicitacao",
    "objeto",
    "empresa",
    "fornecedorVencedor",
    "cnpjVencedor",
    "valorVencedor",
    "totalParticipantes",
    "segmento",
    "natureza",
    "dataFim",
    "valorMedio",
    "statusResultado",
    "confidenceLevel",
)

# Cabeçalho do CSV (espelha o array ``csvHeaders`` do Next, mesma ordem).
_CSV_HEADERS: list[str] = [
    "NUMERO_LICITACAO",
    "OBJETO",
    "EMPRESA",
    "FORNECEDOR_VENCEDOR",
    "CNPJ_VENCEDOR",
    "VALOR_VENCEDOR",
    "TOTAL_PARTICIPANTES",
    "VALOR_MEDIO_ORCADO",
    "SEGMENTO",
    "NATUREZA",
    "DATA_FIM",
    "STATUS_RESULTADO",
    "CONFIDENCE",
]


def _esc_csv(valor: Any) -> str:
    """Espelha ``escCsv`` do Next.

    ``null``/``undefined`` → ""; senão ``String(val)``; se contém ``,`` ``"`` ou
    quebra de linha, envolve em aspas duplas com escape de ``"`` → ``""``.
    """
    if valor is None:
        return ""
    s = str(valor)
    if "," in s or '"' in s or "\n" in s:
        return '"' + s.replace('"', '""') + '"'
    return s


@router.get("/api/resultados/export")
async def exportar_resultados(
    request: Request,
    db=Depends(get_db),
) -> Response:
    """GET /api/resultados/export?format=csv|json&search=&segmento=&natureza=&empresa=&cnpj_vencedor=&periodo=.

    Réplica fiel do handler GET do Next: gate de feature (503) ANTES do auth,
    ``requireVisualizar``, 3 queries (legacy + V2 + valor médio) e merge.
    ``format=json`` devolve o array cru (paridade ``JSON.parse``); qualquer
    outro valor (default ``csv``) devolve o CSV.
    """
    # ── GATE de feature (ANTES do auth, igual ao Next) ────────────────────────
    if not _feature_resultados_habilitada():
        return JSONResponse(
            content={"error": "Módulo em reconstrução"}, status_code=503
        )

    # ── Auth: requireVisualizar() — manual para preservar a ordem do Next ─────
    # (gate de feature vem antes; por isso não usamos Depends(require_visualizar)).
    user: CurrentUser = await get_current_user(request)
    require_visualizar(user=user)

    # ── Query params (mesmos defaults do Next: ?? "") ─────────────────────────
    qp = request.query_params
    format_ = qp.get("format") or "csv"
    search = qp.get("search") or ""
    segmento = qp.get("segmento") or ""
    natureza = qp.get("natureza") or ""
    empresa = qp.get("empresa") or ""
    cnpj_vencedor = qp.get("cnpj_vencedor") or ""
    periodo = qp.get("periodo") or ""

    # ── Build WHERE (mesmas condições/ordem do Next) ──────────────────────────
    conditions: list[str] = []
    params: dict[str, Any] = {}

    if search:
        conditions.append(
            "(numero_licitacao ILIKE :search "
            "OR fornecedor_vencedor ILIKE :search "
            "OR objeto ILIKE :search)"
        )
        params["search"] = f"%{search}%"

    if segmento:
        conditions.append("segmento = :segmento")
        params["segmento"] = segmento

    if natureza:
        conditions.append("natureza = :natureza")
        params["natureza"] = natureza

    if empresa:
        conditions.append("empresa ILIKE :empresa")
        params["empresa"] = f"%{empresa}%"

    if cnpj_vencedor:
        conditions.append("cnpj_vencedor = :cnpj_vencedor")
        params["cnpj_vencedor"] = cnpj_vencedor

    # periodo: 7d/30d/90d → criado_em >= NOW() - INTERVAL '<n> days'.
    if periodo == "7d":
        conditions.append("criado_em >= NOW() - INTERVAL '7 days'")
    elif periodo == "30d":
        conditions.append("criado_em >= NOW() - INTERVAL '30 days'")
    elif periodo == "90d":
        conditions.append("criado_em >= NOW() - INTERVAL '90 days'")

    where_sql = (" WHERE " + " AND ".join(conditions)) if conditions else ""

    # ── (1) LEGACY: resultados_licitacao (projeção camelCase, ORDER criado_em DESC) ─
    legacy_sql = text(
        f"""
        SELECT
            numero_licitacao    AS "numeroLicitacao",
            objeto              AS "objeto",
            empresa             AS "empresa",
            fornecedor_vencedor AS "fornecedorVencedor",
            cnpj_vencedor       AS "cnpjVencedor",
            valor_vencedor      AS "valorVencedor",
            total_participantes AS "totalParticipantes",
            segmento            AS "segmento",
            natureza            AS "natureza",
            data_fim            AS "dataFim"
        FROM resultados_licitacao
        {where_sql}
        ORDER BY criado_em DESC
        LIMIT 5000
        """
    )
    raw_legacy = (await db.execute(legacy_sql, params)).mappings().all()

    numeros = [r["numeroLicitacao"] for r in raw_legacy]

    # ── (2) V2: petronect_lic_resultado WHERE numero IN (...) ─────────────────
    v2_map: dict[Any, dict[str, Any]] = {}
    if numeros:
        v2_sql = text(
            """
            SELECT
                numero              AS "numero",
                cnpj_vencedor       AS "cnpjVencedor",
                fornecedor_vencedor AS "fornecedorVencedor",
                valor_vencedor      AS "valorVencedor",
                total_participantes AS "totalParticipantes",
                status_resultado    AS "statusResultado",
                confidence_level    AS "confidenceLevel"
            FROM petronect_lic_resultado
            WHERE numero IN :numeros
            """
        ).bindparams(bindparam("numeros", expanding=True))
        v2_rows = (
            await db.execute(v2_sql, {"numeros": numeros})
        ).mappings().all()
        v2_map = {r["numero"]: dict(r) for r in v2_rows}

    # ── (3) VALOR MÉDIO: AVG(valor_total) das propostas válidas, por licitação ─
    valor_medio_map: dict[Any, Any] = {}
    if numeros:
        vm_sql = text(
            """
            SELECT
                numero_licitacao  AS "numero",
                AVG(valor_total)  AS "valorMedio"
            FROM propostas_licitacao
            WHERE numero_licitacao IN :numeros
              AND declinou = false
              AND valor_total IS NOT NULL
              AND valor_total > 0
            GROUP BY numero_licitacao
            """
        ).bindparams(bindparam("numeros", expanding=True))
        vm_rows = (
            await db.execute(vm_sql, {"numeros": numeros})
        ).mappings().all()
        valor_medio_map = {r["numero"]: r["valorMedio"] for r in vm_rows}

    # ── MERGE (espelha o .map do Next; V2 sobrescreve quando linha existe E
    #    campo não-nulo: `v2?.x ?? r.x`) ───────────────────────────────────────
    data: list[dict[str, Any]] = []
    for r in raw_legacy:
        v2 = v2_map.get(r["numeroLicitacao"])

        def _override(campo: str) -> Any:
            # `v2?.campo ?? r.campo`: usa V2 só se a linha V2 existe e o valor
            # não é None; senão cai no legacy.
            if v2 is not None and v2.get(campo) is not None:
                return v2[campo]
            return r[campo]

        item = {
            "numeroLicitacao": r["numeroLicitacao"],
            "objeto": r["objeto"],
            "empresa": r["empresa"],
            "fornecedorVencedor": _override("fornecedorVencedor"),
            "cnpjVencedor": _override("cnpjVencedor"),
            "valorVencedor": _override("valorVencedor"),
            "totalParticipantes": _override("totalParticipantes"),
            "segmento": r["segmento"],
            "natureza": r["natureza"],
            "dataFim": r["dataFim"],
            "valorMedio": valor_medio_map.get(r["numeroLicitacao"]),
            "statusResultado": v2["statusResultado"] if v2 is not None else None,
            "confidenceLevel": v2["confidenceLevel"] if v2 is not None else None,
        }
        # Serializa (numeric→str, datetime→iso) preservando a ordem das chaves.
        data.append({campo: _serializar(item[campo]) for campo in _CAMPOS})

    # ── JSON format ───────────────────────────────────────────────────────────
    if format_ == "json":
        # NextResponse.json(data) → ARRAY CRU (sem wrapper). Header de download
        # replicado para fidelidade do estrangulador.
        return JSONResponse(
            content=data,
            headers={
                "Content-Disposition": (
                    'attachment; filename="resultados_export.json"'
                )
            },
        )

    # ── CSV format (caminho default; fora do escopo do JSON.parse de paridade) ─
    csv_rows: list[str] = [",".join(_CSV_HEADERS)]
    for row in data:
        csv_rows.append(
            ",".join(
                [
                    _esc_csv(row["numeroLicitacao"]),
                    _esc_csv(row["objeto"]),
                    _esc_csv(row["empresa"]),
                    _esc_csv(row["fornecedorVencedor"]),
                    _esc_csv(row["cnpjVencedor"]),
                    _esc_csv(row["valorVencedor"]),
                    _esc_csv(row["totalParticipantes"]),
                    _esc_csv(row["valorMedio"]),
                    _esc_csv(row["segmento"]),
                    _esc_csv(row["natureza"]),
                    _esc_csv(row["dataFim"]),
                    _esc_csv(row["statusResultado"]),
                    _esc_csv(row["confidenceLevel"]),
                ]
            )
        )

    return Response(
        content="\n".join(csv_rows),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": (
                'attachment; filename="resultados_export.csv"'
            )
        },
    )
