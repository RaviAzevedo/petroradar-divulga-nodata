"""Carregador do contrato compartilhado de IA (H2).

Fonte canônica: ``shared/ai-contract.json`` na raiz do repo on-prem.
Prompt de análise de edital + MODEL_PRICING devem ser editados SÓ neste JSON
(ou no espelho ``app/src/lib/ai-contract.json`` do repo Next) — nunca duplicar
inline em claude.ts / licitacoes_id_analise.py.
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

# Caminhos candidatos (dev local, container BFF com mount, CI).
_CANDIDATOS = (
    Path(os.environ.get("AI_CONTRACT_PATH", "")),
    Path(__file__).resolve().parents[3] / "shared" / "ai-contract.json",
    Path("/shared/ai-contract.json"),
)


def _resolver_arquivo() -> Path:
    for p in _CANDIDATOS:
        if p and p.is_file():
            return p
    raise FileNotFoundError(
        "shared/ai-contract.json não encontrado — defina AI_CONTRACT_PATH ou "
        "monte shared/ no container."
    )


@lru_cache(maxsize=1)
def load_ai_contract() -> dict[str, Any]:
    """Contrato parseado (cacheado por processo)."""
    with _resolver_arquivo().open(encoding="utf-8") as f:
        return json.load(f)


def instrucao_analise_edital() -> str:
    return str(load_ai_contract()["instrucao_analise_edital"])


def model_pricing() -> dict[str, dict[str, float]]:
    """USD por 1K tokens, keyed por id de modelo."""
    bruto = load_ai_contract().get("model_pricing_usd_per_1k_tokens") or {}
    return {str(k): {str(kk): float(vv) for kk, vv in v.items()} for k, v in bruto.items()}


def tool_analise_nome() -> str:
    return str(load_ai_contract().get("tool_analise_nome", "registrar_analise_edital"))
