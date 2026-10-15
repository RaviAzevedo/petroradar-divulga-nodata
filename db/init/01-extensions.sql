-- =============================================================================
-- Petro Radar — Init do PostgreSQL (roda 1x, no PRIMEIRO boot, volume vazio).
-- Diretorio: /docker-entrypoint-initdb.d/
-- =============================================================================
-- IMPORTANTE: este script roda ANTES das migrations Drizzle. Ele NAO cria
-- tabelas — apenas garante as extensoes. As 16 migrations (0000..0015) criam
-- as 52 tabelas e o indice HNSW idx_acervo_embedding (0014); a 0015 converte
-- acervo_chunks.embedding para vector(1024) (BGE-m3) e trunca os chunks.
--
-- Sequencia de bootstrap:
--   1) container 'db' sobe  -> ESTE script roda (CREATE EXTENSION vector)
--   2) `make migrate`       -> aplica 0000..0015 (tabelas + HNSW + vector(1024))
--   3) (opcional) restore do dump de producao (pg_restore)
-- =============================================================================

-- pgvector: tipo vector + operador de cosseno <=> + indice HNSW (RAG do acervo).
CREATE EXTENSION IF NOT EXISTS vector;

-- pgcrypto: gen_random_uuid() (PKs uuid) + ganchos de field-level encryption
-- (LGPD: ocr_texto, cnpj_status_log.dados_brutos, etc.). PG16 ja tem o uuid
-- built-in, mas manter por seguranca e para encrypt/decrypt opcionais.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- unaccent + pg_trgm (E12, migration 0017): busca com acentos/fuzzy. pg_trgm
-- alimenta os indices GIN trigram de licitacoes (numero/objeto/empresa) que
-- aceleram os ILIKE '%x%' da busca global; unaccent fica disponivel para a
-- evolucao de busca acento-insensivel. A 0017 tambem cria as extensoes
-- (IF NOT EXISTS) para bancos ja existentes; aqui garante nos clones frescos.
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- -----------------------------------------------------------------------------
-- NOTA sobre o indice vetorial (apenas referencia — NAO criar aqui):
--   A migration 0014 ja executa:
--     CREATE INDEX idx_acervo_embedding
--       ON acervo_chunks USING hnsw (embedding vector_cosine_ops);
--   Tuning sugerido (avaliar pelo volume real do acervo):
--     WITH (m = 16, ef_construction = 64);   -- no CREATE INDEX
--     SET hnsw.ef_search = 40;                -- por sessao, no retrieval
--   APLICAR via `make migrate` (migrations SQL), NUNCA via `drizzle-kit push`
--   (push nao modela hnsw -> RAG cairia para Seq Scan).
-- -----------------------------------------------------------------------------

-- Sanidade: registra as extensoes no log de init.
DO $$
BEGIN
  RAISE NOTICE 'Petro Radar init: extensoes vector e pgcrypto habilitadas.';
END $$;
