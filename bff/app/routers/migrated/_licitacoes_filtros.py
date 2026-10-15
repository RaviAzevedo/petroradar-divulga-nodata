"""Construtor do WHERE de ``licitacoes`` — compartilhado entre listagem e export.

Extraido de ``licitacoes_list.py`` em 2026-08-05 SEM mudanca de comportamento: as
condicoes, a ordem delas e os nomes dos binds sao os mesmos de antes, e a listagem
passou a chamar esta funcao no lugar do bloco inline.

Motivo: ``/api/licitacoes/export`` ignorava os 18 filtros que ``/explorar`` monta na
URL — o usuario filtrava a tela, clicava em "Exportar" e levava a base inteira
achando que levava a selecao (achado de auditoria). Com um unico
construtor, filtrar a tela e exportar passam a concordar por construcao.

Uso:
    conds, params = construir_where_licitacoes(request.query_params)
    where_sql = (" WHERE " + " AND ".join(conds)) if conds else ""
"""

from __future__ import annotations

from typing import Any, Mapping


def construir_where_licitacoes(qp: Mapping[str, Any]) -> tuple[list[str], dict[str, Any]]:
    """Monta as condicoes SQL e os binds a partir dos query params.

    Espelha a ordem e a semantica do handler do Next (Drizzle). Devolve a lista de
    condicoes (para juntar com AND) e o dicionario de parametros nomeados.
    """
    conds: list[str] = []
    params: dict[str, Any] = {}

    def _get(nome: str) -> str:
        return qp.get(nome) or ""

    def _csv(nome: str) -> list[str]:
        bruto = qp.get(nome)
        if bruto is None:
            return []
        return [p for p in bruto.split(",") if p]

    search = _get("search")
    empresa = _get("empresa")
    fonte_filtro = _get("fonte")

    relevancia = _csv("relevancia")
    natureza = _csv("natureza")
    fase = _csv("fase")
    segmento = _csv("segmento")

    score_min = _get("score_min")
    estado = _get("estado")
    abrangencia = _get("abrangencia")
    perfil = _get("perfil")

    data_fim_de = _get("data_fim_de")
    data_fim_ate = _get("data_fim_ate")
    data_pub_de = _get("data_pub_de")
    data_pub_ate = _get("data_pub_ate")
    data_inicio_de = _get("data_inicio_de")
    data_inicio_ate = _get("data_inicio_ate")

    prazo = _get("prazo")

    if search:
        params["search"] = f"%{search}%"
        conds.append(
            "(objeto ILIKE :search OR numero ILIKE :search "
            "OR regioes ILIKE :search OR empresa ILIKE :search)"
        )

    if empresa:
        params["empresa"] = f"%{empresa}%"
        conds.append("empresa ILIKE :empresa")

    # Fonte da licitação: petronect (scraper nativo) | transparencia (descoberta).
    if fonte_filtro:
        params["fonte_filtro"] = fonte_filtro
        conds.append("fonte = :fonte_filtro")

    def _in_clause(coluna: str, valores: list[str], prefixo: str) -> None:
        nomes = []
        for i, v in enumerate(valores):
            chave = f"{prefixo}_{i}"
            params[chave] = v
            nomes.append(f":{chave}")
        conds.append(f"{coluna} IN (" + ", ".join(nomes) + ")")

    if relevancia:
        _in_clause("relevancia", relevancia, "rel")
    if natureza:
        _in_clause("natureza", natureza, "nat")
    if fase:
        _in_clause("fase", fase, "fas")
    if segmento:
        _in_clause("segmento", segmento, "seg")

    # Score mínimo de interesse (0..100).
    if score_min:
        try:
            params["score_min"] = int(score_min)
            conds.append("score_interesse >= :score_min")
        except (TypeError, ValueError):
            pass
    # Estado/UF — regioes é lista textual de estados (ILIKE parcial).
    if estado:
        params["estado"] = f"%{estado}%"
        conds.append("regioes ILIKE :estado")
    # Abrangência: 'N'/'Nacional' ou 'I'/'Internacional' (prefixo enviado pelo front).
    if abrangencia:
        params["abrangencia"] = f"{abrangencia}%"
        conds.append("abrangencia ILIKE :abrangencia")
    # Perfil de interesse — perfis_match é lista textual de perfis (ILIKE parcial).
    if perfil:
        params["perfil"] = f"%{perfil}%"
        conds.append("perfis_match ILIKE :perfil")

    # Prazo rápido (tem prioridade sobre datas manuais de data_fim).
    if prazo == "hoje":
        conds.append(
            "(data_fim != '' AND data_fim IS NOT NULL "
            "AND data_fim = CURRENT_DATE::text)"
        )
    elif prazo == "7d":
        conds.append(
            "(data_fim != '' AND data_fim IS NOT NULL "
            "AND data_fim >= CURRENT_DATE::text "
            "AND data_fim <= (CURRENT_DATE + INTERVAL '7 days')::text)"
        )
    elif prazo == "30d":
        conds.append(
            "(data_fim != '' AND data_fim IS NOT NULL "
            "AND data_fim >= CURRENT_DATE::text "
            "AND data_fim <= (CURRENT_DATE + INTERVAL '30 days')::text)"
        )
    elif prazo == "vencidas":
        conds.append(
            "(data_fim != '' AND data_fim IS NOT NULL "
            "AND data_fim < CURRENT_DATE::text)"
        )
    else:
        # Datas manuais de data_fim.
        if data_fim_de:
            params["data_fim_de"] = data_fim_de
            conds.append(
                "(data_fim IS NOT NULL AND data_fim != '' "
                "AND data_fim >= :data_fim_de)"
            )
        if data_fim_ate:
            params["data_fim_ate"] = data_fim_ate
            conds.append(
                "(data_fim IS NOT NULL AND data_fim != '' "
                "AND data_fim <= :data_fim_ate)"
            )

    # Filtro por data de início do período de cotação.
    if data_inicio_de:
        params["data_inicio_de"] = data_inicio_de
        conds.append(
            "(data_inicio IS NOT NULL AND data_inicio != '' "
            "AND data_inicio >= :data_inicio_de)"
        )
    if data_inicio_ate:
        params["data_inicio_ate"] = data_inicio_ate
        conds.append(
            "(data_inicio IS NOT NULL AND data_inicio != '' "
            "AND data_inicio <= :data_inicio_ate)"
        )

    # Filtro por data de publicação.
    if data_pub_de:
        params["data_pub_de"] = data_pub_de
        conds.append(
            "(data_publicacao IS NOT NULL AND data_publicacao != '' "
            "AND data_publicacao >= :data_pub_de)"
        )
    if data_pub_ate:
        params["data_pub_ate"] = data_pub_ate
        conds.append(
            "(data_publicacao IS NOT NULL AND data_publicacao != '' "
            "AND data_publicacao <= :data_pub_ate)"
        )

    if qp.get("novas") == "1":
        conds.append("criado_em >= NOW() - INTERVAL '24 hours'")

    if qp.get("com_circulares") == "1":
        conds.append(
            "EXISTS (SELECT 1 FROM circulares "
            "WHERE circulares.licitacao_id = licitacoes.id)"
        )

    return conds, params
