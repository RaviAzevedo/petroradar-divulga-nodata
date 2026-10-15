"""Redação de PII — e, sobretudo, o que ela NÃO pode destruir.

A versão anterior deste redator estragava número de ART do CREA
(``BA20230000001`` → ``BA[CPF-REMOVIDO]``), porque o lookbehind
``(?<!\\d)\\d{11}(?!\\d)`` exclui só DÍGITO. ART é o maior tipo de documento do acervo, e o
número é justamente o que se procura numa busca de habilitação.
(Os números de ART/contrato abaixo são fictícios, no formato real.)

Os casos abaixo são os MESMOS de app/src/__tests__/lib/pii.test.ts, de propósito:
os dois backends servem a mesma rota, e divergir aqui significa a mesma busca
redigir diferente conforme quem atendeu.
"""
from __future__ import annotations

import pytest

_mod = pytest.importorskip(
    "app.routers.migrated._pii",
    reason="bff/app não importável (rode via make test-unit-bff)",
)
redigir = _mod.redigir_pii
valido = _mod.cpf_valido


@pytest.mark.parametrize("texto", [
    "ART BA20230000001 SUBSTITUICAO ART20190000002",
    "CREA-BA ART OBRA/SERVICO No BA20200000003 INICIAL",
    "ART BA20190000004 vinculada",
    "contrato 4600001234 de 2015",
    "CNPJ 11.222.333/0001-81",
    "1234.0001111.17.2",
    "protocolo 12345678901 do processo",
    "medicao 19870654321 conforme planilha",
    "campo 000.000.000-00 nao preenchido",
])
def test_nao_destroi_identificador(texto):
    assert redigir(texto) == texto


def test_o_corte_e_o_digito_verificador_nao_a_aparencia():
    # 98765432100 PARECE sequência arbitrária e É CPF válido — os DV fecham.
    # 19870654321 parece data colada e não fecha. Aparência não decide.
    assert redigir("n 98765432100") == "n [CPF-REMOVIDO]"
    assert redigir("n 19870654321") == "n 19870654321"


@pytest.mark.parametrize("entrada,esperado", [
    ("CPF 529.982.247-25 do responsavel", "CPF [CPF-REMOVIDO] do responsavel"),
    ("CPF 52998224725 sem pontuacao", "CPF [CPF-REMOVIDO] sem pontuacao"),
    ("contato joao.silva@example.com agora", "contato [EMAIL-REMOVIDO] agora"),
    ("ART BA20230000001, CPF 529.982.247-25, a@b.com",
     "ART BA20230000001, CPF [CPF-REMOVIDO], [EMAIL-REMOVIDO]"),
])
def test_redige_pii_de_verdade(entrada, esperado):
    assert redigir(entrada) == esperado


def test_idempotente():
    uma = redigir("CPF 529.982.247-25 e a@b.com")
    assert redigir(uma) == uma


@pytest.mark.parametrize("entrada", [None, ""])
def test_preserva_vazio(entrada):
    assert redigir(entrada) == entrada


@pytest.mark.parametrize("c", ["529.982.247-25", "52998224725"])
def test_cpf_valido_aceita(c):
    assert valido(c) is True


@pytest.mark.parametrize("c", ["12345678901", "11111111111", "00000000000",
                               "5299822472", "529982247250", ""])
def test_cpf_valido_rejeita(c):
    assert valido(c) is False
