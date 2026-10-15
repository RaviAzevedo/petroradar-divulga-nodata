# =============================================================================
# worker/Dockerfile — Worker on-prem (Celery + Redis + Playwright)
# Build context = ./worker (self-contained; NÃO depende do repo do app).
# Substitui o Railway dispatcher.py + o scraper do GitHub Actions.
# =============================================================================
# Base oficial Playwright Python (Chromium + libs de sistema já instalados),
# casada ao playwright==1.49.0 usado em produção (Dockerfile.railway).
FROM mcr.microsoft.com/playwright/python:v1.49.0-jammy

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app

# Deps de orquestração/dados. O requirements PINA playwright==1.49.0 para casar
# com o chromium-1148 QUE JA VEM na imagem base (/ms-playwright) — sem o pin, o
# playwright-stealth puxava 1.61 e era preciso baixar um SEGUNDO Chromium aqui
# (+~1GB de imagem). NAO adicionar `playwright install` de volta.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Código do worker (celery_app, beat_schedule, tasks, healthz, start.sh).
COPY . .
RUN chmod +x start.sh

# Hardening (WP09 §10.3): roda como usuário NÃO-root. É o container de maior
# superfície (Chromium + egress externo p/ o Portal da Transparência).
# Chromium roda bem não-root; os browsers ficam em /ms-playwright (world-readable
# na base oficial). /state é chown'd p/ o volume nomeado herdar o dono.
RUN useradd -m -u 1001 worker \
    && mkdir -p /state \
    && chown -R worker:worker /app /state
USER worker

# Estado persistente: schedule do beat.
VOLUME ["/state"]

# Healthcheck do compose: http://127.0.0.1:8080/healthz
EXPOSE 8080

CMD ["bash", "start.sh"]
