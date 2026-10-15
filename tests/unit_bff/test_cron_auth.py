"""
F10(b) — ``safe_equal`` de bff/app/core/cron_auth.py (comparação constant-time).

Réplica de ``safeEqual`` do Next (src/lib/security/secrets.ts): SHA-256 dos dois
lados + ``hmac.compare_digest``. Contrato coberto: igual/diferente/None/vazio —
o caminho None é o guard-rail de ``verify_cron_auth`` quando o header falta.
"""
from __future__ import annotations

import pytest

cron_auth = pytest.importorskip(
    "app.core.cron_auth",
    reason="bff/app não importável (rode via make test-unit-bff ou instale bff/requirements.txt)",
)


def test_safe_equal_iguais():
    assert cron_auth.safe_equal("Bearer s3gr3do", "Bearer s3gr3do") is True


def test_safe_equal_diferentes():
    assert cron_auth.safe_equal("Bearer s3gr3do", "Bearer errado") is False


def test_safe_equal_prefixo_nao_basta():
    # sha256 mata qualquer atalho de prefixo: "abc" != "abcd" mesmo compartilhando bytes.
    assert cron_auth.safe_equal("abc", "abcd") is False


def test_safe_equal_none_de_um_lado():
    assert cron_auth.safe_equal(None, "x") is False
    assert cron_auth.safe_equal("x", None) is False


def test_safe_equal_none_dos_dois_lados():
    # None ≠ None por design (ausência de segredo NUNCA autoriza).
    assert cron_auth.safe_equal(None, None) is False


def test_safe_equal_vazios_sao_iguais():
    # "" == "" é True na função crua; o gate de verify_cron_auth nunca chega aqui
    # com secret vazio (cai no ramo x-vercel-cron) — documentado para não regredir.
    assert cron_auth.safe_equal("", "") is True


def test_safe_equal_unicode():
    assert cron_auth.safe_equal("çãá-🔑", "çãá-🔑") is True
    assert cron_auth.safe_equal("çãá-🔑", "çãá-🔒") is False
