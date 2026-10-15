-- scripts/parity/00_check_extensions.sql (WP02 §11.2)
-- Confere que as extensões obrigatórias existem (vector p/ RAG, pgcrypto p/ hashes).
-- Uso: psql -tA -f scripts/parity/00_check_extensions.sql  (espera 'vector' e 'pgcrypto').
SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pgcrypto') ORDER BY extname;
