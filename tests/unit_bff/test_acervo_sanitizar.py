"""
Sanitização da pergunta antes do ``websearch_to_tsquery`` — e a PARIDADE com o
espelho em TypeScript.

Por que este teste existe: até 29/08/2026 a busca do acervo passava a pergunta
crua para o ``websearch_to_tsquery``, que tem sintaxe de operador. Texto colado
de edital — o uso normal desta busca — disparava essa sintaxe sem querer:

    "Refinaria Exemplo Norte - REFX - Município ... - SP"
      -> 'refin' & 'exempl' & 'nort' & !'refx' & !'municipi' & ... & !'sp'

Ou seja, o braço estrito EXCLUÍA os três termos que identificam a refinaria, e
devolvia 0 chunks. Medido no parser do PostgreSQL 16.14.

Os casos abaixo são os MESMOS de app/src/__tests__/lib/acervo-sanitizar.test.ts,
de propósito: os dois backends servem a mesma rota, e divergir aqui significa a
busca responder diferente conforme quem atendeu — o modo de falha que o
estrangulador já produziu antes neste projeto.
"""
from __future__ import annotations

import pytest

_mod = pytest.importorskip(
    "app.routers.migrated.acervo_buscar",
    reason="bff/app não importável (rode via make test-unit-bff)",
)
sanitizar = _mod._sanitizar_websearch


@pytest.mark.parametrize(
    "entrada,esperado",
    [
        # O bug que zerava o braço estrito.
        ("Refinaria Exemplo Norte - REFX - SP", "Refinaria Exemplo Norte REFX SP"),
        # f_unaccent roda DEPOIS, no SQL, e converte 15 codepoints para "-".
        # Travessão (U+2014) é comum em pergunta colada de edital.
        ("Contrato 4600001234 — que documentos temos?", "Contrato 4600001234 que documentos temos?"),
        ("Refinaria – REFX", "Refinaria REFX"),
        ("traço ― longo", "traço longo"),
        # Aspa ÍMPAR faz busca de FRASE até o fim da string.
        ("“abertura curva ímpar", "abertura curva ímpar"),
        ('aspa " solta', "aspa solta"),
        ("alfa or beta", "alfa beta"),
        ("or", ""),
    ],
)
def test_neutraliza_operador_acidental(entrada, esperado):
    assert sanitizar(entrada) == esperado


@pytest.mark.parametrize(
    "entrada",
    ["alfa or-beta", "OR-2024", "2024-or-2025"],
)
def test_nao_cria_operador_que_nao_existia(entrada):
    """A ordem é ASPAS -> OR -> HÍFEN.

    Remover o "or" DEPOIS do hífen descolaria um hífen já preservado e
    transformaria "alfa or-beta" em "alfa -beta" = ``'alfa' & !'bet'``.
    """
    assert sanitizar(entrada) == entrada


@pytest.mark.parametrize(
    "entrada",
    [
        "contrato PJ-7000001",
        "reator U-32 e R-301",
        "CNPJ 11.222.333/0001-81",
        "1234.0001111.17.2",
        "10001/10002",
        "pré-operação anti-corrosivo",
        "ORCAMENTO",
        "alfa/or beta",
    ],
)
def test_preserva_identificador(entrada):
    """O hífen COLADO à esquerda fica DENTRO do lexema.

    "PJ-7000001" indexa como 'pj' + '-7000001'. Trocá-lo por espaço geraria
    '7000001', que não casa com o índice — e mataria o caso "identificador".
    """
    assert sanitizar(entrada) == entrada


@pytest.mark.parametrize(
    "entrada,esperado",
    [
        ("", ""),
        ("   ", ""),
        ("- - - -", ""),
        ('"', ""),
        ("﻿REFX teste", "REFX teste"),
        ("muito   espaço", "muito espaço"),
        (None, ""),
    ],
)
def test_entrada_degenerada_nao_explode(entrada, esperado):
    assert sanitizar(entrada) == esperado
