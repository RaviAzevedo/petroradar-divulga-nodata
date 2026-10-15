"""Handlers de erro tipados do BFF — paridade de forma com o Next, SEM vazar PII.

MOTIVACAO (auditoria WP03 / §8): o handler DEFAULT de 422 do FastAPI ecoa o
INPUT bruto que reprovou a validacao — o Pydantic inclui ``input``/``ctx`` em
cada erro, o que pode REFLETIR DADOS PESSOAIS (CPF, e-mail, CREA, etc.) no corpo
da resposta. Aqui o 422 e reescrito para o shape do Next
``{"error": "Dados invalidos", "code": "VALIDATION", "campos": [...]}``, onde
``campos`` traz APENAS a localizacao e o tipo do erro — NUNCA o valor enviado.

Estes handlers COMPLEMENTAM (nao substituem) o que ja vive em ``main.py``:
  - ``StarletteHTTPException`` (401/403 -> ``{error, code}``; 405 -> corpo vazio;
    demais -> ``{detail}``) — as rotas que validam manualmente e levantam
    ``HTTPException(422, detail={"error","code":"VALIDATION"})`` continuam
    passando por la (o ``detail`` dict e repassado como esta).
  - catch-all 500 do middleware (``{error: "Erro interno"}`` — mesmo shape do Next).
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class ApiError(Exception):
    """Erro tipado do BFF — espelha a classe ``ApiError`` de ``src/lib/api/guards.ts``.

    Rotas/servicos podem levantar ``ApiError(status, code, message)`` para produzir
    o MESMO shape ``{error, code}`` do ``handleApiError`` do Next.
    """

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _campos_seguros(errors: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Extrai so a localizacao + o tipo de cada erro de validacao (sem o valor).

    NUNCA inclui ``input``/``ctx`` do Pydantic — o valor enviado pelo cliente
    pode conter PII. Retorna, por campo, ``{"campo": <caminho>, "erro": <tipo>}``.
    """
    campos: list[dict[str, str]] = []
    for e in errors:
        loc = e.get("loc", ()) or ()
        # descarta o 1o nivel ("body"/"query"/"path"); mantem o caminho do campo.
        caminho = ".".join(str(p) for p in loc[1:]) if len(loc) > 1 else (str(loc[0]) if loc else "")
        campos.append({"campo": caminho, "erro": str(e.get("type", "invalid"))})
    return campos


def registrar_handlers(app: FastAPI) -> None:
    """Registra os handlers tipados no app (chamar no ``main.py`` apos criar o app)."""

    @app.exception_handler(ApiError)
    async def _api_error_handler(_request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status, content={"error": exc.message, "code": exc.code}
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_handler(
        _request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        # 422 SEM ecoar o input (fix de PII — WP03/§8). Shape do Next: {error, code}.
        return JSONResponse(
            status_code=422,
            content={
                "error": "Dados inválidos",
                "code": "VALIDATION",
                "campos": _campos_seguros(exc.errors()),
            },
        )
