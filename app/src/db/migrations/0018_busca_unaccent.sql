-- 0018_busca_unaccent.sql
-- Busca acento-insensível (E12 — plano de melhorias 07/2026). 100% IDEMPOTENTE
-- (OR REPLACE / IF NOT EXISTS): rodar N vezes produz o mesmo estado, sem erro.
-- Roda em TRANSAÇÃO no migrator node-postgres (falha => rollback total);
-- também aplicável via psql.
--
-- Problema: a busca global usa ILIKE literal — "valvula" NÃO encontra
-- "válvula" (a forma sem acento devolve zero linhas). As extensões unaccent +
-- pg_trgm e os índices GIN trigram das colunas cruas já existem (migration
-- 0017, seção 8); esta migration adiciona a camada acento-insensível.
--
-- Conteúdo:
--   1. f_unaccent(text): wrapper IMUTÁVEL do unaccent (o unaccent nativo é só
--      STABLE porque depende de search_path — imutabilidade é pré-requisito
--      para índice de expressão). Corpo schema-qualified (public.unaccent +
--      'public.unaccent'::regdictionary) => à prova de search_path. STRICT:
--      NULL entra, NULL sai (mesma semântica do ILIKE em coluna NULL).
--   2. Índices de expressão GIN trigram f_unaccent(col) nas MESMAS 3 colunas
--      de licitacoes indexadas na 0017 (numero/objeto/empresa) — são as que
--      /api/licitacoes/search consulta. Suportam o WHERE
--      `f_unaccent(col) ILIKE f_unaccent('%termo%')` e o ranking
--      `similarity(f_unaccent(col), f_unaccent('termo'))` da flag SEARCH_TRGM
--      (route.ts do Next + espelho BFF licitacoes_search.py).
--      participacoes_licitacao (a 2ª query da mesma rota) segue SEM índice,
--      como na 0017: tabela do pipeline interno com dezenas de linhas — seq
--      scan barato; criar espelhos idx_part_*_unaccent_trgm se crescer.
--
-- A flag SEARCH_TRGM (default OFF) é quem liga o novo SQL; com a flag OFF o
-- comportamento byte-a-byte atual fica intacto e estes índices ficam ociosos.

-- ── 1) Wrapper imutável do unaccent ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION f_unaccent(text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;--> statement-breakpoint

-- ── 2) Índices de expressão GIN trigram (mesmas 3 colunas da 0017) ───────────
CREATE INDEX IF NOT EXISTS idx_lic_numero_unaccent_trgm
  ON licitacoes USING gin (f_unaccent(numero) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lic_objeto_unaccent_trgm
  ON licitacoes USING gin (f_unaccent(objeto) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lic_empresa_unaccent_trgm
  ON licitacoes USING gin (f_unaccent(empresa) gin_trgm_ops);
