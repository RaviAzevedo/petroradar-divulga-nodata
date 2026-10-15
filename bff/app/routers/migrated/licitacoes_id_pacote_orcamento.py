"""Rota migrada (strangler-fig): GET /api/licitacoes/{id}/pacote-orcamento.

Equivalente do handler GET de
``src/app/api/licitacoes/[id]/pacote-orcamento/route.ts``.

⚠ NATUREZA DA RESPOSTA / PARIDADE
─────────────────────────────────
O handler Next NÃO devolve JSON: ele monta um ZIP binário
(``application/zip``, ``Content-Disposition: attachment``) via
``montarPacoteOrcamento`` (JSZip + exceljs + download R2 paralelo). Um corpo
ZIP é, por definição, incomparável por ``JSON.parse``. A única superfície
realmente paritável (e a parte de "leitura" que o estrangulador deve migrar) é
o lado-LEITURA da rota: o guard de auth, o 404 quando a licitação não existe e
as QUATRO leituras de banco (``licitacoes``, ``analises_ia``, ``anexos`` e
``circulares`` ADENDO) — com os MESMOS aliases camelCase que o Drizzle produz.

Esta rota replica fielmente esse lado-leitura e expõe os dados lidos como JSON
(mesmos campos/aliases que o Next lê antes de empacotar). NENHUM campo é
inventado: cada chave abaixo corresponde 1:1 a uma projeção do código Next.

Guard Next:
    ``requirePropor()`` → ``podeProporParticipacao(role)`` →
    role ∈ {ADMIN, LIDER, ORCAMENTISTA, TECNICO}, senão 403
    ``{ "error": "Sem permissão de propor", "code": "FORBIDDEN" }``;
    401 ``{ "error": "Não autenticado", "code": "UNAUTHENTICATED" }`` sem sessão.
Equivalente no BFF: :data:`app.core.security.require_propor`
(ADMIN, LIDER, ORCAMENTISTA, TECNICO). O 401 vem de ``get_current_user``.

Query params: o Next NÃO lê nenhum query param (nem ?meses=, ?page=, ?q=,
?status=). Nada a ler aqui — não há defaults/clamps a replicar.

Leituras replicadas (mesma ordem/filtros/limites do Drizzle):
    1. ``SELECT * FROM licitacoes WHERE id = :id LIMIT 1`` (espelha
       ``db.select().from(licitacoes).where(eq(id)).limit(1)``).
       Se vazio → 404 ``{ "error": "Licitação não encontrada" }`` (mesmo shape).
    2. ``SELECT * FROM analises_ia WHERE licitacao_id = :id LIMIT 1`` (espelha
       ``db.select().from(analisesIa).where(eq(licitacaoId, id)).limit(1)``).
    3. Anexos do edital — projeção ``{ descricao, s3Key, contentType,
       tamanhoBytes }`` de ``anexos WHERE licitacao_id = :id`` (sem ORDER/LIMIT).
    4. Adendos — projeção ``{ anexoDescricao, anexoPhioObjid }`` de
       ``circulares WHERE licitacao_id = :id AND tipo = 'ADENDO'``.

O JSON devolvido reflete a montagem do Next:
    - ``anexosPacote``: lista combinada EDITAL + ADENDO, na MESMA ordem em que o
      Next a constrói (primeiro os anexos do edital, depois os adendos), com o
      filtro ``c.anexoPhioObjid || c.anexoDescricao`` e o fallback
      ``descricao = anexoDescricao ?? anexoPhioObjid`` para adendos (s3Key/
      contentType/tamanhoBytes = null, origem = "ADENDO").
    - ``analiseRow``: o subconjunto de campos que o Next monta a partir de
      ``analise`` (ou ``null`` se não houver análise) — MESMOS nomes camelCase.
    - ``meta``: ``{ numero, objeto, empresa, segmento }`` (o que o Next passa
      para ``montarPacoteOrcamento``).

Colunas (snake_case no banco → camelCase no Drizzle/alias):
    anexos.descricao        → "descricao"
    anexos.s3_key           → "s3Key"
    anexos.content_type     → "contentType"
    anexos.tamanho_bytes    → "tamanhoBytes"
    circulares.anexo_descricao   → "anexoDescricao"
    circulares.anexo_phio_objid  → "anexoPhioObjid"
    analises_ia.objeto_detalhado → "objetoDetalhado"
    analises_ia.criterios_habilitacao → "criteriosHabilitacao"
    analises_ia.criterios_julgamento  → "criteriosJulgamento"
    analises_ia.valor_estimado   → "valorEstimado"
    analises_ia.modelo_usado     → "modeloUsado"
    analises_ia.erro_parse       → "erroParse"
    analises_ia.schema_versao    → "schemaVersao"
    analises_ia.prob_vitoria     → "probVitoria"
    analises_ia.analisado_em     → "analisadoEm" (timestamp → isoformat)
    licitacoes.numero/objeto/empresa/segmento → meta.*
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import CurrentUser, require_propor
from app.db.session import get_db

router = APIRouter()


def _serializar(valor: Any) -> Any:
    """Serializa um valor para JSON paritário com o Next.

    - datetime → ISO 8601 (``datetime.isoformat()``), igual ao ``Date`` do Next.
    - uuid → ``str()``; numeric → número nativo; jsonb → dict/list nativo.
    - None/bool/int/float/str → valor nativo.
    """
    if valor is None:
        return None
    if isinstance(valor, datetime):
        return valor.isoformat()
    if isinstance(valor, UUID):
        return str(valor)
    if isinstance(valor, (dict, list, int, float, bool, str)):
        return valor
    return str(valor)


@router.get("/api/licitacoes/{id}/pacote-orcamento")
async def pacote_orcamento(
    id: str,
    request: Request,
    user: CurrentUser = Depends(require_propor),
    db=Depends(get_db),
) -> JSONResponse:
    """GET /api/licitacoes/{id}/pacote-orcamento (lado-leitura paritável).

    Réplica fiel das QUATRO leituras de banco do handler Next + guard
    ``require_propor`` + 404 quando a licitação não existe. O corpo JSON expõe
    exatamente os dados que o Next lê antes de empacotar no ZIP.
    """
    # ── 1) Licitação (SELECT * ... LIMIT 1) — 404 se não existir. ─────────────
    res_lic = await db.execute(
        text("SELECT * FROM licitacoes WHERE id = :id LIMIT 1"),
        {"id": id},
    )
    lic = res_lic.mappings().first()
    if lic is None:
        # Mesmo shape do Next: NextResponse.json({ error: ... }, { status: 404 }).
        return JSONResponse(
            content={"error": "Licitação não encontrada"}, status_code=404
        )

    # ── 2) Análise IA (SELECT * WHERE licitacao_id = :id LIMIT 1). ────────────
    res_analise = await db.execute(
        text("SELECT * FROM analises_ia WHERE licitacao_id = :id LIMIT 1"),
        {"id": id},
    )
    analise = res_analise.mappings().first()

    # ── 3) Anexos do edital — projeção {descricao, s3Key, contentType, ────────
    #       tamanhoBytes} (sem ORDER/LIMIT, igual ao Drizzle).
    res_anexos = await db.execute(
        text(
            """
            SELECT
                descricao      AS "descricao",
                s3_key         AS "s3Key",
                content_type   AS "contentType",
                tamanho_bytes  AS "tamanhoBytes"
            FROM anexos
            WHERE licitacao_id = :id
            """
        ),
        {"id": id},
    )
    lic_anexos = res_anexos.mappings().all()

    # ── 4) Adendos — projeção {anexoDescricao, anexoPhioObjid} de circulares ──
    #       WHERE tipo = 'ADENDO'.
    res_adendos = await db.execute(
        text(
            """
            SELECT
                anexo_descricao   AS "anexoDescricao",
                anexo_phio_objid  AS "anexoPhioObjid"
            FROM circulares
            WHERE licitacao_id = :id AND tipo = 'ADENDO'
            """
        ),
        {"id": id},
    )
    adendos = res_adendos.mappings().all()

    # ── Montagem de anexosPacote (espelha o spread do Next, NA MESMA ORDEM). ──
    anexos_pacote: list[dict[str, Any]] = []
    for a in lic_anexos:
        anexos_pacote.append(
            {
                "descricao": _serializar(a["descricao"]),
                "s3Key": _serializar(a["s3Key"]),
                "contentType": _serializar(a["contentType"]),
                "tamanhoBytes": _serializar(a["tamanhoBytes"]),
                "origem": "EDITAL",
            }
        )
    for c in adendos:
        # Filtro do Next: .filter((c) => c.anexoPhioObjid || c.anexoDescricao).
        if not (c["anexoPhioObjid"] or c["anexoDescricao"]):
            continue
        anexos_pacote.append(
            {
                # descricao: anexoDescricao ?? anexoPhioObjid.
                "descricao": _serializar(
                    c["anexoDescricao"]
                    if c["anexoDescricao"] is not None
                    else c["anexoPhioObjid"]
                ),
                "s3Key": None,
                "contentType": None,
                "tamanhoBytes": None,
                "origem": "ADENDO",
            }
        )

    # ── analiseRow: subconjunto que o Next monta (ou null). MESMOS aliases. ───
    if analise is not None:
        analise_row: dict[str, Any] | None = {
            "resumo": _serializar(analise["resumo"]),
            "objetoDetalhado": _serializar(analise["objeto_detalhado"]),
            "checklist": _serializar(analise["checklist"]),
            "requisitos": _serializar(analise["requisitos"]),
            "criteriosHabilitacao": _serializar(analise["criterios_habilitacao"]),
            "criteriosJulgamento": _serializar(analise["criterios_julgamento"]),
            "valorEstimado": _serializar(analise["valor_estimado"]),
            "prazos": _serializar(analise["prazos"]),
            "riscos": _serializar(analise["riscos"]),
            "recomendacao": _serializar(analise["recomendacao"]),
            "modeloUsado": _serializar(analise["modelo_usado"]),
            "erroParse": _serializar(analise["erro_parse"]),
            "schemaVersao": _serializar(analise["schema_versao"]),
            "probVitoria": _serializar(analise["prob_vitoria"]),
            "analisadoEm": _serializar(analise["analisado_em"]),
        }
    else:
        analise_row = None

    # ── meta: o que o Next passa para montarPacoteOrcamento. ──────────────────
    meta = {
        "numero": _serializar(lic["numero"]),
        "objeto": _serializar(lic["objeto"]),
        "empresa": _serializar(lic["empresa"]),
        "segmento": _serializar(lic["segmento"]),
    }

    return JSONResponse(
        content={
            "meta": meta,
            "analise": analise_row,
            "anexos": anexos_pacote,
        }
    )
