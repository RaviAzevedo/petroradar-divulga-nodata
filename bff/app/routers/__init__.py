"""
Routers do Petro Radar BFF (camada estranguladora / strangler-fig).

Cada router agrupa endpoints MIGRADOS do app Next.js para o FastAPI on-premise.
Todos os routers sao montados com prefixo /bff em app.main (ver include_router),
de modo que o reverse-proxy possa rotear /bff/* ao FastAPI e o restante ao Next.
"""

from app.routers import acervo, licitacoes

__all__ = ["licitacoes", "acervo"]
