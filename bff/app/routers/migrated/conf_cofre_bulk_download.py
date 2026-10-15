"""Rota MIGRADA (estrangulador / strangler-fig):
    POST /api/conformidade/cofre/documentos/bulk-download

Espelho 1:1 de
``src/app/api/conformidade/cofre/documentos/bulk-download/route.ts`` — Cofre de
Documentos de Habilitação, download em LOTE (ZIP). Esta rota do Next possui um
ÚNICO handler (POST); não há GET/PATCH/DELETE aqui (o GET/PATCH/DELETE de um
documento individual vivem na rota irmã ``[id]/route.ts``, já migrada em
``conf_cofre_documentos_id.py``). Replicamos fielmente o handler existente.

──────────────────────────────────────────────────────────────────────────────
O QUE A ROTA FAZ (0034/R12 — B5: duas formas de request)
──────────────────────────────────────────────────────────────────────────────
FORMA ATUAL (intacta): ``{ ids: string[] }`` → ZIP com:
  - o blob principal de cada documento (sob ``<categoria>/<titulo>__<arquivo>``)
  - todos os anexos extras (sob ``<categoria>/<titulo>/anexos/<arquivo>``)
  - um ``INDICE.txt`` com a listagem do conteúdo

FORMA NOVA (0034): ``{ operacaoId, secao?, ids? }`` → ZIP do DOSSIÊ da
operação, com árvore por SEÇÃO da ficha (``SECOES_FICHA`` de
``conf_dossie_secoes.py`` — slugs canônicos), raiz ``<codigo> - <cliente>``,
INDICE.txt próprio e nome ``dossie_<codigo>[_secao<N>]_<data>.zip``. Com
``operacaoId`` presente, ``ids`` (≤100) vira RECORTE: interseção com os
documentos visíveis da operação/seção, na ordem estável da query — é a saída
para as seções que estouram o teto de contagem sozinhas (ex.: operação 12345
seção 3); ids fora da operação/seção são ignorados em silêncio. Anexos extras
ficam FORA da forma nova (dossiê é a prova principal).

0044 (C6 — onda 5): a forma NOVA ganha ``arvore`` no BODY (nunca query string
— esta rota não lê nenhuma), com três regras: valor fora de
``"secao" | "disciplina"`` → 422; AUSENTE → "secao" e nada muda em byte nenhum
da resposta de hoje; presente na forma ANTIGA (``{ids}`` sem ``operacaoId``) →
422, porque a árvore por disciplina é do dossiê e ignorá-la calada faria o
usuário baixar uma árvore por categoria acreditando ter pedido outra coisa.
``arvore`` NÃO filtra nada: os tetos e o conjunto de documentos são os mesmos;
só o cálculo do slug e o nome do arquivo mudam (spec ONDA-5 §1a/§5.3).

RESTRITO (as duas formas — §11.5): para papel fora de Conformidade, documento
``restrito=true`` NÃO entra no ZIP e NÃO aparece no INDICE.txt — nem como
"1 omitido" (mencionar divulgaria a existência; ADR-05). Para Conformidade,
entra, e cada restrito incluído gera uma linha em ``audit_download_restrito``
(``via='ZIP_DOSSIE'`` na forma nova, ``'ZIP_SELECAO'`` na forma ids), gravada
ANTES de montar o buffer, best-effort com log.

O ZIP é montado INTEIRO EM MEMÓRIA antes de enviar (igual ao Next, que usa
JSZip + ``generateAsync({type:"uint8array"})`` e devolve ``Buffer.from(bytes)``).
Por isso há dois tetos de proteção:
  - LIMITE        = 100 documentos por chamada.
  - LIMITE_BYTES  = 200 MB (soma docs + anexos por ``tamanhoBytes`` do banco).

──────────────────────────────────────────────────────────────────────────────
GUARD (mapeamento requireVisualizar do Next → shape {error, code} do BFF)
──────────────────────────────────────────────────────────────────────────────
Next: ``await requireVisualizar()`` dentro de ``try {} catch (e) { return
handleApiError(e); }``.
  - ``requireVisualizar()`` = sessão + ``podeVisualizar(role)``
    (role ∈ {ADMIN, LIDER, ORCAMENTISTA, TECNICO, SGI, VISUALIZADOR}; barra
    EXTERNO).
  - 401 ``{"error":"Não autenticado","code":"UNAUTHENTICATED"}``  (sem sessão)
  - 403 ``{"error":"Permissão negada","code":"FORBIDDEN"}``       (papel barrado)

Como o handler do Next chama ``requireVisualizar()`` SOB um try/catch que
converte a exceção via ``handleApiError`` (shape ``{error, code}``, NÃO o
``{detail}`` default do FastAPI), replicamos localmente ``_ApiError`` /
``_handle_api_error`` / ``_require_visualizar`` (convenção dos irmãos
migrados) em vez de usar o ``Depends(require_visualizar)``
(que produziria ``{detail}``).

──────────────────────────────────────────────────────────────────────────────
ORDEM das checagens (preservada do Next)
──────────────────────────────────────────────────────────────────────────────
  1. guard requireVisualizar (401/403).
  2. 400 ``{"error":"JSON inválido"}``           — body não-parseável.
  3. 422 ``{"error":"Esperado { ids: string[] } com pelo menos 1 id"}``
        — ids ausente / não-array / vazio / item não-string.
  4. 422 ``{"error":"Máximo de 100 documentos por download"}``   — ids > 100.
  5. SELECT documentos (inArray ids); 404 ``{"error":"Nenhum documento
        encontrado"}`` se vazio.
  6. SELECT anexos (inArray documento_id ∈ docs).
  7. 422 ``Pacote muito grande (...)`` se soma > LIMITE_BYTES.
  8. Baixa blobs do MinIO (allSettled — falha individual NÃO derruba o ZIP),
     monta ZIP + INDICE.txt, devolve 200 ``application/zip``.

──────────────────────────────────────────────────────────────────────────────
STORAGE (S3/MinIO via boto3 — path-style; espelha getR2ObjectBuffer)
──────────────────────────────────────────────────────────────────────────────
O Next usa ``getR2ObjectBuffer(key)`` (``@aws-sdk/client-s3`` GetObject →
``transformToByteArray`` → Buffer). Aqui usamos ``boto3`` (client S3 síncrono)
com:
    endpoint_url=settings.s3_endpoint,
    aws_access_key_id=settings.s3_access_key,
    aws_secret_access_key=settings.s3_secret_key,
    region_name="us-east-1",
    config=Config(s3={"addressing_style": "path"}),   # MinIO EXIGE path-style
    bucket=settings.s3_bucket
``get_object`` lê o objeto inteiro (``["Body"].read()``) — equivalente ao buffer
do Next. Import de boto3 é tardio (dentro da função) e a leitura roda em
threadpool (``run_in_threadpool``) para não bloquear o event loop. Falha ao
baixar uma key específica é capturada por documento/anexo (igual ao
``Promise.allSettled`` do Next): a entrada vira ``[ERRO]`` no INDICE e é pulada.

──────────────────────────────────────────────────────────────────────────────
PARIDADE DE BYTES DO ZIP
──────────────────────────────────────────────────────────────────────────────
JSZip e o ``zipfile`` do Python NÃO produzem bytes idênticos (ordem de campos,
data de modificação, flags). A paridade aqui é COMPORTAMENTAL/funcional: mesmo
conjunto de entradas, mesmos NOMES de path dentro do ZIP, mesmo INDICE.txt
(conteúdo), mesmos headers HTTP (Content-Type, Content-Disposition, Cache-Control),
mesmo ``filename`` e mesmos status. O ``Content-Length`` reflete o tamanho real
do ZIP gerado pelo Python (igual ao Next, que também usa ``bytes.length`` do ZIP
gerado).
"""

from __future__ import annotations

import io
import re
import unicodedata
import zipfile
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response
from sqlalchemy import text

from app.core.security import (
    CurrentUser,
    ROLES_VISUALIZAR,
    get_current_user,
)
from app.db.session import SessionLocal
from app.routers.migrated._restrito import (
    is_conformidade,
    registrar_download_restrito,
    restricao_visivel_sql,
)
from app.routers.migrated._shared import js_round
from app.routers.migrated.conf_dossie_secoes import (
    SECOES_FICHA,
    secao_do_documento,
)

router = APIRouter()

# Regex LITERAL do ``z.string().uuid()`` do Zod v4.4.3 (``ehUuid`` do Next) —
# ``operacaoId`` não-UUID vira 404, nunca 500 de cast.
_UUID_ZOD_REGEX = re.compile(
    r"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}"
    r"-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000"
    r"|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
)

# ── Constantes (espelham as do route.ts) ──────────────────────────────────────
LIMITE = 100
# Teto de bytes somados (docs + anexos). ~200 MB. Acima disso recusamos pra não
# estourar memória ao montar o ZIP inteiro em buffer.
LIMITE_BYTES = 200 * 1024 * 1024


# ══════════════════════════════════════════════════════════════════════════════
# ApiError + handleApiError (espelham src/lib/api/guards.ts)
# ══════════════════════════════════════════════════════════════════════════════
class _ApiError(Exception):
    """Espelha a ``ApiError`` de ``src/lib/api/guards.ts`` (status + code + msg)."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _handle_api_error(err: Exception) -> JSONResponse:
    """Espelha ``handleApiError``: ApiError → ``{error, code}``; resto → 500.

    Shape do guard no Next é ``{"error": <msg>, "code": <code>}`` (NÃO o
    ``{detail}`` default do FastAPI). Inesperados → 500 ``{error:"Erro interno"}``.
    """
    if isinstance(err, _ApiError):
        return JSONResponse(
            content={"error": err.message, "code": err.code},
            status_code=err.status,
        )
    return JSONResponse(content={"error": "Erro interno"}, status_code=500)


async def _require_auth(request: Request) -> CurrentUser:
    """``requireAuth()``: 401 ``{error:"Não autenticado",code:"UNAUTHENTICATED"}``."""
    try:
        return await get_current_user(request)
    except Exception as exc:  # noqa: BLE001 — qualquer falha de auth = 401
        raise _ApiError(401, "UNAUTHENTICATED", "Não autenticado") from exc


async def _require_visualizar(request: Request) -> CurrentUser:
    """``requireVisualizar()``: 401 sem sessão / 403 sem permissão de visualizar.

    ``podeVisualizar(role)`` → role ∈ {ADMIN, LIDER, ORCAMENTISTA, TECNICO, SGI,
    VISUALIZADOR}; barra EXTERNO → 403 ``Permissão negada``.
    """
    user = await _require_auth(request)
    if user.role not in ROLES_VISUALIZAR:
        raise _ApiError(403, "FORBIDDEN", "Permissão negada")
    return user


# ══════════════════════════════════════════════════════════════════════════════
# sanitize (réplica EXATA do sanitize() do route.ts)
# ══════════════════════════════════════════════════════════════════════════════
_PROIBIDOS = set('/\\:*?"<>|')


def _sanitize(nome: Any) -> str:
    """Réplica de ``sanitize`` do route.ts.

    Passos (mesma ordem do Next):
      1. NFD + remove combining marks (acentos).
      2. troca / \\ : * ? " < > | por '_'.
      3. colapsa qualquer sequência de espaços (\\s+) em UM espaço.
      4. trim.
      5. fatia em 180 chars.
      6. fallback "arquivo" se vazio.
    """
    s = "" if nome is None else str(nome)
    # (1) NFD + drop combining marks (equivalente a /[̀-ͯ]/g).
    s = "".join(c for c in unicodedata.normalize("NFD", s)
                if not unicodedata.combining(c))
    # (2) caracteres de path proibidos → '_'.
    s = "".join("_" if c in _PROIBIDOS else c for c in s)
    # (3) \s+ → " " (inclui espaços, tabs, quebras de linha).
    s = " ".join(s.split())
    # (4) trim (já coberto pelo split/join, mas mantém paridade explícita).
    s = s.strip()
    # (5) slice(0, 180).
    s = s[:180]
    # (6) fallback.
    return s or "arquivo"


# ══════════════════════════════════════════════════════════════════════════════
# Storage (S3 / MinIO) — leitura de objeto via boto3 (espelha getR2ObjectBuffer)
# ══════════════════════════════════════════════════════════════════════════════
def _get_object_bytes(key: str) -> bytes:
    """Lê o objeto inteiro do S3/MinIO e devolve os bytes (igual ao buffer do Next).

    boto3 client S3 com path-style (MinIO exige). SÍNCRONO — chamado via
    ``run_in_threadpool`` para não bloquear o event loop. Levanta em falha
    (key inexistente / erro de storage) — o chamador captura por item, igual ao
    ``Promise.allSettled`` do Next (a entrada vira ``[ERRO]`` e é pulada).
    """
    import boto3  # import tardio: storage fora do caminho quente
    from botocore.config import Config

    from app.core.config import settings

    client = boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint or None,
        aws_access_key_id=settings.s3_access_key or None,
        aws_secret_access_key=settings.s3_secret_key or None,
        region_name="us-east-1",
        config=Config(s3={"addressing_style": "path"}),
    )
    resp = client.get_object(Bucket=settings.s3_bucket, Key=key)
    body = resp["Body"]
    try:
        return body.read()
    finally:
        try:
            body.close()
        except Exception:  # noqa: BLE001
            pass


async def _baixar_blob(key: Any) -> tuple[bool, bytes | str]:
    """Baixa uma key do storage. Retorna ``(True, bytes)`` ou ``(False, msg_erro)``.

    Equivalente a um elemento de ``Promise.allSettled(getR2ObjectBuffer(key))``:
    ``fulfilled`` → ``(True, bytes)``; ``rejected`` → ``(False, "<motivo>")``.
    Key nula/ausente é tratada como falha (a entrada vira ``[ERRO]``), igual ao
    Next (``getR2ObjectBuffer(null)`` rejeitaria no SDK).
    """
    if not key or not isinstance(key, str):
        return False, "?"
    try:
        data = await run_in_threadpool(_get_object_bytes, key)
        return True, data
    except Exception as exc:  # noqa: BLE001 — falha individual NÃO derruba o ZIP
        return False, str(exc) or "?"


# ── Colisão de caminho no ZIP (decisão do detalhador — §11.3) ─────────────────
def _resolver_colisao(usados: set[str], caminho: str) -> str:
    """2º caminho idêntico ganha sufixo " (2)", " (3)"… ANTES da extensão, na
    ordem estável da query — sem isso o JSZip/zipfile sobrescreveria em
    silêncio. ``usados`` é mutado (registra o caminho devolvido)."""
    if caminho not in usados:
        usados.add(caminho)
        return caminho
    pasta, _, arquivo = caminho.rpartition("/")
    ponto = arquivo.rfind(".")
    base, ext = (arquivo, "") if ponto <= 0 else (arquivo[:ponto], arquivo[ponto:])
    n = 2
    while True:
        candidato = f"{pasta}/{base} ({n}){ext}" if pasta else f"{base} ({n}){ext}"
        if candidato not in usados:
            usados.add(candidato)
            return candidato
        n += 1


def _js_to_fixed_0(valor: float) -> str:
    """``(x).toFixed(0)`` do JS para os MB das mensagens de teto (§11.4)."""
    return str(int(js_round(valor)))


async def _espelhar_restritos(
    db, docs, *, user: CurrentUser, via: str
) -> None:
    """Espelho 0035 (P7): uma linha por documento RESTRITO incluído no ZIP,
    gravada ANTES de montar o buffer. Best-effort com log — falha não derruba o
    download (política §1.4 da arquitetura)."""
    restritos = [d for d in docs if d["restrito"]]
    if not restritos:
        return
    try:
        for d in restritos:
            await registrar_download_restrito(
                db,
                documento_id=d["id"],
                titulo=d["titulo"],
                operacao_codigo=d["operacao_codigo"],
                user_id=user.id,
                user_email=user.email,
                role=user.role,
                via=via,
            )
        await db.commit()
    except Exception:  # noqa: BLE001 — espelho é best-effort
        import logging

        try:
            await db.rollback()
        except Exception:  # noqa: BLE001
            pass
        logging.getLogger("petro.audit").warning(
            "falha ao gravar audit_download_restrito em lote (via=%s)", via
        )


# ══════════════════════════════════════════════════════════════════════════════
# POST /api/conformidade/cofre/documentos/bulk-download — ZIP em lote / dossiê
# ══════════════════════════════════════════════════════════════════════════════
@router.post("/api/conformidade/cofre/documentos/bulk-download")
async def bulk_download(request: Request):
    # ── (1) guard: requireVisualizar → handleApiError ─────────────────────────
    try:
        user = await _require_visualizar(request)
    except Exception as e:  # noqa: BLE001
        return _handle_api_error(e)

    # ── (2) 400: JSON inválido (body não-parseável). ──────────────────────────
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse(content={"error": "JSON inválido"}, status_code=400)

    ids = body.get("ids") if isinstance(body, dict) else None
    operacao_id = body.get("operacaoId") if isinstance(body, dict) else None
    tem_secao = isinstance(body, dict) and "secao" in body
    secao_raw = body.get("secao") if isinstance(body, dict) else None
    # 0044 (C6) — ``arvore`` é campo do BODY, ao lado de ``secao``: esta rota não
    # lê query string em ponto nenhum (nem aqui, nem no Next), e um ``?arvore=``
    # seria ignorado em silêncio nos dois lados (spec ONDA-5 §1a).
    # ``in body`` e não ``.get() is not None``: ``{"arvore": null}`` é PRESENTE
    # para o Next (``!== undefined``) e tem de dar 422, não virar o default.
    tem_arvore = isinstance(body, dict) and "arvore" in body
    arvore_raw = body.get("arvore") if isinstance(body, dict) else None

    # ── (3) 422: nem ids nem operacaoId presentes. ────────────────────────────
    if ids is None and operacao_id is None:
        return JSONResponse(
            content={"error": "Informe ids ou operacaoId"}, status_code=422
        )

    # (4b-bis / 0044 C6) ``arvore`` só aceita dois valores, e a validação do
    # VALOR vem ANTES de escolher a forma: ``arvore: "xpto"`` é erro de formato
    # nas DUAS e o 422 tem de dizer isso (é só depois que a forma por ids recusa
    # o campo inteiro). Ausente → "secao", e NADA muda em byte nenhum da resposta
    # de hoje. ``arvore`` COMBINA com ``secao``: o filtro decide O QUE entra, a
    # árvore decide COMO as pastas são montadas — ``{operacaoId, secao: 3,
    # arvore: "disciplina"}`` é pedido válido.
    arvore = "secao"
    if tem_arvore:
        if arvore_raw != "secao" and arvore_raw != "disciplina":
            return JSONResponse(
                content={"error": "arvore deve ser secao ou disciplina"},
                status_code=422,
            )
        arvore = arvore_raw

    eh_conf = is_conformidade(user.role)

    if operacao_id is None:
        # ════════════════ FORMA IDS PURA (inalterada + predicado restrito) ════
        # 0044 (C6): ``arvore`` sem ``operacaoId`` é 422, NUNCA ignorado em
        # silêncio — o usuário pediu uma árvore que esta forma não sabe montar
        # (a forma por ids agrupa por CATEGORIA), e entregar outra coisa calado é
        # pior que recusar. Vem ANTES da validação de ids, como no Next.
        if tem_arvore:
            return JSONResponse(
                content={
                    "error": "arvore só se aplica ao dossiê da operação (informe operacaoId)"
                },
                status_code=422,
            )

        # (4a) 422: ids não-array / vazio / item não-string.
        if (
            not isinstance(ids, list)
            or len(ids) == 0
            or any(not isinstance(i, str) for i in ids)
        ):
            return JSONResponse(
                content={"error": "Esperado { ids: string[] } com pelo menos 1 id"},
                status_code=422,
            )

        # (5a) 422: ids > 100.
        if len(ids) > LIMITE:
            return JSONResponse(
                content={"error": f"Máximo de {LIMITE} documentos por download"},
                status_code=422,
            )

        # ── Sessão de banco (sem Depends — o handler abre/fecha explícito). ──
        async with SessionLocal() as db:
            # (5) SELECT documentos (inArray ids).
            #
            # PARIDADE BUG-A-BUG com o Next: ``documentosHabilitacao.id`` é uma
            # coluna ``uuid`` e o Next chama ``inArray(documentosHabilitacao.id,
            # ids)`` — id NÃO-UUID lança erro de cast que propaga sem captura →
            # 500 nos dois lados (por isso o CAST p/ uuid[] SEM ``id::text``).
            #
            # 0034/S4: predicado restrito no WHERE — ids restritos são
            # silenciosamente excluídos ANTES dos tetos para papéis fora de
            # Conformidade (nem o INDICE os menciona). ``titulo``/``restrito``/
            # ``o.codigo`` entram para o espelho 0035 (ZIP_SELECAO).
            doc_rows = (await db.execute(
                text(
                    f"""
                    SELECT
                      d.id::text       AS id,
                      d.titulo         AS titulo,
                      d.categoria      AS categoria,
                      d.subcategoria   AS subcategoria,
                      d.nome_arquivo   AS nome_arquivo,
                      d.blob_key       AS blob_key,
                      d.tamanho_bytes  AS tamanho_bytes,
                      d.restrito       AS restrito,
                      o.codigo         AS operacao_codigo
                    FROM documentos_habilitacao d
                    LEFT JOIN operacoes o ON o.id = d.operacao_id
                    WHERE d.id = ANY(CAST(:ids AS uuid[]))
                      AND {restricao_visivel_sql("d")}
                    """
                ),
                {"ids": list(ids), "is_conformidade": eh_conf},
            )).mappings().all()

            # 404: nenhum documento encontrado (inclui "só havia restritos").
            if len(doc_rows) == 0:
                return JSONResponse(
                    content={"error": "Nenhum documento encontrado"}, status_code=404
                )

            doc_ids = [r["id"] for r in doc_rows]

            # (6) SELECT anexos (inArray documento_id ∈ docs).
            anexo_rows = (await db.execute(
                text(
                    """
                    SELECT
                      id::text          AS id,
                      documento_id::text AS documento_id,
                      titulo            AS titulo,
                      nome_arquivo      AS nome_arquivo,
                      blob_key          AS blob_key,
                      tamanho_bytes     AS tamanho_bytes
                    FROM documentos_habilitacao_anexos
                    WHERE documento_id = ANY(CAST(:doc_ids AS uuid[]))
                    """
                ),
                {"doc_ids": doc_ids},
            )).mappings().all()

            # (7) 422: pacote muito grande (docs + anexos > LIMITE_BYTES) —
            # strings ATUAIS, SEM ``code`` (retrocompat da forma ids).
            total_bytes = (
                sum((r["tamanho_bytes"] or 0) for r in doc_rows)
                + sum((r["tamanho_bytes"] or 0) for r in anexo_rows)
            )
            if total_bytes > LIMITE_BYTES:
                return JSONResponse(
                    content={
                        "error": (
                            f"Pacote muito grande ({total_bytes / 1048576:.0f} MB). "
                            f"Máximo de {LIMITE_BYTES / 1048576:.0f} MB por download — "
                            "selecione menos documentos."
                        )
                    },
                    status_code=422,
                )

            # Espelho 0035 (só Conformidade enxerga restrito aqui) — ANTES do
            # buffer (§11.5).
            await _espelhar_restritos(db, doc_rows, user=user, via="ZIP_SELECAO")

        # ── Monta o ZIP (em memória) + INDICE.txt — réplica do JSZip do Next. ─
        # toLocaleString("pt-BR"): dd/mm/aaaa hh:mm:ss (hora local do servidor).
        agora_local = datetime.now()
        indice: list[str] = [
            "Pacote de documentos — Petro Radar (Cofre de Habilitação)",
            f"Gerado em: {_to_pt_br_locale(agora_local)}",
            f"Documentos: {len(doc_rows)}  |  Anexos extras: {len(anexo_rows)}",
            "─────────────────────────────────────────────",
            "",
        ]

        incluidos = 0
        pulados = 0
        # (filename_no_zip, bytes) — lista gravada no zipfile no fim.
        arquivos: list[tuple[str, bytes]] = []

        # Download principal (falha individual não derruba o ZIP).
        for d in doc_rows:
            pasta = _sanitize(d["categoria"])
            titulo_san = _sanitize(d["titulo"])
            arq_san = _sanitize(d["nome_arquivo"])
            ok, payload = await _baixar_blob(d["blob_key"])
            nome_zip = f"{pasta}/{titulo_san}__{arq_san}"
            if ok:
                arquivos.append((nome_zip, payload))  # type: ignore[arg-type]
                indice.append(f"[OK]    {nome_zip}  ({d['subcategoria']})")
                incluidos += 1
            else:
                indice.append(
                    f"[ERRO]  {titulo_san} — falha ao baixar do storage ({payload})"
                )
                pulados += 1

        # Anexos.
        if len(anexo_rows) > 0:
            indice.append("")
            indice.append("Anexos extras:")
            doc_por_id = {d["id"]: d for d in doc_rows}
            for a in anexo_rows:
                doc = doc_por_id.get(a["documento_id"])
                if doc is None:
                    continue
                pasta = _sanitize(doc["categoria"])
                titulo_san = _sanitize(doc["titulo"])
                arq_san = _sanitize(a["titulo"] or a["nome_arquivo"])
                ok, payload = await _baixar_blob(a["blob_key"])
                nome_zip = f"{pasta}/{titulo_san}/anexos/{arq_san}"
                if ok:
                    arquivos.append((nome_zip, payload))  # type: ignore[arg-type]
                    indice.append(f"  [OK]   {nome_zip}")
                    incluidos += 1
                else:
                    indice.append(
                        f"  [ERRO] {titulo_san}/anexos/{arq_san} — falha ao baixar"
                    )
                    pulados += 1

        indice.append("")
        indice.append(f"Total incluído: {incluidos}  |  Falhas: {pulados}")

        # Gera o ZIP (DEFLATE nível 6, igual ao compressionOptions do Next).
        buf = io.BytesIO()
        with zipfile.ZipFile(
            buf, mode="w", compression=zipfile.ZIP_DEFLATED, compresslevel=6
        ) as zf:
            for nome_zip, dados in arquivos:
                zf.writestr(nome_zip, dados)
            zf.writestr("INDICE.txt", "\n".join(indice))
        zip_bytes = buf.getvalue()

        # Resposta 200 application/zip — MESMOS headers do Next.
        stamp = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")
        filename = f"cofre_{stamp}_{len(doc_rows)}docs.zip"

        return Response(
            content=zip_bytes,
            status_code=200,
            headers={
                "Content-Type": "application/zip",
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Content-Length": str(len(zip_bytes)),
                "Cache-Control": "private, no-store",
            },
        )

    # ════════════════════ FORMA NOVA (operacaoId — dossiê/seção/recorte) ══════
    # (4b) secao presente e (não-inteiro ou fora de 1..9) → 422. ``true`` NÃO é
    # inteiro (Number.isInteger(true) === false); 3.0 É (3.0 === 3 no JS).
    secao: int | None = None
    if tem_secao:
        v = secao_raw
        eh_int = (
            not isinstance(v, bool)
            and isinstance(v, (int, float))
            and float(v).is_integer()
        )
        if not eh_int or not (1 <= int(v) <= 9):
            return JSONResponse(
                content={"error": "secao deve ser um inteiro de 1 a 9"},
                status_code=422,
            )
        secao = int(v)

    # (4c) ids presente e inválido → MESMAS strings de 4a/5a (recorte 1..100).
    recorte: list[str] | None = None
    if ids is not None:
        if (
            not isinstance(ids, list)
            or len(ids) == 0
            or any(not isinstance(i, str) for i in ids)
        ):
            return JSONResponse(
                content={"error": "Esperado { ids: string[] } com pelo menos 1 id"},
                status_code=422,
            )
        if len(ids) > LIMITE:
            return JSONResponse(
                content={"error": f"Máximo de {LIMITE} documentos por download"},
                status_code=422,
            )
        recorte = list(ids)

    # (5b) operacaoId não-UUID ou inexistente → 404 (ehUuid antes do banco).
    if not isinstance(operacao_id, str) or not _UUID_ZOD_REGEX.match(operacao_id):
        return JSONResponse(
            content={"error": "Operação não encontrada"}, status_code=404
        )

    async with SessionLocal() as db:
        op = (await db.execute(
            text(
                "SELECT id::text AS id, codigo, cliente_nome "
                "FROM operacoes WHERE id = CAST(:id AS uuid) LIMIT 1"
            ),
            {"id": operacao_id},
        )).mappings().first()
        if op is None:
            return JSONResponse(
                content={"error": "Operação não encontrada"}, status_code=404
            )

        # (6b) documentos da operação, com predicado restrito, ordem ESTÁVEL.
        doc_rows = (await db.execute(
            text(
                f"""
                SELECT d.id::text AS id, d.titulo, d.nome_arquivo, d.blob_key,
                       d.tamanho_bytes, d.tipo_documento, d.papel, d.restrito,
                       o.codigo AS operacao_codigo, o.cliente_nome,
                       -- 0044 (C6): a disciplina que ESTE documento prova (0043).
                       -- LEFT, nunca INNER: documento sem disciplina é a maioria
                       -- hoje, e um INNER faria o ZIP sair SEM ele — o pior erro
                       -- possível num download de dossiê. A pasta
                       -- ``0_Sem_disciplina`` existe justamente para eles.
                       d.disciplina_id,
                       disc.codigo AS disciplina_codigo,
                       disc.nome   AS disciplina_nome
                FROM documentos_habilitacao d
                JOIN operacoes o ON o.id = d.operacao_id
                LEFT JOIN disciplinas disc ON disc.id = d.disciplina_id
                WHERE d.operacao_id = CAST(:operacao_id AS uuid)
                  AND {restricao_visivel_sql("d")}
                ORDER BY d.criado_em ASC, d.id ASC
                """
            ),
            {"operacao_id": operacao_id, "is_conformidade": eh_conf},
        )).mappings().all()

        # Filtro de seção EM MEMÓRIA (a seção é DERIVADA, não coluna — ADR-02).
        docs = [
            d for d in doc_rows
            if secao is None
            or secao_do_documento(d["tipo_documento"], d["papel"]) == secao
        ]

        # RECORTE: interseção com ids, preservando a ordem estável da query;
        # ids fora da operação/seção são ignorados em silêncio (§11.2).
        if recorte is not None:
            recorte_set = {i.lower() for i in recorte}
            docs = [d for d in docs if d["id"] in recorte_set]

        # (7b) zero documentos visíveis.
        if len(docs) == 0:
            return JSONResponse(
                content={"error": "Nenhum documento encontrado"}, status_code=404
            )

        # (8b) tetos APÓS filtro de seção/restrito/recorte — mensagens NUNCA
        # circulares (§11.4): sem ``secao`` manda baixar por seção; com
        # ``secao`` manda fatiar pela ficha.
        if len(docs) > LIMITE:
            # 0044 (C6): a variante existe porque quem clicou em "Baixar por
            # disciplina" e recebe "Baixe por seção." precisa saber POR QUE a
            # saída está no outro eixo — sem a frase entre parênteses a mensagem
            # parece ignorar o que ele pediu. Só o dossiê INTEIRO ganha variante:
            # com ``secao`` a instrução já é outra.
            if secao is not None:
                msg = (
                    f"A seção {secao} tem {len(docs)} documentos — o ZIP aceita "
                    f"{LIMITE}. Baixe em partes pela ficha."
                )
            elif arvore == "disciplina":
                msg = (
                    f"A operação tem {len(docs)} documentos — o ZIP aceita "
                    f"{LIMITE}. Baixe por seção (o ZIP por disciplina é sempre "
                    "do dossiê inteiro)."
                )
            else:
                msg = (
                    f"A operação tem {len(docs)} documentos — o ZIP aceita "
                    f"{LIMITE}. Baixe por seção."
                )
            return JSONResponse(
                content={"error": msg, "code": "LIMITE_DOCUMENTOS"}, status_code=422
            )

        total_bytes = sum((d["tamanho_bytes"] or 0) for d in docs)
        if total_bytes > LIMITE_BYTES:
            mb = _js_to_fixed_0(total_bytes / 1048576)
            # Mesma variante do teto de contagem, no sufixo (spec ONDA-5 §5.3).
            if secao is not None:
                sufixo = "Baixe em partes pela ficha."
            elif arvore == "disciplina":
                sufixo = "Baixe por seção (o ZIP por disciplina é sempre do dossiê inteiro)."
            else:
                sufixo = "Baixe por seção."
            return JSONResponse(
                content={
                    "error": (
                        f"Pacote de {mb} MB — o máximo é "
                        f"{LIMITE_BYTES // 1048576} MB por download. {sufixo}"
                    ),
                    "code": "LIMITE_BYTES",
                },
                status_code=422,
            )

        # Espelho 0035 (ZIP_DOSSIE) — ANTES de montar o buffer (§11.5).
        await _espelhar_restritos(db, docs, user=user, via="ZIP_DOSSIE")

    # ── Árvore do dossiê + INDICE.txt (template §11.3) ────────────────────────
    raiz = _sanitize(f"{op['codigo']} - {op['cliente_nome']}")
    agora_local = datetime.now()
    indice = [
        f"Dossiê da operação {op['codigo']} - {op['cliente_nome']} — Petro Radar",
        f"Gerado em: {_to_pt_br_locale(agora_local)}",
        f"Documentos: {len(docs)}",
        "─────────────────────────────────────────────",
    ]

    incluidos = 0
    pulados = 0
    arquivos = []
    usados: set[str] = set()

    for d in docs:
        # 0044 (C6): a árvore por disciplina desvia SÓ o cálculo do slug —
        # ``SECOES_FICHA`` continua sendo a fonte da árvore padrão, e a árvore
        # por disciplina NÃO é uma seção nova. O "0_" na frente põe a pasta em
        # PRIMEIRO na listagem de qualquer descompactador: o que falta
        # classificar aparece antes do que já está, em vez de se esconder no fim
        # do alfabeto.
        if arvore == "disciplina":
            slug = (
                _sanitize(f"{d['disciplina_codigo']}_{d['disciplina_nome']}")
                if d["disciplina_codigo"]
                else "0_Sem_disciplina"
            )
        else:
            slug = SECOES_FICHA[secao_do_documento(d["tipo_documento"], d["papel"])]["slug"]
        titulo_san = _sanitize(d["titulo"])
        arq_san = _sanitize(d["nome_arquivo"])
        # Caminho relativo à seção (o INDICE lista sem a pasta raiz).
        rel = _resolver_colisao(usados, f"{slug}/{titulo_san}__{arq_san}")
        ok, payload = await _baixar_blob(d["blob_key"])
        if ok:
            arquivos.append((f"{raiz}/{rel}", payload))  # type: ignore[arg-type]
            indice.append(f"[OK]    {rel}")
            incluidos += 1
        else:
            indice.append(
                f"[ERRO]  {titulo_san} — falha ao baixar do storage ({payload})"
            )
            pulados += 1

    indice.append("")
    indice.append(f"Total incluído: {incluidos}  |  Falhas: {pulados}")

    buf = io.BytesIO()
    with zipfile.ZipFile(
        buf, mode="w", compression=zipfile.ZIP_DEFLATED, compresslevel=6
    ) as zf:
        for nome_zip, dados in arquivos:
            zf.writestr(nome_zip, dados)
        zf.writestr(f"{raiz}/INDICE.txt", "\n".join(indice))
    zip_bytes = buf.getvalue()

    # Nome do dossiê: ``dossie_<codigo>[_secao<N>]_<yyyy-mm-dd>.zip`` (código
    # sanitizado). Com RECORTE o nome é o MESMO da forma por seção — o servidor
    # não sabe qual parte é; o front renomeia localmente (03-FRONTEND §5.6).
    stamp = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")
    codigo_san = _sanitize(op["codigo"])
    # 0044 (C6): os QUATRO nomes possíveis, montados pela mesma regra do Next (e
    # reproduzidos pela ficha no nome local das partes):
    #   dossie_12345_2026-01-01.zip · dossie_12345_secao3_2026-01-01.zip
    #   dossie_12345_disciplina_2026-01-01.zip
    #   dossie_12345_secao3_disciplina_2026-01-01.zip
    parte_secao = "" if secao is None else f"_secao{secao}"
    parte_arvore = "_disciplina" if arvore == "disciplina" else ""
    filename = f"dossie_{codigo_san}{parte_secao}{parte_arvore}_{stamp}.zip"

    return Response(
        content=zip_bytes,
        status_code=200,
        headers={
            "Content-Type": "application/zip",
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(len(zip_bytes)),
            "Cache-Control": "private, no-store",
        },
    )


# ── Helper: data/hora no formato pt-BR (toLocaleString("pt-BR")). ─────────────
def _to_pt_br_locale(dt: datetime) -> str:
    """Réplica de ``new Date().toLocaleString("pt-BR")``: ``dd/mm/aaaa hh:mm:ss``.

    O valor entra apenas no INDICE.txt (informativo). Usa a hora LOCAL do
    servidor (como ``toLocaleString`` sem timezone explícito faria no runtime).
    """
    return (
        f"{dt.day:02d}/{dt.month:02d}/{dt.year:04d} "
        f"{dt.hour:02d}:{dt.minute:02d}:{dt.second:02d}"
    )
