-- 0015_acervo_bge_m3_1024.sql
-- Migra os embeddings do acervo de Voyage/OpenAI (1536) para BGE-m3 local (1024).
-- DESTRUTIVO: vetores 1536 não convertem para 1024 -> re-embed obrigatório.
-- Roda em transação (migrator node-postgres); se falhar no meio => rollback total.

-- 1. Remover o índice HNSW (atrelado à dimensão 1536).
DROP INDEX IF EXISTS idx_acervo_embedding;--> statement-breakpoint

-- 2. Limpar chunks e log de idempotência (força reindexação completa).
TRUNCATE acervo_chunks;--> statement-breakpoint
TRUNCATE acervo_index_log;--> statement-breakpoint

-- 3. Alterar o tipo da coluna para vector(1024).
ALTER TABLE acervo_chunks ALTER COLUMN embedding TYPE vector(1024);--> statement-breakpoint

-- 4. Recriar o índice HNSW (cosine) na nova dimensão.
CREATE INDEX idx_acervo_embedding ON acervo_chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
