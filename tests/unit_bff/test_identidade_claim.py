"""
Precedência do identificador do usuário no token: ``id`` ANTES de ``sub``.

Por que este teste existe: em 12/08/2026 o upload do cofre quebrava com
``ForeignKeyViolationError`` em ``documentos_habilitacao.uploadado_por``. Causa —
o ``@auth/core`` DESCARTA o id devolvido por ``profile()`` no login OAuth e grava
``id: crypto.randomUUID()`` (node_modules/@auth/core/lib/actions/callback/oauth/
callback.js:224); é esse UUID aleatório que vira o claim ``sub``. O id REAL do
usuário (``users.id``) o app grava em ``token.id`` (src/lib/auth.ts:432). Lendo
``sub`` primeiro, TODO write do BFF com FK para ``users`` estourava, e o corte de
revogação por usuário (``auth:revogado:user:<id>``) nunca casava.

O detalhe que deixou o bug invisível por semanas: os tokens forjados em
``tests/`` gravam o id real no ``sub`` — reproduzem o login break-glass
(Credentials), em que ``sub`` É o id do banco, e nunca o caminho SSO. Por isso os
casos abaixo forjam ``id`` e ``sub`` DIFERENTES, que é a forma real do token de
produção.
"""
from __future__ import annotations

import pytest

_security = pytest.importorskip(
    "app.core.security",
    reason="bff/app não importável (rode via make test-unit-bff ou instale bff/requirements.txt)",
)

ID_DO_BANCO = "787f611a-20d0-4905-8cd6-b8c4a6fb5183"
SUB_ALEATORIO = "907cc4ee-9614-49c0-99d5-d398645767d4"  # o UUID que o @auth/core sorteia


def _claims(**extra):
    base = {"sub": SUB_ALEATORIO, "email": "fulano.silva@example.com", "role": "ADMIN"}
    base.update(extra)
    return base


def test_id_vence_o_sub():
    """O caminho SSO real: os dois claims presentes e diferentes."""
    user = _security._claims_para_usuario(_claims(id=ID_DO_BANCO))
    assert user.id == ID_DO_BANCO, "o BFF precisa usar users.id, não o sub aleatório do Auth.js"
    assert user.sub == ID_DO_BANCO, "id e sub são o mesmo identificador no CurrentUser"


def test_sem_id_cai_no_sub():
    """Break-glass (Credentials) e os JWS forjados dos testes só têm ``sub``."""
    user = _security._claims_para_usuario(_claims())
    assert user.id == SUB_ALEATORIO


def test_id_vazio_nao_engole_o_sub():
    """``id`` presente porém vazio não pode zerar a identidade — o ``or`` cai no sub."""
    user = _security._claims_para_usuario(_claims(id=""))
    assert user.id == SUB_ALEATORIO


def test_sem_identificador_nenhum_e_401():
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        _security._claims_para_usuario({"email": "x@y.z", "role": "ADMIN"})
    assert exc.value.status_code == 401
