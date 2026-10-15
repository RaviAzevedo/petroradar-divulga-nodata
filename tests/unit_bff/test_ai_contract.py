"""F10 — contrato compartilhado de IA (H2)."""
from __future__ import annotations

import pytest

ai_contract = pytest.importorskip(
    "app.core.ai_contract",
    reason="bff/app não importável",
)


def test_ai_contract_carrega():
    c = ai_contract.load_ai_contract()
    assert c["version"] >= 1
    assert "instrucao_analise_edital" in c
    assert "model_pricing_usd_per_1k_tokens" in c


def test_model_pricing_tem_sonnet_e_haiku():
    pricing = ai_contract.model_pricing()
    assert any("sonnet" in k for k in pricing)
    assert any("haiku" in k for k in pricing)


def test_instrucao_menciona_tool():
    txt = ai_contract.instrucao_analise_edital()
    assert ai_contract.tool_analise_nome() in txt
