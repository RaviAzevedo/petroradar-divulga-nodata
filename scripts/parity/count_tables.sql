-- scripts/parity/count_tables.sql (WP02 §5.3 / §11.2)
-- Conta EXATA de todas as tabelas do schema public (paridade vs origin_counts.csv).
-- Gera dinamicamente um SELECT por tabela e executa via \gexec (psql).
-- Uso: psql -tA -F',' -f scripts/parity/count_tables.sql  > counts.csv
SELECT format('SELECT %L AS tabela, count(*) AS linhas FROM %I', tablename, tablename)
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename
\gexec
