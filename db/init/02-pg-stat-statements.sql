-- =============================================================================
-- Petro Radar — pg_stat_statements (D2). Roda 1x no PRIMEIRO boot (volume vazio).
-- =============================================================================
-- A biblioteca ja e pre-carregada pelo compose (command: do servico db passa
-- -c shared_preload_libraries=pg_stat_statements -c pg_stat_statements.track=top);
-- este init apenas cria a EXTENSAO (a view pg_stat_statements) no database.
--
-- Em bancos JA EXISTENTES (volume populado, init nao roda), aplicar manualmente:
--   docker compose exec db psql -U petro -d petro_radar \
--     -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;"
--
-- Diagnostico de queries lentas (top 10 por tempo total):
--   SELECT calls, round(total_exec_time)::bigint AS ms, rows, query
--     FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;
-- Zerar contadores: SELECT pg_stat_statements_reset();
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

DO $$
BEGIN
  RAISE NOTICE 'Petro Radar init: extensao pg_stat_statements habilitada.';
END $$;
