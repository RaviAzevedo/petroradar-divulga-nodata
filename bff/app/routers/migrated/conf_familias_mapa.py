"""GET /api/conformidade/familias/mapa — o mercado observado × o nosso cadastro.

ESPELHO de app/src/app/api/conformidade/familias/mapa/route.ts e de
app/src/lib/conformidade/familias/mapa.ts.

⚠️ ESTE É O LADO QUE ATENDE PRODUÇÃO. O NGINX manda todo ``/api/`` para o BFF e
``/api/conformidade/familias/mapa`` não está entre as exceções — sem este
arquivo a rota do Next nunca é alcançada e a tela recebe 404.

O QUE ELA FAZ
─────────────
A rota irmã (``conf_familias_w.listar_familias``) lista o NOSSO CADASTRO (só as
famílias cadastradas). Esta lista o MAPA: o cadastro em FULL OUTER JOIN com o
catálogo de famílias observadas nas licitações coletadas (migração 0040).

A diferença é o ponto. A listagem de cadastro é incapaz de mostrar uma família
como a 99000001 ("Família de exemplo") quando ela é
exigida nas licitações coletadas mas não está cadastrada — ela simplesmente
não aparece na lista.

Somente leitura: o catálogo é derivado (reconstruído a cada ``make migrate``) e
não tem writer humano. Por isso não há POST/PATCH.

Guard: ``require_visualizar`` — o mesmo do GET de famílias no Next
(``requireVisualizar()`` em route.ts). Não é ``is_conformidade``: é informação de
mercado, e quem orça precisa dela.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.security import CurrentUser, require_visualizar
from app.db.session import get_db

router = APIRouter()

_SEGMENTOS = {"MATERIAL", "SERVICO", "OUTRO"}
_QUADRANTES = {"NUCLEO", "RISCO", "OPORTUNIDADE", "FORA_DE_ALCANCE", "A_APURAR"}


def _lista(qp_valor: str | None, validos: set[str]) -> list[str] | None:
    """Lista separada por vírgula → list validada. Espelha listaDe() do Zod."""
    if not qp_valor:
        return None
    itens = [x.strip() for x in qp_valor.split(",") if x.strip()]
    if not itens or any(i not in validos for i in itens):
        return []          # sinaliza inválido; o chamador devolve 422
    return itens


def _inteiro(v: str | None, lo: int, hi: int) -> int | None | str:
    if v is None or v == "":
        return None
    try:
        n = int(v)
    except ValueError:
        return "invalido"
    return n if lo <= n <= hi else "invalido"


def estado_prova(vinculados: int, indicios: int, avaliada: bool) -> str:
    """Espelho exato de estadoProva() em mapa.ts.

    A ordem importa: vínculo confirmado ganha de indício, indício ganha de
    ausência — e ausência só vira "não" quando a família FOI avaliada. Senão é
    desconhecimento, e dizer "não" seria inventar.
    """
    if vinculados > 0:
        return "COM_PROVA"
    if indicios > 0:
        return "COM_INDICIO"
    return "SEM_INDICIO" if avaliada else "INDETERMINADO"


def quadrante_de(cadastrada: bool, prova: str) -> str:
    """Espelho exato de quadranteDe() em mapa.ts."""
    if prova == "INDETERMINADO":
        return "A_APURAR"
    sustenta = prova in ("COM_PROVA", "COM_INDICIO")
    if cadastrada:
        return "NUCLEO" if sustenta else "RISCO"
    return "OPORTUNIDADE" if sustenta else "FORA_DE_ALCANCE"


def resumir_mapa(linhas: list[dict[str, Any]]) -> dict[str, Any]:
    """Espelho de resumirMapa() em mapa.ts."""
    por_quadrante: dict[str, dict[str, int]] = {}
    for l in linhas:
        q = por_quadrante.setdefault(l["quadrante"], {"familias": 0, "licitacoes": 0})
        q["familias"] += 1
        q["licitacoes"] += l["licitacoes"]
    return {
        "porQuadrante": por_quadrante,
        "total": len(linhas),
        "cadastradas": sum(1 for l in linhas if l["cadastrada"]),
        # Cadastro que o mercado nunca exigiu na nossa base. NÃO é "cadastro
        # inútil": pode ser cobertura de raspagem. É pergunta, não veredito.
        "cadastradasSemDemanda": sum(
            1 for l in linhas if l["cadastrada"] and l["licitacoes"] == 0
        ),
        "demandaTotal": sum(l["licitacoes"] for l in linhas),
    }


@router.get("/api/conformidade/familias/mapa")
async def mapa_familias(
    request: Request,
    user: CurrentUser = Depends(require_visualizar),
    db=Depends(get_db),
) -> JSONResponse:
    qp = request.query_params

    segmento = _lista(qp.get("segmento"), _SEGMENTOS)
    quadrante = _lista(qp.get("quadrante"), _QUADRANTES)
    demanda_min = _inteiro(qp.get("demandaMinima"), 0, 1000)
    desde = _inteiro(qp.get("desde"), 1990, 2100)
    limite = _inteiro(qp.get("limite"), 1, 2000)
    busca = (qp.get("busca") or "").strip()[:120]
    somente_com_nome = qp.get("somenteComNome") == "true"
    # Estado da revisao humana — a fila de trabalho. Sem ele, achar "o que falta
    # revisar" exigia abrir familia por familia: centenas tem indicio e nenhuma tela
    # dizia quais ja passaram por gente.
    revisao = qp.get("revisao") or None
    if revisao is not None and revisao not in ("PENDENTE", "REVISADA"):
        revisao = "invalido"

    invalidos = [
        nome
        for nome, v in (
            ("segmento", segmento), ("quadrante", quadrante),
            ("demandaMinima", demanda_min), ("desde", desde), ("limite", limite),
            ("revisao", revisao),
        )
        if v == [] or v == "invalido"
    ]
    if invalidos:
        return JSONResponse(
            {"code": "VALIDACAO", "error": "Filtros inválidos",
             "campos": {n: ["inválido"] for n in invalidos}},
            status_code=422,
        )

    # Default SERVICO: a maior parte das famílias do catálogo é MATERIAL (válvula,
    # transmissor), fora do foco de uma prestadora de serviços. Sem o default a
    # primeira coisa que a tela mostra é ruído.
    segmentos = segmento or ["SERVICO"]
    # 1000 e nao 500: o catalogo oficial passa de 500 familias e o ORDER BY poe
    # licitacoes DESC na frente, entao 500 cortava as de demanda ZERO — onde
    # estava boa parte das oportunidades. Teto que corta em silencio e o pior tipo.
    lim = limite if isinstance(limite, int) else 1000

    params: dict[str, Any] = {"segmentos": segmentos, "limite": lim}
    cond = ["coalesce(c.segmento, 'SERVICO') = ANY(:segmentos)"]
    if isinstance(demanda_min, int):
        cond.append("coalesce(c.licitacoes, 0) >= :demanda_min")
        params["demanda_min"] = demanda_min
    if isinstance(desde, int):
        cond.append("c.ultima_vez_em >= make_date(:desde, 1, 1)")
        params["desde"] = desde
    if somente_com_nome:
        cond.append("coalesce(fam.nome, c.nome) IS NOT NULL")
    if revisao == "PENDENTE":
        cond.append("coalesce(i.pendentes, 0) > 0")
    elif revisao == "REVISADA":
        cond.append("coalesce(i.confirmados, 0) > 0")
    if busca:
        cond.append("(coalesce(fam.nome, c.nome) ILIKE :busca "
                    "OR coalesce(fam.codigo_crc, c.codigo) ILIKE :busca)")
        params["busca"] = f"%{busca}%"
    where = " AND ".join(cond)

    # FULL OUTER JOIN é o ponto: um LEFT do cadastro perderia as OPORTUNIDADES
    # (família exigida em que não estamos); um LEFT do catálogo perderia as
    # famílias nossas que o mercado nunca exigiu. Cada ausência significa uma
    # coisa diferente.
    sql = text(f"""
        WITH cadastro AS (
            SELECT f.*, f_codigo_crc(f.codigo_crc) AS chave
              FROM familias f WHERE f.deletado_em IS NULL
        ),
        provas AS (
            -- PROVA CONFIRMADA: alguem revisou e vinculou. Unico grau que
            -- sustenta um NO-GO. 0034/S15: restrito nunca conta.
            SELECT df.familia_id, count(*)::int AS n
              FROM documentos_familias df
              JOIN documentos_habilitacao d ON d.id = df.documento_id
             WHERE d.restrito = false
             GROUP BY df.familia_id
        ),
        indicios AS (
            -- INDICIO: a maquina apontou, ninguem revisou. Chaveia por CODIGO
            -- porque pode apontar familia nao cadastrada — o caso "oportunidade".
            -- REJEITADA fica de fora, senao a revisao vira Sisifo.
            SELECT fc.familia_codigo AS cod,
                   count(DISTINCT fc.documento_id)::int AS n,
                   -- Quantos JA PASSARAM por uma pessoa. Sem isto, quem revisa
                   -- varios indicios nao ve diferenca nenhuma no mapa no dia
                   -- seguinte: a revisao so aparecia no dossie, uma por uma.
                   count(*) FILTER (WHERE fc.revisao = 'CONFIRMADA')::int AS confirmados,
                   count(*) FILTER (WHERE fc.revisao IS NULL)::int AS pendentes,
                   max(fc.confianca) AS conf,
                   -- Ordem de FORCA do veredito, nao alfabetica: PROVA > PARCIAL
                   -- > ABSTEM. Um max() sobre o rotulo acertaria por acaso e
                   -- erraria quando alguem acrescentasse um veredito novo.
                   (array_agg(fc.veredito ORDER BY CASE fc.veredito
                      WHEN 'PROVA' THEN 1 WHEN 'PARCIAL' THEN 2 ELSE 3 END,
                      fc.confianca DESC NULLS LAST))[1] AS melhor,
                   (array_agg(fc.justificativa ORDER BY CASE fc.veredito
                      WHEN 'PROVA' THEN 1 WHEN 'PARCIAL' THEN 2 ELSE 3 END,
                      fc.confianca DESC NULLS LAST))[1] AS razao
              FROM familias_classificacoes fc
              JOIN documentos_habilitacao d ON d.id = fc.documento_id
             WHERE d.restrito = false
               AND fc.revisao IS DISTINCT FROM 'REJEITADA'
               -- NAO e veredito NEGATIVO: a familia foi lida contra o documento
               -- e ele nao a sustenta. Conta-la como indicio inverteria o
               -- significado. ABSTEM entra: candidato sem veredito.
               AND fc.veredito <> 'NAO'
             GROUP BY fc.familia_codigo
        ),
        avaliadas AS (
            -- O que a classificacao chegou a PROCURAR (migracao 0042), nao o que
            -- encontrou. Derivar do encontrado colapsaria dois estados opostos:
            -- familia que estava no vocabulario e nao casou nada ficaria sem
            -- linha e passaria por "ninguem perguntou" — justamente o caso da
            -- familia cadastrada que o acervo NAO sustenta, o achado que mais
            -- importa.
            SELECT DISTINCT familia_codigo AS cod FROM familias_classificacao_escopo
        )
        SELECT coalesce(fam.codigo_crc, c.codigo)  AS codigo,
               coalesce(fam.nome, c.nome)          AS nome,
               coalesce(c.segmento, 'SERVICO')     AS segmento,
               c.escopo                            AS escopo,
               c.grupo                             AS grupo,
               c.segmento_petrobras                AS segmento_petrobras,
               coalesce(c.licitacoes, 0)           AS licitacoes,
               c.ultima_vez_em                     AS ultima_vez_em,
               fam.id                              AS familia_id,
               (fam.id IS NOT NULL)                AS cadastrada,
               fam.status_fluxo_crc                AS status_fluxo_crc,
               fam.validade_fim                    AS validade_fim,
               coalesce(p.n, 0)                    AS documentos_vinculados,
               coalesce(i.n, 0)                    AS documentos_com_indicio,
               coalesce(i.confirmados, 0)          AS indicios_confirmados,
               coalesce(i.pendentes, 0)            AS indicios_pendentes,
               i.conf                              AS maior_confianca,
               i.melhor                            AS melhor_veredito,
               i.razao                             AS justificativa,
               (av.cod IS NOT NULL)                AS avaliada
          FROM cadastro fam
          FULL OUTER JOIN familias_catalogo c ON c.codigo = fam.chave
          LEFT JOIN provas p ON p.familia_id = fam.id
          LEFT JOIN indicios i ON i.cod = coalesce(fam.chave, c.codigo)
          LEFT JOIN avaliadas av ON av.cod = coalesce(fam.chave, c.codigo)
         WHERE {where}
         ORDER BY coalesce(c.licitacoes, 0) DESC,
                  coalesce(fam.nome, c.nome) NULLS LAST,
                  coalesce(fam.codigo_crc, c.codigo)
         LIMIT :limite
    """)

    res = await db.execute(sql, params)
    linhas: list[dict[str, Any]] = []
    for row in res.mappings().all():
        vinculados = int(row["documentos_vinculados"] or 0)
        indicios = int(row["documentos_com_indicio"] or 0)
        cadastrada = bool(row["cadastrada"])
        avaliada = bool(row["avaliada"])
        prova = estado_prova(vinculados, indicios, avaliada)
        linhas.append({
            "codigo": row["codigo"],
            "nome": row["nome"],
            "segmento": row["segmento"],
            "escopo": row["escopo"],
            "grupo": row["grupo"],
            "segmentoPetrobras": row["segmento_petrobras"],
            "licitacoes": int(row["licitacoes"] or 0),
            "ultimaVezEm": row["ultima_vez_em"].isoformat() if row["ultima_vez_em"] else None,
            "familiaId": str(row["familia_id"]) if row["familia_id"] else None,
            "cadastrada": cadastrada,
            "statusFluxoCrc": row["status_fluxo_crc"],
            "validadeFim": row["validade_fim"].isoformat() if row["validade_fim"] else None,
            "documentosVinculados": vinculados,
            "documentosComIndicio": indicios,
            "indiciosConfirmados": int(row["indicios_confirmados"] or 0),
            "indiciosPendentes": int(row["indicios_pendentes"] or 0),
            "maiorConfianca": float(row["maior_confianca"]) if row["maior_confianca"] is not None else None,
            "melhorVeredito": row["melhor_veredito"],
            "justificativa": row["justificativa"],
            "avaliada": avaliada,
            "prova": prova,
            "quadrante": quadrante_de(cadastrada, prova),
        })

    if quadrante:
        linhas = [l for l in linhas if l["quadrante"] in quadrante]

    return JSONResponse({
        "linhas": linhas,
        # Se voltou exatamente o teto, provavelmente cortou. Sem este aviso a
        # tela mostra uma lista completa que nao e completa.
        "truncado": len(linhas) >= lim,
        "resumo": resumir_mapa(linhas),
        # A tela PRECISA dizer isto ao usuário, não só o código.
        "ressalva": {
            "catalogoParcial": True,
            "texto": (
                "Demanda observada nas licitações coletadas pelo Petro Radar — não é o "
                "catálogo oficial da Petrobras. Ausência aqui não significa que a família não existe."
            ),
            "provaIndisponivel": False,
            "textoProva": (
                "INDÍCIO é apontamento da máquina sobre o texto do acervo, ainda sem "
                "revisão humana — não sustenta um NO-GO. Só parte das "
                "famílias do catálogo já entrou no vocabulário da classificação; "
                "as demais aparecem como 'a apurar', que é ninguém ter perguntado "
                "por elas — diferente de não termos."
            ),
        },
    })
