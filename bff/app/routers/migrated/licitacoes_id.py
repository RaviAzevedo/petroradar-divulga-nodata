"""Rota migrada (strangler-fig): GET /api/licitacoes/{id}.

Espelho 1:1 de ``src/app/api/licitacoes/[id]/route.ts`` (handler GET) — paridade
de resposta com o BFF FastAPI (``JSON.parse(bff) === JSON.parse(next)``).

Detalhe completo de uma licitação + filhos. O Next faz 6 queries Drizzle e
monta um único objeto sob ``{ "data": { ... } }``.

Guard Next:
    ``requireVisualizar()`` → ``requireAuth()`` (401 ``{error,code}`` se sem
    sessão) + ``podeVisualizar(role)`` → role ∈ {ADMIN, LIDER, ORCAMENTISTA,
    TECNICO, SGI, VISUALIZADOR}, senão 403.
Equivalente no BFF: :data:`app.core.security.require_visualizar` (mesmos papéis;
o 401 vem de ``get_current_user``, o 403 de ``require_role``).

Validação de ID (igual ao Next):
    UUID v-agnóstico via regex
    ``^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`` (case-
    insensitive). Se não casar → 400 ``{ "error": "ID inválido" }``.
    Se o UUID for válido mas não existir → 404
    ``{ "error": { "code": "NOT_FOUND", "message": "Licitação não encontrada" } }``.

Queries replicadas (mesma ordem/joins/filtros/ordenação/limites do Drizzle):
    1. licitacoes  — ``SELECT *`` WHERE id = :id LIMIT 1 (``...lic`` espalha
       TODAS as colunas; projeto cada uma com alias camelCase do Drizzle).
    2. itens       — ``SELECT *`` WHERE licitacao_id = :id ORDER BY item_numero.
    3. anexos      — COLUNAS EXPLÍCITAS (id, descricao, phioObjid, s3Key,
       tamanhoBytes, contentType, baixadoEm) — NÃO traz texto_cache/erro_download/
       criado_em/licitacao_id — WHERE licitacao_id = :id ORDER BY descricao.
    4. historico   — ``SELECT *`` WHERE licitacao_id = :id ORDER BY detectado_em
       DESC (historico_alteracoes).
    5. analise     — ``SELECT *`` WHERE licitacao_id = :id LIMIT 1 → objeto ou
       ``null`` (``analise ?? null``).
    6. totalCirculares — ``count(*)::int`` WHERE licitacao_id = :id.

Shape da resposta:
    ``{ "data": { <todas as colunas de licitacoes>, "itens": [...],
       "anexos": [...], "historico": [...], "analise": {...}|null,
       "totalCirculares": <int> } }``.

Serialização (paridade JSON com o Drizzle/pg):
    - timestamp (com ou sem tz) → ISO 8601 via ``datetime.isoformat()``.
    - uuid → ``str()`` (o Drizzle/pg devolve uuid como STRING).
    - jsonb → dict/list nativo (asyncpg já parseia).
    - integer/serial → int; real → float; text → str; NULL → null.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import CurrentUser, require_visualizar
from app.db.session import get_db

router = APIRouter()

# Mesma regex do Next (case-insensitive). Não valida a versão do UUID — só o
# formato. Espelha exatamente o ``UUID_REGEX`` da rota.
_UUID_REGEX = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _jsonable(value):
    """Normaliza um valor de coluna para algo JSON-serializável (paridade Next).

    - ``UUID``      → ``str`` (Drizzle/pg devolve uuid como string).
    - ``datetime``  → ISO 8601 via ``isoformat()`` (igual ao Date serializado).
    - ``date``      → ISO 8601 via ``isoformat()``.
    - ``Decimal``   → ``float`` (numeric → number do pg/Drizzle).
    - jsonb (dict/list) e escalares (int/float/bool/str/None) já são serializáveis.
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


# ── Projeção da tabela licitacoes (snake_case → alias camelCase do Drizzle) ────
# ``...lic`` no Next espalha TODAS as colunas de ``licitacoes`` (db.select()).
# Reproduzo cada coluna com o MESMO alias que o Drizzle expõe (a prop do schema).
_LIC_SELECT = """
    id                   AS "id",
    numero               AS "numero",
    fonte                AS "fonte",
    objeto               AS "objeto",
    objeto_resumido      AS "objetoResumido",
    empresa              AS "empresa",
    empresa_codigo       AS "empresaCodigo",
    status_code          AS "statusCode",
    status               AS "status",
    sub_status           AS "subStatus",
    fase                 AS "fase",
    modalidade           AS "modalidade",
    tipo_oportunidade    AS "tipoOportunidade",
    abrangencia          AS "abrangencia",
    data_inicio          AS "dataInicio",
    hora_inicio          AS "horaInicio",
    data_fim             AS "dataFim",
    hora_fim             AS "horaFim",
    data_publicacao      AS "dataPublicacao",
    data_abertura        AS "dataAbertura",
    hora_abertura        AS "horaAbertura",
    data_disputa         AS "dataDisputa",
    hora_disputa         AS "horaDisputa",
    posting_date         AS "postingDate",
    dou_num              AS "douNum",
    regioes              AS "regioes",
    limite_dias          AS "limiteDias",
    equalizada           AS "equalizada",
    pre_qualificada      AS "preQualificada",
    natureza             AS "natureza",
    tipo_servico         AS "tipoServico",
    segmento             AS "segmento",
    relevancia           AS "relevancia",
    score_interesse      AS "scoreInteresse",
    perfis_match         AS "perfisMatch",
    melhor_perfil        AS "melhorPerfil",
    classificacao_ia     AS "classificacaoIa",
    classificado_ia_em   AS "classificadoIaEm",
    notificado_perfil_em AS "notificadoPerfilEm",
    dados_completos      AS "dadosCompletos",
    criado_em            AS "criadoEm",
    atualizado_em        AS "atualizadoEm"
"""

# ── Projeção da tabela itens (db.select() = todas as colunas) ──────────────────
_ITENS_SELECT = """
    id                   AS "id",
    licitacao_id         AS "licitacaoId",
    item_numero          AS "itemNumero",
    exlin                AS "exlin",
    descricao            AS "descricao",
    material             AS "material",
    familia              AS "familia",
    familia_descricao    AS "familiaDescricao",
    familia_classif      AS "familiaClassif",
    quantidade           AS "quantidade",
    unidade              AS "unidade",
    data_entrega         AS "dataEntrega",
    tipo_processo        AS "tipoProcesso",
    nivel_agrupamento    AS "nivelAgrupamento",
    notas                AS "notas",
    dados_brutos         AS "dadosBrutos",
    criado_em            AS "criadoEm"
"""

# ── Projeção da tabela historico_alteracoes (db.select() = todas as colunas) ───
_HIST_SELECT = """
    id                   AS "id",
    licitacao_id         AS "licitacaoId",
    campo                AS "campo",
    valor_anterior       AS "valorAnterior",
    valor_novo           AS "valorNovo",
    detectado_em         AS "detectadoEm",
    notificado           AS "notificado"
"""

# ── Projeção da tabela analises_ia (db.select() = todas as colunas) ────────────
_ANALISE_SELECT = """
    id                       AS "id",
    licitacao_id             AS "licitacaoId",
    resumo                   AS "resumo",
    objeto_detalhado         AS "objetoDetalhado",
    checklist                AS "checklist",
    requisitos               AS "requisitos",
    criterios_habilitacao    AS "criteriosHabilitacao",
    criterios_julgamento     AS "criteriosJulgamento",
    valor_estimado           AS "valorEstimado",
    prazos                   AS "prazos",
    riscos                   AS "riscos",
    recomendacao             AS "recomendacao",
    modelo_usado             AS "modeloUsado",
    tokens_input             AS "tokensInput",
    tokens_output            AS "tokensOutput",
    custo_estimado           AS "custoEstimado",
    tempo_segundos           AS "tempoSegundos",
    resposta_raw             AS "respostaRaw",
    erro_parse               AS "erroParse",
    schema_versao            AS "schemaVersao",
    prob_vitoria             AS "probVitoria",
    prob_vitoria_fatores     AS "probVitoriaFatores",
    prob_vitoria_calculada_em AS "probVitoriaCalculadaEm",
    analisado_em             AS "analisadoEm",
    atualizado_em            AS "atualizadoEm"
"""


@router.get("/api/licitacoes/{id}")
async def get_licitacao(
    id: str,
    request: Request,
    user: CurrentUser = Depends(require_visualizar),
    db=Depends(get_db),
) -> JSONResponse:
    """GET /api/licitacoes/{id} — paridade 1:1 com a rota Next.

    O guard (``require_visualizar``) já entrega 401/403 antes do handler, igual
    ao ``requireVisualizar()`` do Next. Dentro do handler: valida o UUID (400),
    busca a licitação (404 se não existe) e monta o objeto agregado.
    """
    # ── Validação do UUID (regex idêntica ao Next) → 400 se não casar. ─────────
    # fullmatch evita o edge-case do ``$`` do Python aceitar ``\n`` final, que o
    # ``.test()`` do JS (sem flag ``m``) não aceitaria.
    if not _UUID_REGEX.fullmatch(id):
        return JSONResponse(content={"error": "ID inválido"}, status_code=400)

    # ── 1) Licitação (SELECT * ... LIMIT 1). ──────────────────────────────────
    res_lic = await db.execute(
        text(f"SELECT {_LIC_SELECT} FROM licitacoes WHERE id = :id LIMIT 1"),
        {"id": id},
    )
    lic_row = res_lic.mappings().first()

    # ── 404 se não encontrada (mesmo shape de erro do Next). ──────────────────
    if lic_row is None:
        return JSONResponse(
            content={
                "error": {
                    "code": "NOT_FOUND",
                    "message": "Licitação não encontrada",
                }
            },
            status_code=404,
        )

    lic = {chave: _jsonable(valor) for chave, valor in lic_row.items()}

    # ── 2) Itens (SELECT * WHERE licitacao_id ORDER BY item_numero). ──────────
    res_itens = await db.execute(
        text(
            f"SELECT {_ITENS_SELECT} FROM itens "
            "WHERE licitacao_id = :id ORDER BY item_numero"
        ),
        {"id": id},
    )
    itens = [_linha(row) for row in res_itens.all()]

    # ── 3) Anexos (COLUNAS EXPLÍCITAS — sem texto_cache — ORDER BY descricao). ─
    res_anexos = await db.execute(
        text(
            """
            SELECT
                id            AS "id",
                descricao     AS "descricao",
                phio_objid    AS "phioObjid",
                s3_key        AS "s3Key",
                tamanho_bytes AS "tamanhoBytes",
                content_type  AS "contentType",
                baixado_em    AS "baixadoEm"
            FROM anexos
            WHERE licitacao_id = :id
            ORDER BY descricao
            """
        ),
        {"id": id},
    )
    anexos = [_linha(row) for row in res_anexos.all()]

    # ── 4) Histórico (SELECT * ORDER BY detectado_em DESC). ───────────────────
    res_hist = await db.execute(
        text(
            f"SELECT {_HIST_SELECT} FROM historico_alteracoes "
            "WHERE licitacao_id = :id ORDER BY detectado_em DESC"
        ),
        {"id": id},
    )
    historico = [_linha(row) for row in res_hist.all()]

    # ── 5) Análise IA (SELECT * LIMIT 1) → objeto ou null. ────────────────────
    res_analise = await db.execute(
        text(
            f"SELECT {_ANALISE_SELECT} FROM analises_ia "
            "WHERE licitacao_id = :id LIMIT 1"
        ),
        {"id": id},
    )
    analise_row = res_analise.mappings().first()
    analise = (
        {chave: _jsonable(valor) for chave, valor in analise_row.items()}
        if analise_row is not None
        else None
    )

    # ── 6) Total de circulares (count(*)::int). ───────────────────────────────
    res_circ = await db.execute(
        text("SELECT count(*)::int AS count FROM circulares WHERE licitacao_id = :id"),
        {"id": id},
    )
    total_circulares = int(res_circ.scalar() or 0)

    # ── Monta o objeto agregado (mesmo shape do Next: { data: { ...lic, ... } }).
    data = {
        **lic,
        "itens": itens,
        "anexos": anexos,
        "historico": historico,
        "analise": analise,
        "totalCirculares": total_circulares,
    }

    return JSONResponse(content={"data": data})
