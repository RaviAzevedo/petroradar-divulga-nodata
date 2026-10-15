"""Paridade das regras puras do dossiê de família (BFF × Next).

O dossiê parte os indícios em dois blocos: "o que o acervo aponta" (fila de
revisão e argumento do pedido de CRC) e "lidos e não sustentam" (o lastro do
"não"). Trocar um pelo outro inverte a conclusão da tela — e como o BFF é o lado
que atende produção, uma divergência aqui não apareceria em teste de front.

Os casos são os MESMOS de app/src/__tests__/lib/familias-dossie.test.ts.
"""

from __future__ import annotations

import pytest

from app.routers.migrated.conf_familias_dossie import (
    estado_prova,
    indicio_negativo,
    quadrante_de,
)


@pytest.mark.parametrize(
    ("veredito", "revisao", "esperado"),
    [
        # A máquina leu contra o documento e ele não sustenta.
        ("NAO", None, True),
        # Sustentam.
        ("PROVA", None, False),
        ("PARCIAL", None, False),
        # ABSTEM é PENDÊNCIA, não negativa: é a maioria das linhas da base. Tratá-lo
        # como "não sustenta" viraria a maior parte da fila em veredito negativo.
        ("ABSTEM", None, False),
        # A decisão humana pesa mais que o veredito da máquina — senão rejeitar
        # não teria efeito na tela e o indício voltaria como argumento.
        ("PROVA", "REJEITADA", True),
        ("PARCIAL", "REJEITADA", True),
        ("PROVA", "CONFIRMADA", False),
        ("PARCIAL", "PARCIAL", False),
        # Veredito novo na 0041 não vira negativo por acidente: sumir com uma
        # linha da fila é pior que mostrá-la para alguém decidir.
        ("FUTURO", None, False),
    ],
)
def test_indicio_negativo(veredito: str, revisao: str | None, esperado: bool) -> None:
    assert indicio_negativo(veredito, revisao) is esperado


def test_estado_prova_ordem() -> None:
    """Vínculo > indício > ausência, e ausência só vira "não" se avaliada."""
    assert estado_prova(1, 0, False) == "COM_PROVA"
    assert estado_prova(1, 5, True) == "COM_PROVA"
    assert estado_prova(0, 3, False) == "COM_INDICIO"
    # A distinção que impede a tela de mentir: sem indício E avaliada = "não";
    # sem indício e NÃO avaliada = "não sabemos".
    assert estado_prova(0, 0, True) == "SEM_INDICIO"
    assert estado_prova(0, 0, False) == "INDETERMINADO"


def test_quadrante_cobre_as_cinco_decisoes() -> None:
    assert quadrante_de(True, "COM_PROVA") == "NUCLEO"
    assert quadrante_de(True, "COM_INDICIO") == "NUCLEO"
    assert quadrante_de(True, "SEM_INDICIO") == "RISCO"
    assert quadrante_de(False, "COM_PROVA") == "OPORTUNIDADE"
    assert quadrante_de(False, "COM_INDICIO") == "OPORTUNIDADE"
    assert quadrante_de(False, "SEM_INDICIO") == "FORA_DE_ALCANCE"
    # INDETERMINADO ignora o cadastro: não sabemos é não sabemos dos dois lados.
    assert quadrante_de(True, "INDETERMINADO") == "A_APURAR"
    assert quadrante_de(False, "INDETERMINADO") == "A_APURAR"
