"""Logging estruturado em JSON, com propagação de Request-ID.

Cada linha de log é um objeto JSON de uma linha (JSON Lines), conveniente para
ingestão em ferramentas de observabilidade. O ``request_id`` é mantido em um
``ContextVar`` e injetado automaticamente em todos os registros emitidos durante
o tratamento de uma requisição (ver o middleware em ``app/main.py``).
"""

from __future__ import annotations

import json
import logging
import sys
from contextvars import ContextVar
from datetime import datetime, timezone

# ContextVar populado pelo middleware de Request-ID a cada requisição.
request_id_ctx: ContextVar[str | None] = ContextVar("request_id", default=None)


class _JsonFormatter(logging.Formatter):
    """Formata cada ``LogRecord`` como uma linha JSON.

    Inclui timestamp ISO-8601 (UTC), nível, logger, mensagem, o ``request_id``
    corrente (quando houver) e quaisquer campos extras passados via
    ``logger.info("msg", extra={...})``.
    """

    _RESERVADOS = frozenset(
        logging.LogRecord("", 0, "", 0, "", (), None).__dict__.keys()
    ) | {"message", "asctime", "taskName"}

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "ts": datetime.fromtimestamp(
                record.created, tz=timezone.utc
            ).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }

        rid = request_id_ctx.get()
        if rid:
            payload["request_id"] = rid

        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)

        # Campos extras (passados via `extra=`) que não sejam atributos padrão.
        for chave, valor in record.__dict__.items():
            if chave not in self._RESERVADOS and not chave.startswith("_"):
                payload[chave] = valor

        return json.dumps(payload, ensure_ascii=False, default=str)


def setup_logging(level: str = "info") -> None:
    """Configura o logging raiz com saída JSON em ``stdout``.

    Idempotente: substitui handlers já instalados para evitar duplicação ao
    recarregar (ex.: uvicorn ``--reload``). Alinha também os loggers do uvicorn.
    """
    nivel = getattr(logging, level.upper(), logging.INFO)

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_JsonFormatter())

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(nivel)

    # Roteia os logs do uvicorn pelo mesmo formatter (sem handlers próprios).
    for nome in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(nome)
        lg.handlers.clear()
        lg.propagate = True


def get_logger(nome: str = "petro_radar_bff") -> logging.Logger:
    """Retorna um logger nomeado já integrado ao formatter JSON."""
    return logging.getLogger(nome)
