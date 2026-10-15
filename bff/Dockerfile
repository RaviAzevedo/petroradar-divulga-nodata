# =============================================================================
# bff/Dockerfile — FastAPI BFF (Petro Radar). Build context = ./bff (self-contained;
# o codigo Python do BFF vive AQUI, nao no repo do app).
# =============================================================================
FROM python:3.12-slim AS base

# libpq p/ asyncpg/psycopg; curl p/ debugging/healthcheck manual.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq5 curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# Dependencias (cache layer).
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# Codigo do BFF: ./bff/* -> /app/* (entao o pacote fica em /app/app).
COPY . /app/

# Usuario nao-root.
RUN useradd -u 1001 -m appuser && chown -R appuser /app
USER appuser

EXPOSE 8000

# Entrypoint ASGI = app.main:app (GET /bff/health + routers /bff/*).
# UVICORN_WORKERS vem do compose (default 2). Sem --reload em producao.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers ${UVICORN_WORKERS:-2}"]
