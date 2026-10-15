"""Camada de banco de dados: engine async (SQLAlchemy 2 + asyncpg) e pgvector.

Expõe:
  - ``engine``      — AsyncEngine conectado ao Postgres via asyncpg.
  - ``SessionLocal``— sessionmaker assíncrono.
  - ``Base``        — DeclarativeBase para os modelos ORM.
  - ``get_db()``    — dependency FastAPI que entrega uma ``AsyncSession``.
  - ``check_db()``  — ping leve usado pelo endpoint /health.

Suporte a pgvector: o tipo ``Vector`` (pacote ``pgvector``) é reexportado para
mapear a coluna ``vector(N)`` de ``acervo_chunks`` (RAG). N = ``EMBEDDING_DIM``
(=1024 para o modelo local BGE-m3; era 1536 com Voyage/OpenAI).
A extensão deve existir no banco (``CREATE EXTENSION IF NOT EXISTS vector;``).
"""

from __future__ import annotations

from collections.abc import AsyncGenerator

from pgvector.sqlalchemy import Vector  # noqa: F401  (reexport p/ modelos)
from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings

__all__ = [
    "Base",
    "Vector",
    "engine",
    "SessionLocal",
    "get_db",
    "check_db",
    "EMBEDDING_DIM",
]

#: Dimensão dos embeddings — deve casar com a coluna ``vector(N)`` (BGE-m3 = 1024).
EMBEDDING_DIM: int = settings.embedding_dimensoes


def _to_asyncpg_url(url: str) -> str:
    """Converte a ``DATABASE_URL`` para o driver ``postgresql+asyncpg://``.

    Normaliza prefixos comuns (``postgres://``, ``postgresql://``,
    ``postgresql+psycopg://``) e remove o parâmetro de query ``sslmode`` — o
    asyncpg não o entende (o SSL é controlado via ``connect_args``/``ssl=``).
    """
    if url.startswith("postgresql+asyncpg://"):
        base = url
    elif url.startswith("postgresql://"):
        base = "postgresql+asyncpg://" + url[len("postgresql://") :]
    elif url.startswith("postgres://"):
        base = "postgresql+asyncpg://" + url[len("postgres://") :]
    elif "://" in url and url.split("://", 1)[0].startswith("postgresql+"):
        # Troca qualquer outro driver (ex.: +psycopg) por +asyncpg.
        base = "postgresql+asyncpg://" + url.split("://", 1)[1]
    else:
        base = url

    # asyncpg não aceita sslmode na query string — descarta o parâmetro.
    if "sslmode=" in base:
        from urllib.parse import urlencode, urlsplit, urlunsplit
        from urllib.parse import parse_qsl

        partes = urlsplit(base)
        query = [(k, v) for k, v in parse_qsl(partes.query) if k != "sslmode"]
        base = urlunsplit(partes._replace(query=urlencode(query)))
    return base


class Base(DeclarativeBase):
    """Base declarativa para os modelos ORM do BFF."""


# Engine assíncrono compartilhado pela aplicação.
engine: AsyncEngine = create_async_engine(
    _to_asyncpg_url(settings.database_url),
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=10,
    future=True,
)

# Fábrica de sessões assíncronas. expire_on_commit=False evita lazy-loads
# acidentais após o commit (objetos seguem utilizáveis na resposta).
SessionLocal: async_sessionmaker[AsyncSession] = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Dependency FastAPI: cede uma ``AsyncSession`` e garante o fechamento.

    Faz rollback em caso de exceção e sempre fecha a sessão. O commit é
    responsabilidade do handler/serviço (ou de um helper transacional)::

        async def rota(db: AsyncSession = Depends(get_db)):
            ...
    """
    async with SessionLocal() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise


async def check_db() -> bool:
    """Ping leve do banco para o /health. Retorna True se ``SELECT 1`` responder."""
    async with engine.connect() as conn:
        await conn.execute(text("SELECT 1"))
    return True
