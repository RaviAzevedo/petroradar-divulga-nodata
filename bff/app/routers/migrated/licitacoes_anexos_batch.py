"""Rota MIGRADA (estrangulador): POST /api/licitacoes/anexos-batch.

Espelha 1:1 ``src/app/api/licitacoes/anexos-batch/route.ts`` do app Next.js.

──────────────────────────────────────────────────────────────────────────────
O QUE A ROTA FAZ (e o que NÃO faz):

  O Next exporta APENAS ``POST``. Recebe ``{ ids: string[] }`` (ids de
  licitações) e devolve, em UMA query, somente os ANEXOS de cada licitação
  (id/phioObjid/descricao) — sem trazer ``texto_cache``/``s3_key`` nem o payload
  pesado de ``/api/licitacoes/[id]``. Resolve o N+1 da página de Downloads.

  ⚠️ Esta rota é de LISTAGEM (resolver de anexos por lote). Ela NÃO faz
  upload/download/delete de arquivo no S3/MinIO — não há GET/PUT/PATCH/DELETE no
  route.ts. Portanto NÃO há acesso a storage aqui (o download propriamente dito
  é servido por outra rota — ``/api/licitacoes/[id]/anexos/[anexoId]/download``).
  Replicar parity EXIGE não inventar métodos que o Next não expõe: criar um
  GET/POST-de-upload aqui quebraria a paridade de superfície da API. Mantemos,
  abaixo, helpers boto3 prontos (S3 client path-style) caso a próxima onda traga
  o download para o BFF — sem ativá-los nesta rota.

──────────────────────────────────────────────────────────────────────────────
GUARD (paridade EXATA com o Next):

  POST → ``requireVisualizar()`` == BFF ``require_visualizar`` (ADMIN, LIDER,
         ORCAMENTISTA, TECNICO, SGI, VISUALIZADOR). O 401 vem de
         ``get_current_user``; o 403 de ``require_role``. (Mesma convenção dos
         irmãos migrados — ex.: ``licitacoes_id.py`` — que usam o guard
         semântico via ``Depends`` em vez de replicar o ``{error,code}`` à mão.)

VALIDAÇÕES e ERROS (mesmos status/mensagens do Next, shape ``{ "error": <str> }``):

  - JSON do corpo ilegível                         → 400 ``{"error":"JSON inválido"}``
  - ``ids`` não-array / vazio / item não-string    → 422
        ``{"error":"Esperado { ids: string[] } com pelo menos 1 id"}``
  - ``ids.length > 200``                           → 422
        ``{"error":"Máximo de 200 licitações por chamada"}``

  O guard de paridade do Next valida ``ids.length === 0`` E ``ids.some(i => typeof
  i !== "string")`` na MESMA condição do array. Replicamos a ordem: primeiro a
  forma do array (422 genérico), depois o limite (422 de limite).

SHAPE de sucesso (200) — IDÊNTICO ao Next:

    {
      "data": [
        { "licitacaoId": "<id>",
          "anexos": [ { "id": "<uuid>", "phioObjid": <str|null>,
                        "descricao": <str|null> }, ... ] },
        ...
      ]
    }

  - A ordem das licitações em ``data`` preserva a ORDEM DOS IDS PEDIDOS (o Next
    pré-popula um Map com ``ids`` na ordem recebida; aqui usamos um dict, que em
    Python 3.7+ preserva ordem de inserção — semântica idêntica).
  - TODOS os ids pedidos aparecem em ``data``, mesmo sem anexos (lista vazia).
  - Ids DUPLICADOS no input: o Next usa ``porLic.set(id, [])`` por id e depois um
    único ``Map`` — chaves duplicadas colapsam numa só entrada; replicamos com
    dict (mesma deduplicação, mesma ordem da PRIMEIRA ocorrência).
  - Ids pedidos que NÃO são UUID válido (ex.: ``"foo"``): o Drizzle ``inArray``
    gera ``licitacao_id in ($1,...)`` contra a coluna UUID e manda os parâmetros
    como TEXTO; o Postgres tenta fazer cast de cada texto p/ uuid pelo contexto
    da coluna e, num id malformado, levanta ``invalid input syntax for type
    uuid``. No route.ts o ``db.select`` está FORA do try/catch (o try só envolve
    ``requireVisualizar()``/``request.json()``), então esse erro propaga e o Next
    responde **500 ``{"error":"Erro interno"}``** — NÃO entra em ``data`` com
    lista vazia. Para manter paridade observável, o BFF filtra por
    ``licitacao_id = ANY(CAST(:ids AS uuid[]))`` (cast do array p/ uuid[], igual ao
    comportamento do Drizzle), de modo que um id não-uuid levanta o mesmo erro de
    cast, propaga (a query também fica fora de try/except) e o middleware global
    devolve 500 — espelhando o Next. (Ids UUID-válidos que simplesmente não
    existem em ``anexos`` continuam aparecendo em ``data`` com ``anexos:[]``,
    igual aos dois lados.)

  Projeção dos anexos (mesmas 3 colunas que o Next seleciona, mesmos aliases
  camelCase do Drizzle ``anexos``):
      id        <- anexos.id         (uuid)
      phioObjid <- anexos.phio_objid (text)
      descricao <- anexos.descricao  (text)
  ORDER BY ``descricao`` (igual ao ``.orderBy(anexos.descricao)`` do Drizzle →
  ``ASC NULLS LAST`` no Postgres). O agrupamento por licitação é feito em Python,
  preservando a ordem dos anexos retornada pela query.

Objetivo: ``JSON.parse(resp_bff) === JSON.parse(resp_next)``.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.config import settings
from app.core.security import CurrentUser, require_visualizar
from app.db.session import get_db

router = APIRouter()

# Mesmo limite do Next (``const LIMITE = 200``).
_LIMITE = 200


# ══════════════════════════════════════════════════════════════════════════════
# Storage S3/MinIO — helpers boto3 (path-style, MinIO) PRONTOS para a próxima
# onda (download de anexo no BFF). NÃO usados por esta rota de listagem; ficam
# aqui para que o handler de download (key em ``anexos.s3_key``) replique
# ``streamFromR2``/``getR2ObjectBuffer`` de ``src/lib/storage`` sem reescrever o
# cliente. Import lazy de boto3 (não está no caminho quente da listagem).
# ══════════════════════════════════════════════════════════════════════════════


def _s3_client():
    """Cria um client boto3 S3 path-style (MinIO EXIGE ``addressing_style=path``).

    Espelha ``getR2Client`` de ``src/lib/storage/r2.ts`` (endpoint explícito,
    ``forcePathStyle: true``). ``region_name='us-east-1'`` é o default exigido
    por assinatura SigV4 contra MinIO (o R2 usava ``region:'auto'``; o MinIO
    on-prem ignora a região mas exige uma válida na assinatura).
    """
    import boto3  # import tardio: storage fora do caminho quente da listagem.
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint or None,
        aws_access_key_id=settings.s3_access_key or None,
        aws_secret_access_key=settings.s3_secret_key or None,
        region_name="us-east-1",
        config=Config(s3={"addressing_style": "path"}),
    )


# ══════════════════════════════════════════════════════════════════════════════
# Handler (POST) — réplica fiel do route.ts
# ══════════════════════════════════════════════════════════════════════════════


@router.post("/api/licitacoes/anexos-batch")
async def anexos_batch(
    request: Request,
    user: CurrentUser = Depends(require_visualizar),  # requireVisualizar() do Next
    db=Depends(get_db),
) -> JSONResponse:
    """POST /api/licitacoes/anexos-batch — anexos de várias licitações em 1 query.

    O guard ``require_visualizar`` já entrega 401/403 antes do handler (igual ao
    ``requireVisualizar()`` do Next, que roda no topo do ``try``).
    """
    # body = await request.json(); catch -> 400 { "error": "JSON inválido" }
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 — corpo não-JSON / vazio == catch do Next
        return JSONResponse(status_code=400, content={"error": "JSON inválido"})

    # const ids = (body as { ids?: unknown }).ids
    ids = body.get("ids") if isinstance(body, dict) else None

    # if (!Array.isArray(ids) || ids.length === 0 || ids.some(i => typeof i !== "string")) -> 422
    if (
        not isinstance(ids, list)
        or len(ids) == 0
        or any(not isinstance(i, str) for i in ids)
    ):
        return JSONResponse(
            status_code=422,
            content={"error": "Esperado { ids: string[] } com pelo menos 1 id"},
        )

    # if (ids.length > LIMITE) -> 422
    if len(ids) > _LIMITE:
        return JSONResponse(
            status_code=422,
            content={"error": f"Máximo de {_LIMITE} licitações por chamada"},
        )

    # UMA query pra todos os anexos das licitações pedidas (mesmas 3 colunas,
    # mesmos aliases camelCase do Drizzle, mesmo ORDER BY descricao).
    # PARIDADE com o Drizzle ``inArray(anexos.licitacaoId, ids)``: gera
    # ``licitacao_id in ($1,...)`` contra a coluna UUID; os parâmetros vão como
    # texto e o Postgres os faz cast p/ uuid pelo contexto da coluna. Replicamos
    # com ``= ANY(CAST(:ids AS uuid[]))`` (cast do array de texto p/ uuid[]), NAO com
    # ``licitacao_id::text``. ATENCAO a forma do cast: ``:ids::uuid[]`` NAO compila
    # no SQLAlchemy 2.0 — o bind colado no ``::`` nao e reconhecido, o literal
    # ``:ids::uuid[]`` chega cru ao asyncpg e a rota falha com PostgresSyntaxError
    # para QUALQUER entrada. Use sempre CAST(... AS ...).
    # ``licitacao_id::text`` — assim um id que NÃO é uuid válido levanta
    # ``invalid input syntax for type uuid`` exatamente como no Next, propaga sem
    # captura (a query, igual ao route.ts, fica FORA de qualquer try/except) e o
    # middleware global devolve 500 ``{"error":"Erro interno"}`` — mesma resposta
    # observável do Next (cujo ``db.select`` também está fora do try).
    rows_sql = text(
        """
        SELECT
          licitacao_id AS "licitacaoId",
          id           AS "id",
          phio_objid   AS "phioObjid",
          descricao    AS "descricao"
        FROM anexos
        WHERE licitacao_id = ANY(CAST(:ids AS uuid[]))
        ORDER BY descricao
        """
    )
    rows = (await db.execute(rows_sql, {"ids": list(ids)})).mappings().all()

    # Agrupa por licitação preservando TODOS os ids pedidos (mesmo sem anexos) e a
    # ORDEM dos ids recebidos. dict (3.7+) preserva inserção == new Map(...) do JS.
    por_lic: dict[str, list[dict]] = {}
    for lic_id in ids:
        por_lic.setdefault(lic_id, [])  # set(id, []) — duplicados colapsam
    for r in rows:
        lista = por_lic.get(str(r["licitacaoId"]))
        if lista is not None:  # porLic.get(...)?.push(...) — ignora chave ausente
            lista.append(
                {
                    "id": str(r["id"]),
                    "phioObjid": r["phioObjid"],
                    "descricao": r["descricao"],
                }
            )

    # Array.from(porLic.entries()).map(([licitacaoId, lista]) => ({licitacaoId, anexos: lista}))
    data = [
        {"licitacaoId": lic_id, "anexos": lista}
        for lic_id, lista in por_lic.items()
    ]

    return JSONResponse(content={"data": data})
