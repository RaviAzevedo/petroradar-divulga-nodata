"""GET /api/conformidade/familias/dossie/{codigo} — o dossiê de UMA família.

ESPELHO de app/src/app/api/conformidade/familias/dossie/[codigo]/route.ts e de
app/src/lib/conformidade/familias/dossie.ts.

⚠️ ESTE É O LADO QUE ATENDE PRODUÇÃO. O NGINX manda todo ``/api/`` para o BFF e
este path não está entre as exceções — sem este arquivo a rota do Next nunca é
alcançada e a tela recebe 404.

POR QUE ELA EXISTE
──────────────────
A rota irmã (``conf_familias_id``) é chaveada pelo uuid do NOSSO cadastro e por
isso só existe para as famílias cadastradas. Esta é chaveada pelo CÓDIGO CRC
e existe para todas as do catálogo — inclusive as em que não estamos, que são
justamente as que exigem decisão de cadastro. No mapa elas eram linha sem link.

RESTRITO (0034/S15): vale a regra do cofre — Conformidade vê a prova restrita,
os demais não. ``restritosOcultos`` diz quantas linhas ficaram de fora, para que
a diferença para o mapa (que conta só não-restrito) nunca seja silenciosa.

Guard: ``require_visualizar`` — mesmo do GET de famílias no Next.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import CurrentUser, is_conformidade, require_visualizar
from app.db.session import get_db
from app.routers.migrated._pii import redigir_pii

router = APIRouter()

# Ordem de força do veredito — a mesma do mapa, explícita e não alfabética.
_ORDEM_VEREDITO = (
    "CASE fc.veredito WHEN 'PROVA' THEN 1 WHEN 'PARCIAL' THEN 2 "
    "WHEN 'ABSTEM' THEN 3 ELSE 4 END"
)


def _js(v: Any) -> Any:
    """Serializa como o NextResponse.json(): Date → ISO-8601 com Z."""
    if isinstance(v, datetime):
        return v.isoformat().replace("+00:00", "Z")
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    return v


def _txt(v: Any) -> str | None:
    return None if v is None else str(v)


def estado_prova(vinculados: int, indicios: int, avaliada: bool) -> str:
    """Espelho de estadoProva() — mesma ordem: vínculo > indício > ausência, e
    ausência só vira "não" quando a família FOI avaliada."""
    if vinculados > 0:
        return "COM_PROVA"
    if indicios > 0:
        return "COM_INDICIO"
    return "SEM_INDICIO" if avaliada else "INDETERMINADO"


def quadrante_de(cadastrada: bool, prova: str) -> str:
    """Espelho de quadranteDe()."""
    if prova == "INDETERMINADO":
        return "A_APURAR"
    sustenta = prova in ("COM_PROVA", "COM_INDICIO")
    if cadastrada:
        return "NUCLEO" if sustenta else "RISCO"
    return "OPORTUNIDADE" if sustenta else "FORA_DE_ALCANCE"


def indicio_negativo(veredito: str, revisao: str | None) -> bool:
    """Espelho de indicioNegativo() em dossie.ts.

    Duas fontes de negativa: veredito NAO (a máquina leu e descartou) e revisão
    REJEITADA (uma pessoa disse que não vale — e pesa mais que o veredito, senão
    a decisão humana não teria efeito na tela).

    ABSTEM NÃO é negativo: é candidato ainda sem julgamento. Tratá-lo como "não
    sustenta" transformaria todas as pendências em negativas.
    """
    return veredito == "NAO" or revisao == "REJEITADA"


def _mapear_indicio(r: Any) -> dict:
    """Espelho de mapearIndicio(): a justificativa sai redigida.

    Ela é trecho de OCR de atestado e pode carregar CPF do responsável técnico.
    Redigir na LEITURA e não na gravação — o texto original continua auditável
    no banco (mesma escolha do caminho de busca do acervo).
    """
    return {
        "id": str(r.id),
        "documentoId": str(r.documentoId),
        "titulo": r.titulo or "",
        "categoria": r.categoria or "",
        "subcategoria": r.subcategoria or "",
        "restrito": bool(r.restrito),
        "veredito": str(r.veredito),
        "confianca": None if r.confianca is None else float(r.confianca),
        "justificativa": redigir_pii(_txt(r.justificativa)),
        "procedencia": r.procedencia or "",
        "modelo": _txt(r.modelo),
        "revisao": _txt(r.revisao),
        "revisadoEm": _js(r.revisadoEm),
        "revisadoPorNome": _txt(r.revisadoPorNome),
        "criadoEm": _js(r.criadoEm),
    }


_SQL_CABECALHO = """
WITH alvo AS (SELECT f_codigo_crc(:codigo) AS cod),
cad AS (
  SELECT f.*, f_codigo_crc(f.codigo_crc) AS chave
    FROM familias f, alvo
   WHERE f.deletado_em IS NULL
     AND f_codigo_crc(f.codigo_crc) = alvo.cod
)
SELECT
  alvo.cod                                  AS "codigo",
  coalesce(cad.nome, c.nome)                AS "nome",
  (c.codigo IS NOT NULL)                    AS "temCatalogo",
  c.nome                                    AS "catalogoNome",
  c.escopo                                  AS "escopo",
  c.grupo                                   AS "grupo",
  c.segmento_petrobras                      AS "segmentoPetrobras",
  coalesce(c.segmento, 'SERVICO')           AS "segmento",
  coalesce(c.oficial, false)                AS "oficial",
  coalesce(c.licitacoes, 0)                 AS "licitacoes",
  coalesce(c.itens, 0)                      AS "itens",
  c.primeira_vez_em                         AS "primeiraVezEm",
  c.ultima_vez_em                           AS "ultimaVezEm",
  cad.id                                    AS "familiaId",
  cad.nome                                  AS "cadastroNome",
  cad.descricao                             AS "descricao",
  cad.status                                AS "status",
  cad.status_fluxo_crc                      AS "statusFluxoCrc",
  cad.validade_fim                          AS "validadeFim",
  coalesce(cad.cadastro_corporativo, false) AS "cadastroCorporativo",
  EXISTS (SELECT 1 FROM familias_classificacao_escopo e
           WHERE e.familia_codigo = alvo.cod)  AS "avaliada",
  EXISTS (SELECT 1 FROM familias_classificacoes fc
           WHERE fc.familia_codigo = alvo.cod) AS "temIndicio"
  FROM alvo
  LEFT JOIN familias_catalogo c ON c.codigo = alvo.cod
  LEFT JOIN cad ON true
 LIMIT 1
"""

_SQL_PROVAS = """
SELECT df.id           AS "vinculoId",
       d.id            AS "documentoId",
       d.titulo        AS "titulo",
       d.categoria     AS "categoria",
       d.subcategoria  AS "subcategoria",
       d.status        AS "status",
       d.validade_fim  AS "validadeFim",
       d.restrito      AS "restrito",
       df.observacao   AS "observacao",
       df.criado_em    AS "vinculadoEm"
  FROM documentos_familias df
  JOIN documentos_habilitacao d ON d.id = df.documento_id
 WHERE df.familia_id = CAST(:familia_id AS uuid)
   AND {restrito}
 ORDER BY d.titulo
"""

_SQL_INDICIOS = """
SELECT fc.id             AS "id",
       fc.documento_id   AS "documentoId",
       d.titulo          AS "titulo",
       d.categoria       AS "categoria",
       d.subcategoria    AS "subcategoria",
       d.restrito        AS "restrito",
       fc.veredito       AS "veredito",
       fc.confianca      AS "confianca",
       fc.justificativa  AS "justificativa",
       fc.procedencia    AS "procedencia",
       fc.modelo         AS "modelo",
       fc.revisao        AS "revisao",
       fc.revisado_em    AS "revisadoEm",
       u.nome            AS "revisadoPorNome",
       fc.criado_em      AS "criadoEm"
  FROM familias_classificacoes fc
  JOIN documentos_habilitacao d ON d.id = fc.documento_id
  LEFT JOIN users u ON u.id = fc.revisado_por
 WHERE fc.familia_codigo = :cod
   AND {restrito}
 ORDER BY {ordem}, fc.confianca DESC NULLS LAST, d.titulo
"""

# As duas fontes da migração 0040, unidas por NÚMERO (não por uuid: contar uuid
# de um lado e número do outro faria a MESMA licitação contar duas vezes).
_SQL_DEMANDA = """
WITH exigencias AS (
  SELECT p.numero AS numero, max(p.captured_at) AS visto_em
    FROM petronect_lic_items p
   WHERE f_codigo_crc(p.family) = :cod
   GROUP BY p.numero
  UNION ALL
  SELECT l.numero, max(i.criado_em)
    FROM itens i
    JOIN licitacoes l ON l.id = i.licitacao_id
   WHERE f_codigo_crc(i.familia) = :cod
   GROUP BY l.numero
)
SELECT e.numero        AS "numero",
       max(e.visto_em) AS "vistoEm",
       max(l.id::text) AS "licitacaoId",
       max(l.objeto)   AS "objeto"
  FROM exigencias e
  LEFT JOIN licitacoes l ON l.numero = e.numero
 GROUP BY e.numero
 ORDER BY max(e.visto_em) DESC NULLS LAST, e.numero DESC
 LIMIT 12
"""

_SQL_OCULTOS = """
SELECT (
  (SELECT count(*) FROM familias_classificacoes fc
     JOIN documentos_habilitacao d ON d.id = fc.documento_id
    WHERE fc.familia_codigo = :cod AND d.restrito = true)
  + coalesce((SELECT count(*) FROM documentos_familias df
     JOIN documentos_habilitacao d ON d.id = df.documento_id
    WHERE {alvo_familia} AND d.restrito = true), 0)
)::int AS n
"""


@router.get("/api/conformidade/familias/dossie/{codigo}")
async def dossie_familia(
    codigo: str,
    user: CurrentUser = Depends(require_visualizar),
    db=Depends(get_db),
) -> JSONResponse:
    # Teto de tamanho antes de tocar o banco: f_codigo_crc() é barata, mas não há
    # razão para aceitar um path de 4 KB.
    codigo = (codigo or "").strip()
    if not codigo or len(codigo) > 40:
        return JSONResponse({"error": "Família não encontrada"}, status_code=404)

    ve_privado = is_conformidade(user.role)
    restrito = "true" if ve_privado else "d.restrito = false"

    cab = (await db.execute(text(_SQL_CABECALHO), {"codigo": codigo})).first()
    if cab is None:
        return JSONResponse({"error": "Família não encontrada"}, status_code=404)

    existe = bool(cab.temCatalogo) or cab.familiaId is not None or bool(cab.temIndicio)
    if not existe:
        return JSONResponse({"error": "Família não encontrada"}, status_code=404)

    cod = str(cab.codigo)
    familia_id = _txt(cab.familiaId)

    provas = []
    if familia_id:
        rows = (
            await db.execute(
                text(_SQL_PROVAS.format(restrito=restrito)), {"familia_id": familia_id}
            )
        ).fetchall()
        provas = [
            {
                "vinculoId": str(r.vinculoId),
                "documentoId": str(r.documentoId),
                "titulo": r.titulo or "",
                "categoria": r.categoria or "",
                "subcategoria": r.subcategoria or "",
                "status": r.status or "",
                "validadeFim": _js(r.validadeFim),
                "observacao": _txt(r.observacao),
                "vinculadoEm": _js(r.vinculadoEm),
                "restrito": bool(r.restrito),
            }
            for r in rows
        ]

    todos = [
        _mapear_indicio(r)
        for r in (
            await db.execute(
                text(_SQL_INDICIOS.format(restrito=restrito, ordem=_ORDEM_VEREDITO)),
                {"cod": cod},
            )
        ).fetchall()
    ]

    indicios = [i for i in todos if not indicio_negativo(i["veredito"], i["revisao"])]
    refutacoes = [i for i in todos if indicio_negativo(i["veredito"], i["revisao"])]

    recentes = [
        {
            "numero": str(r.numero),
            "vistoEm": _js(r.vistoEm),
            "licitacaoId": _txt(r.licitacaoId),
            "objeto": _txt(r.objeto),
        }
        for r in (await db.execute(text(_SQL_DEMANDA), {"cod": cod})).fetchall()
    ]

    if ve_privado:
        ocultos = 0
    else:
        alvo = (
            "df.familia_id = CAST(:familia_id AS uuid)" if familia_id else "false"
        )
        par = {"cod": cod}
        if familia_id:
            par["familia_id"] = familia_id
        r_oc = (await db.execute(text(_SQL_OCULTOS.format(alvo_familia=alvo)), par)).first()
        ocultos = int(r_oc.n) if r_oc else 0

    avaliada = bool(cab.avaliada)
    prova = estado_prova(len(provas), len(indicios), avaliada)

    return JSONResponse(
        {
            "codigo": cod,
            "nome": _txt(cab.nome),
            "catalogo": (
                {
                    "nome": _txt(cab.catalogoNome),
                    "escopo": _txt(cab.escopo),
                    "grupo": _txt(cab.grupo),
                    "segmentoPetrobras": _txt(cab.segmentoPetrobras),
                    "segmento": str(cab.segmento),
                    "oficial": bool(cab.oficial),
                }
                if cab.temCatalogo
                else None
            ),
            "cadastro": (
                {
                    "familiaId": familia_id,
                    "nome": cab.cadastroNome or "",
                    "descricao": _txt(cab.descricao),
                    "status": cab.status or "",
                    "statusFluxoCrc": _txt(cab.statusFluxoCrc),
                    "validadeFim": _js(cab.validadeFim),
                    "cadastroCorporativo": bool(cab.cadastroCorporativo),
                }
                if familia_id
                else None
            ),
            "demanda": {
                "licitacoes": int(cab.licitacoes or 0),
                "itens": int(cab.itens or 0),
                "primeiraVezEm": _js(cab.primeiraVezEm),
                "ultimaVezEm": _js(cab.ultimaVezEm),
                "recentes": recentes,
            },
            "provas": provas,
            "indicios": indicios,
            "refutacoes": refutacoes,
            "restritosOcultos": ocultos,
            "avaliada": avaliada,
            "prova": prova,
            "quadrante": quadrante_de(familia_id is not None, prova),
            "ressalva": {
                "texto": (
                    "INDÍCIO é apontamento da máquina sobre o texto do acervo, ainda sem "
                    "revisão humana — não sustenta um NO-GO nem substitui o atestado. "
                    "Confirmar um indício é o que o transforma em prova."
                ),
                "demandaObservada": (
                    "Demanda medida nas licitações coletadas pelo Petro Radar, não no "
                    "histórico completo da Petrobras. Zero aqui não significa zero no mercado."
                ),
            },
        }
    )
