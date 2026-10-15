"""Seções da ficha da operação — espelho BFF de ``SECAO_POR_TIPO``/``SECOES_FICHA``.

Dicionários HOMÔNIMOS das constantes de ``app/src/lib/conformidade/operacoes.ts``
(00-ARQUITETURA §1.2 / 02-APIS §0.6-c). Um teste de paridade compara os dois
lados (mesma técnica do inventário de rotas): qualquer divergência de chave ou
valor é FAIL — por isso este módulo é só dado, sem lógica além do fallback.

NÃO é uma rota: não expõe ``router`` (o agregador ``include_migrated`` importa o
módulo e o ignora por não ter o atributo). O nome sem prefixo ``_`` é decisão da
spec (02-APIS §0.5) — é o par do arquivo TS, não um helper interno.

A seção é DERIVADA (ADR-02: não existe coluna ``secao``): tipo primeiro, papel
como fallback (os legados da 0033 têm tipo NULL), 9 no fim.
"""

from __future__ import annotations

# tipo_documento (20 valores da 0034) → nº da seção da ficha (tabela §1.2).
SECAO_POR_TIPO: dict[str, int] = {
    "CONTRATO": 1, "ADITIVO": 1, "ANEXO_CONTRATO": 1,
    "ATESTADO": 2,
    "ART": 3, "CAT": 3,
    "CREA_PJ": 4, "ISO": 4, "DECLARACAO": 4,
    "PROPOSTA": 5,
    "ANEXO_ET": 6, "DOC_PROJETO": 6,
    "PEDIDO": 7, "NF": 7, "CARTA": 7, "RELATORIO": 7, "PESSOAL": 7, "CAPA_OP": 7,
    "COMPACTADO": 8,
    "OUTRO": 9,
}

# Fallback para tipo NULL: seção pelo ``papel`` (mesma regra da barra).
SECAO_POR_PAPEL: dict[str, int] = {
    "ATESTADO": 2, "CAT_ART": 3, "CONTRATO": 1, "ADITIVO": 1,
    "NOTA_FISCAL": 7, "DECLARACAO": 4, "OUTRO": 9,
}

# Nomes canônicos — usados na TELA e na árvore do ZIP (slug).
SECOES_FICHA: dict[int, dict[str, str]] = {
    1: {"nome": "Contrato e aditivos",             "slug": "1_Contrato_e_aditivos"},
    2: {"nome": "Atestados de capacidade técnica", "slug": "2_Atestados"},
    3: {"nome": "ART e CAT",                       "slug": "3_ART_e_CAT"},
    4: {"nome": "Habilitação técnica da empresa",  "slug": "4_Habilitacao_tecnica"},
    5: {"nome": "Proposta e orçamento",            "slug": "5_Proposta_e_orcamento"},
    6: {"nome": "Anexos técnicos do contrato",     "slug": "6_Anexos_tecnicos"},
    7: {"nome": "Execução e administrativo",       "slug": "7_Execucao_e_administrativo"},
    8: {"nome": "A inspecionar",                   "slug": "8_A_inspecionar"},
    9: {"nome": "Sem tipo definido",               "slug": "9_Sem_tipo"},
}


def secao_do_documento(tipo: str | None, papel: str | None) -> int:
    """Seção de um documento: tipo primeiro, papel como fallback, 9 no fim.

    Homônimo de ``secaoDoDocumento`` (operacoes.ts). Valor desconhecido cai em 9
    de propósito (o ``Record`` do TS não tem miss em runtime; aqui o ``.get``
    com default cobre lixo legado sem estourar KeyError no meio de um ZIP).
    """
    if tipo:
        return SECAO_POR_TIPO.get(tipo, 9)
    if papel:
        return SECAO_POR_PAPEL.get(papel, 9)
    return 9
