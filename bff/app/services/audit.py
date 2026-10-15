"""Trilha de auditoria (LGPD) — writer do ``audit_log`` no BFF.

As rotas migradas que, no Next, faziam ``db.insert(auditLog).values({...})``
chamam :func:`registrar_audit` para gravar a MESMA linha. Espelha o shape do
Next (``lib/audit/queries.ts`` + inserts inline): colunas
``user_id, acao, entidade, entidade_id, detalhes(jsonb)`` (``criado_em`` default now()).

Segurança (WP09 §7.2): nunca grava senha/token/CPF/query crua — :func:`_redigir`
remove chaves sensíveis de ``detalhes`` antes do INSERT.
"""
from __future__ import annotations

import json
from typing import Any

from sqlalchemy import text

# Chaves que NUNCA vão para o audit_log (case-insensitive).
_SENSIVEIS = {
    "senha", "password", "pass", "token", "secret", "authorization",
    "cpf", "cnpj_raw", "x-setup-token", "setup_token", "api_key", "apikey",
}


def _redigir(detalhes: Any) -> dict:
    """Remove chaves sensíveis (recursivo em dicts)."""
    if not isinstance(detalhes, dict):
        return {"valor": detalhes} if detalhes is not None else {}
    out: dict = {}
    for k, v in detalhes.items():
        if str(k).lower() in _SENSIVEIS:
            out[k] = "[REDACTED]"
        elif isinstance(v, dict):
            out[k] = _redigir(v)
        else:
            out[k] = v
    return out


async def registrar_audit(
    db,
    *,
    user_id: str | None,
    acao: str,
    entidade: str | None = None,
    entidade_id: str | None = None,
    detalhes: dict | None = None,
) -> None:
    """INSERT em ``audit_log`` na MESMA transação/sessão do handler (commit é do
    chamador, igual ao Next — o insert de auditoria acompanha a operação). Falha
    de auditoria NÃO deve derrubar a operação principal: erros são engolidos com
    log (a trilha é best-effort, como no Next que também não faz rollback por ela).

    SAVEPOINT obrigatório (achado de teste ao vivo): capturar a exceção
    em Python NÃO desfaz o estado do Postgres — depois de um INSERT falho a
    transação fica ABORTADA, todo statement seguinte falha com "current
    transaction is aborted" e o commit do chamador vira rollback. O sintoma era
    o pior possível: a rota respondia 201 e o banco não tinha NADA (nem o
    documento, nem o audit). O ``begin_nested()`` cria um SAVEPOINT: a falha do
    insert reverte só ele, e a operação principal segue commitável.
    """
    try:
        async with db.begin_nested():
            await db.execute(
                text(
                    """
                    INSERT INTO audit_log (user_id, acao, entidade, entidade_id, detalhes)
                    VALUES (
                        CAST(NULLIF(:uid, '') AS uuid), :acao, :entidade, :entidade_id,
                        CAST(:detalhes AS jsonb)
                    )
                    """
                ),
                {
                    "uid": user_id or "",
                    "acao": acao,
                    "entidade": entidade,
                    "entidade_id": entidade_id,
                    "detalhes": json.dumps(_redigir(detalhes or {}), ensure_ascii=False),
                },
            )
    except Exception:  # noqa: BLE001 — auditoria é best-effort, não quebra a rota
        import logging

        logging.getLogger("petro.audit").warning(
            "falha ao gravar audit_log (acao=%s entidade=%s)", acao, entidade
        )
