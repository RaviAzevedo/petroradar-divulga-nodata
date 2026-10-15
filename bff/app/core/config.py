"""Configuração central da camada BFF FastAPI (versão on-premise do Petro Radar).

Expõe um objeto singleton ``settings`` baseado em ``pydantic-settings``. Todas as
variáveis são lidas do ambiente (ou do arquivo ``.env`` na raiz do pacote ``bff/``).

Contrato compartilhado entre os três agentes (core / routers / services):
o ``settings`` é a ÚNICA fonte de configuração. Nada deve ler ``os.environ``
diretamente fora deste módulo.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configurações da aplicação carregadas do ambiente / ``.env``.

    Atenção ao contrato de autenticação: o token JWT é EMITIDO pelo container
    Next.js (NextAuth v5) e apenas VALIDADO aqui. O segredo compartilhado é o
    ``auth_secret`` (alias de ``AUTH_SECRET``, com fallback para
    ``NEXTAUTH_SECRET`` — ver validador abaixo).
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Banco de dados ────────────────────────────────────────────────────────
    # URL no formato `postgresql://...`; convertida para asyncpg em db/session.py.
    database_url: str = Field(
        default="postgresql://user:pass@localhost:5432/petro_radar",
        alias="DATABASE_URL",
    )

    # ── Autenticação (validação de JWT emitido pelo NextAuth v5) ──────────────
    # AUTH_SECRET é o canônico; NEXTAUTH_SECRET é fallback (espelha o app Next.js).
    auth_secret: str = Field(default="", alias="AUTH_SECRET")
    nextauth_secret: str = Field(default="", alias="NEXTAUTH_SECRET")
    # Nome do cookie de sessão emitido pelo NextAuth (usado quando não há Bearer).
    auth_cookie_name: str = Field(
        default="authjs.session-token", alias="AUTH_COOKIE_NAME"
    )

    # ── Redis (cache / rate limit / health) ───────────────────────────────────
    redis_url: str = Field(default="redis://localhost:6379/0", alias="REDIS_URL")

    # ── Anthropic (análise IA / OCR / RAG) ────────────────────────────────────
    anthropic_api_key: str = Field(default="", alias="ANTHROPIC_API_KEY")
    # Claude Sonnet 5. Substituiu "claude-sonnet-4-20250514" (Sonnet 4), retirado
    # em 15/06/2026 — o id antigo passou a responder 404. Mantido em paridade com
    # config.ts (MODELS.analise) e shared/ai-contract.json.
    anthropic_model_sonnet: str = Field(
        default="claude-sonnet-5", alias="ANTHROPIC_MODEL_SONNET"
    )
    anthropic_model_haiku: str = Field(
        default="claude-haiku-4-5", alias="ANTHROPIC_MODEL_HAIKU"
    )
    # ── OCR → Anthropic (LGPD / DPIA) ─────────────────────────────────────────
    # Gate ORGANIZACIONAL do envio do PDF do cofre à Anthropic para extração de
    # metadados (OCR). Default CONSERVADOR = False: mesmo quando o usuário pede OCR
    # (ocr=true), NÃO enviamos PII à Anthropic até o DPA/contrato estar assinado e
    # o DPO aprovar (ver WP09, §DPIA Anthropic). Com
    # a flag desligada o upload SEGUE normalmente, apenas sem metadados de OCR
    # (degrade gracioso — idêntico ao caso de OCR indisponível).
    ocr_ia_enabled: bool = Field(default=False, alias="OCR_IA_ENABLED")

    # ── Embeddings / RAG (acervo técnico, pgvector) ───────────────────────────
    # Decisão de arquitetura: embeddings 100% ON-PREMISE via modelo local
    # BGE-m3 (1024 dims) servido pelo container `embeddings-local` (HuggingFace TEI).
    # Providers suportados: "local" (TEI on-prem) | "voyage" | "openai" (externos).
    embedding_provider: str = Field(default="local", alias="EMBEDDING_PROVIDER")
    # Endpoint do servidor de embeddings local (TEI), ex.: http://embeddings-local:80
    embedding_base_url: str = Field(
        default="http://embeddings-local:80", alias="EMBEDDING_BASE_URL"
    )
    voyage_api_key: str = Field(default="", alias="VOYAGE_API_KEY")
    openai_api_key: str = Field(default="", alias="OPENAI_API_KEY")
    embedding_model: str = Field(default="BAAI/bge-m3", alias="EMBEDDING_MODEL")
    # Deve casar com a coluna `vector(N)` de acervo_chunks. BGE-m3 = 1024.
    # (Voyage/OpenAI text-embedding-3-* = 1536 — exigiria migrar a coluna.)
    embedding_dimensoes: int = Field(default=1024, alias="EMBEDDING_DIMENSOES")

    # ── Armazenamento de objetos (S3 / Cloudflare R2 / MinIO on-prem) ─────────
    s3_endpoint: str = Field(default="", alias="S3_ENDPOINT")
    s3_access_key: str = Field(default="", alias="S3_ACCESS_KEY")
    s3_secret_key: str = Field(default="", alias="S3_SECRET_KEY")
    s3_bucket: str = Field(default="petro-radar", alias="S3_BUCKET")

    # ── Cron / endpoints protegidos por segredo (worker-triggered) ────────────
    cron_secret: str = Field(default="", alias="CRON_SECRET")

    # ── E-mail (SMTP relay corporativo; substitui Resend) ─────────────────────
    smtp_host: str = Field(default="", alias="SMTP_HOST")
    smtp_port: int = Field(default=587, alias="SMTP_PORT")
    smtp_user: str = Field(default="", alias="SMTP_USER")
    smtp_pass: str = Field(default="", alias="SMTP_PASS")
    smtp_secure: bool = Field(default=False, alias="SMTP_SECURE")
    from_email: str = Field(
        default="Petro Radar <no-reply@example.com>", alias="FROM_EMAIL"
    )

    # ── Observabilidade (WP09): Sentry/GlitchTip + métricas Prometheus ────────
    # Lidos por app/core/observability.py. Sem DSN o Sentry fica desligado;
    # metrics_enabled controla o GET /metrics.
    sentry_dsn: str = Field(default="", alias="SENTRY_DSN")
    sentry_environment: str = Field(default="onprem", alias="SENTRY_ENVIRONMENT")
    sentry_traces_sample_rate: float = Field(
        default=0.0, alias="SENTRY_TRACES_SAMPLE_RATE"
    )
    metrics_enabled: bool = Field(default=True, alias="METRICS_ENABLED")

    # ── Budget de IA (G4): teto diário de tokens Anthropic (0 = ilimitado) ─────
    ia_budget_tokens_daily: int = Field(default=0, alias="IA_BUDGET_TOKENS_DAILY")

    # ── Hardening de sessão (Decisão 4): revogação de JWT (jti) no Redis ──────
    # redis_revocation_url vazio => usa redis_url (ver app/core/revocation.py).
    redis_revocation_url: str = Field(default="", alias="REDIS_REVOCATION_URL")
    jwt_revocation_ttl_seconds: int = Field(
        # 9h = maxAge 8h + 1h de folga p/ clock-skew (a denylist NUNCA pode
        # expirar antes do token). O revocation.py aplica piso de 9h de qualquer
        # forma; alinhado aqui p/ o default bater com o piso.
        default=32400, alias="JWT_REVOCATION_TTL_SECONDS"
    )

    # ── RAG / Acervo (config tipada; espelha config.ts; os.environ é fallback) ─
    feature_acervo_rag: bool = Field(default=True, alias="FEATURE_ACERVO_RAG")
    acervo_top_k: int = Field(default=8, alias="ACERVO_TOP_K")
    acervo_similaridade_min: float = Field(default=0.35, alias="ACERVO_SIMILARIDADE_MIN")
    # Candidatos por braço da busca híbrida antes da fusão RRF, e teto de
    # exploração do grafo HNSW. O ef_search PRECISA ser >= candidatos: abaixo
    # disso o pgvector trunca o braço vetorial em silêncio (medido: com o
    # default 40, um LIMIT 200 devolvia as mesmas ~44 linhas de um LIMIT 60).
    acervo_candidatos: int = Field(default=120, alias="ACERVO_CANDIDATOS")
    acervo_ef_search: int = Field(default=400, alias="ACERVO_EF_SEARCH")
    # Orçamento de custo do braço AMPLO da busca, em chunks varridos
    # (migração 0039). Calibrado para dezenas de milhares de chunks; recalibrar se o acervo
    # mudar de tamanho — 16k afoga o identificador, 10k perde semântica.
    acervo_orcamento_ampla: int = Field(default=12000, alias="ACERVO_ORCAMENTO_AMPLA")

    # ── Espelhos de process.env dos routers migrados (D5a) ────────────────────
    # Antes lidos com ``os.environ`` direto nos routers, contrariando o contrato
    # deste módulo. IMPORTANTE: os campos de FLAG/NUM ficam como ``str`` cru
    # (default "" = ausente) porque os routers os interpretam com os helpers
    # paritários ``flag()``/``num()`` de ``src/lib/config.ts`` (Next): "true"/"1"
    # → ligado, QUALQUER outro valor → desligado; não-numérico → fallback. Um
    # campo ``bool``/``int`` do pydantic mudaria a coerção (ex.: "yes" viraria
    # True e "banana" derrubaria o boot) — quebraria a paridade byte-a-byte.
    #
    # config.proponente.cnpj: NEXT_PUBLIC_PROPONENTE_CNPJ ?? "11222333000181".
    proponente_cnpj: str = Field(
        default="11222333000181", alias="NEXT_PUBLIC_PROPONENTE_CNPJ"
    )
    # baseUrl dos templates de e-mail (templates.ts): NEXTAUTH_URL ?? localhost.
    nextauth_url: str = Field(default="", alias="NEXTAUTH_URL")
    # cron_sync_monitor: GITHUB_REPOSITORY ?? "org/repo".
    github_repository: str = Field(default="", alias="GITHUB_REPOSITORY")
    # auth_setup: NODE_ENV == "production" gate + SETUP_TOKEN do primeiro admin.
    node_env: str = Field(default="", alias="NODE_ENV")
    setup_token: str = Field(default="", alias="SETUP_TOKEN")
    # Feature flags do Next (flag(env, false) — RAW, ver nota acima).
    feature_resultados: str = Field(
        default="", alias="NEXT_PUBLIC_FEATURE_RESULTADOS"
    )
    # FEATURE_ACERVO_RAG cru p/ o gate paritário flag(env, true) do
    # cron_acervo_index (o campo bool ``feature_acervo_rag`` acima continua
    # existindo p/ acervo_buscar; ambos leem a MESMA env por alias).
    feature_acervo_rag_raw: str = Field(default="", alias="FEATURE_ACERVO_RAG")
    # Crons — flags/limiares (config.crons.* / config.acervo.* do config.ts).
    cron_relatorio_mensal_enabled: str = Field(
        default="", alias="CRON_RELATORIO_MENSAL_ENABLED"
    )
    cron_digest_executivo_enabled: str = Field(
        default="", alias="CRON_DIGEST_EXECUTIVO_ENABLED"
    )
    cron_convocacao_watch_enabled: str = Field(
        default="", alias="CRON_CONVOCACAO_WATCH_ENABLED"
    )
    cron_convocacao_posicao_min: str = Field(
        default="", alias="CRON_CONVOCACAO_POSICAO_MIN"
    )
    cron_triagem_enabled: str = Field(default="", alias="CRON_TRIAGEM_ENABLED")
    cron_triagem_lote: str = Field(default="", alias="CRON_TRIAGEM_LOTE")
    cron_triagem_max_chars: str = Field(default="", alias="CRON_TRIAGEM_MAX_CHARS")
    cron_triagem_score_alto: str = Field(default="", alias="CRON_TRIAGEM_SCORE_ALTO")
    cron_acervo_index_enabled: str = Field(
        default="", alias="CRON_ACERVO_INDEX_ENABLED"
    )
    acervo_chunk_tamanho: str = Field(default="", alias="ACERVO_CHUNK_TAMANHO")
    acervo_chunk_overlap: str = Field(default="", alias="ACERVO_CHUNK_OVERLAP")
    acervo_budget_fontes: str = Field(default="", alias="ACERVO_BUDGET_FONTES")
    acervo_budget_chunks: str = Field(default="", alias="ACERVO_BUDGET_CHUNKS")

    # ── CORS (origens de navegador permitidas) ────────────────────────────────
    # Parametrizável 100% por env ``CORS_ORIGINS`` (lista separada por VÍRGULA,
    # ex.: "http://localhost:3000,https://radar.interno"); também aceita lista.
    # O ``main.py`` passa esta lista EXATA para o CORSMiddleware com
    # ``allow_credentials=True`` — por isso NÃO há default permissivo ("*"):
    # curinga + credenciais é bloqueado pelo browser e inseguro. O default abaixo
    # (localhost:3000) é APENAS conveniência de DEV; em PRODUÇÃO defina
    # ``CORS_ORIGINS`` com a(s) origem(ns) real(is) do front (domínio interno
    # servido pelo NGINX). Ver ``_split_cors`` (parser CSV) e
    # ``.env.onprem.example`` (seção "CORS do BFF").
    cors_origins: list[str] = Field(
        default=["http://localhost:3000"], alias="CORS_ORIGINS"
    )

    # ── Observabilidade ───────────────────────────────────────────────────────
    log_level: str = Field(default="info", alias="LOG_LEVEL")

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_cors(cls, valor: object) -> object:
        """Permite informar CORS_ORIGINS como string CSV no ``.env``."""
        if isinstance(valor, str):
            return [o.strip() for o in valor.split(",") if o.strip()]
        return valor

    @property
    def jwt_secret(self) -> str:
        """Segredo efetivo para validar o JWT.

        Replica a regra do app Next.js: usa ``AUTH_SECRET`` e, se vazio, cai
        para ``NEXTAUTH_SECRET``. Lança em runtime (no security.py) se ambos
        estiverem vazios.
        """
        return self.auth_secret or self.nextauth_secret

    @property
    def embeddings_url(self) -> str:
        """Alias compatível: base URL do servidor de embeddings local (TEI)."""
        return self.embedding_base_url


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Retorna a instância única de ``Settings`` (cacheada)."""
    return Settings()


# Singleton importável: `from app.core.config import settings`
settings: Settings = get_settings()
