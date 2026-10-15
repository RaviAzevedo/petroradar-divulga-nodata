-- scripts/parity/02_check_hnsw.sql (WP02 §11.2)
-- Valida que acervo_chunks.embedding é vector(1024) (Decisão 1: BGE-m3) e que há
-- um índice HNSW sobre ela. Uso: psql -f scripts/parity/02_check_hnsw.sql
-- Aceite: dim_typmod = 1024 (typmod = dim+4 no pgvector => 1028) e 1+ índice hnsw.
SELECT
  format_type(a.atttypid, a.atttypmod) AS tipo_embedding   -- esperado: vector(1024)
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
WHERE c.relname = 'acervo_chunks' AND a.attname = 'embedding';

SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'acervo_chunks' AND indexdef ILIKE '%hnsw%';
