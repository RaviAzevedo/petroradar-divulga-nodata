"""
F10(c) — Helpers puros de bff/app/routers/migrated/_shared.py.

São réplicas bug-a-bug de semântica JS (Math.round, parseInt, flag()/num() do
config.ts do Next) — a REGRA DE PARIDADE do módulo proíbe "melhorar" o
comportamento; estes testes congelam exatamente as esquisitices do JS que os
routers migrados dependem. ``importorskip`` defensivo: o módulo é mantido por
outra frente (routers) e pode estar em edição.
"""
from __future__ import annotations

import math

import pytest

_shared = pytest.importorskip(
    "app.routers.migrated._shared",
    reason="bff/app não importável (rode via make test-unit-bff ou instale bff/requirements.txt)",
)


# ── js_round: Math.round do JS (half-up, inclusive nos negativos) ─────────────
def test_js_round_half_para_cima():
    assert _shared.js_round(2.5) == 3      # Python round(2.5) daria 2 (banker's)
    assert _shared.js_round(0.5) == 1
    assert _shared.js_round(2.4) == 2


def test_js_round_negativos_como_no_js():
    assert _shared.js_round(-0.5) == 0     # Math.round(-0.5) === -0 (== 0)
    assert _shared.js_round(-1.5) == -1    # Math.round(-1.5) === -1
    assert _shared.js_round(-1.6) == -2


# ── parse_int_js_or_default: parseInt(x ?? "<d>") || <d> ─────────────────────
def test_parse_int_js_or_default_prefixo_numerico():
    assert _shared.parse_int_js_or_default("12abc", 7) == 12   # parseInt lê o prefixo


def test_parse_int_js_or_default_zero_cai_no_default():
    # `|| default` do JS: 0 é falsy → default (esquisitice preservada de propósito).
    assert _shared.parse_int_js_or_default("0", 7) == 7


def test_parse_int_js_or_default_nan_e_none():
    assert _shared.parse_int_js_or_default("abc", 7) == 7      # NaN → || default
    assert _shared.parse_int_js_or_default(None, 7) == 7
    assert _shared.parse_int_js_or_default("-3", 7) == -3      # sinal suportado


# ── parse_int_js_nan_fallback: parseInt(raw ?? "<fb>") com NaN→fallback ──────
def test_parse_int_js_nan_fallback():
    assert _shared.parse_int_js_nan_fallback("41quarenta", 9) == 41
    assert _shared.parse_int_js_nan_fallback("", 9) == 9       # "" → NaN → fallback
    assert _shared.parse_int_js_nan_fallback(None, 9) == 9
    assert _shared.parse_int_js_nan_fallback("0", 9) == 0      # aqui 0 NÃO cai no fallback


# ── flag: réplica de flag() do config.ts (só "true"/"1" ligam) ───────────────
def test_flag_valores_que_ligam():
    assert _shared.flag("true", False) is True
    assert _shared.flag("1", False) is True


def test_flag_valores_que_nao_ligam():
    # "yes"/"on"/"TRUE" NÃO ligam no Next — não usar coerção bool do pydantic.
    assert _shared.flag("yes", True) is False
    assert _shared.flag("on", True) is False
    assert _shared.flag("TRUE", True) is False
    assert _shared.flag("0", True) is False


def test_flag_ausente_usa_default():
    assert _shared.flag(None, True) is True
    assert _shared.flag("", False) is False
    assert _shared.flag(None, False) is False


# ── num: réplica de num() do config.ts (Number + isFinite; trunca p/ int) ────
def test_num_numerico_e_truncamento():
    assert _shared.num("42", 5) == 42
    assert _shared.num("1.5", 5) == 1      # Number("1.5")=1.5; uso do Next trunca


def test_num_invalido_cai_no_fallback():
    assert _shared.num("banana", 5) == 5
    assert _shared.num("", 5) == 5
    assert _shared.num(None, 5) == 5
    assert _shared.num("Infinity", 5) == 5  # isFinite barra
    assert _shared.num("NaN", 5) == 5


def test_num_aceita_notacao_float_js():
    # Number("2e2") === 200 no JS; float("2e2") == 200.0 aqui — mesmo resultado.
    assert _shared.num("2e2", 5) == 200
    assert math.isfinite(_shared.num("-7", 5))
    assert _shared.num("-7", 5) == -7
