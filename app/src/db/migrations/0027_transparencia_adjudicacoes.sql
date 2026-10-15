-- 0027_transparencia_adjudicacoes.sql
-- Prospecção de PARCERIAS: quem GANHOU licitações da Petrobras recentemente.
--
-- Os sweeps existentes olham para FRENTE (contratos vencendo → onda de
-- renovação). Este olha para TRÁS: contrato assinado = licitação já vencida, e
-- o fornecedor é o vencedor. Alvo: vencedores de EPC e obra que podem precisar
-- de um parceiro de projeto/engenharia.
--
-- Alimentado pelo modo "adjudicacoes" do worker (transparencia_sweep.py), que
-- varre o filtro InicioDaVigencia_de/ate do portal (server-side, confirmado ao
-- vivo em 2026-07-09: janela 3m=45.137, 6m=86.029, futura=7 → monotônico).
--
-- Colunas novas em transparencia_contratos (a tabela já existe — migration 0022;
-- reusada de propósito, `origem='adjudicacao'` distingue a procedência):
--   • data_log_inclusao — DataLogInclusao do portal: quando o contrato APARECEU.
--     É o sinal honesto de "recém-adjudicado" (fica 1..8 dias depois do início
--     da vigência). vigencia_inicio pode ser retroativo.
--   • patrocinio        — COTR_IN_PATROCINIO: flag NATIVA do portal. Substitui o
--     regex `^(patrocínio|convênio|doação)` para descartar ruído.
--   • papel_vencedor    — construtora | projetista | hibrido | desconhecido.
--     v1 é heurística sobre a RAZÃO SOCIAL (custo zero, já vem no payload).
--     COSTURA: dá para trocar por CNAE (BrasilAPI, grátis — mesma fonte de
--     /api/cron/cnpj-watch) sem migration nova. CNAE principal div. 41/42 =
--     construtora; 711x = projetista. Cuidado: quase toda construtora registra
--     7112-0 como CNAE SECUNDÁRIO, então o peso tem de ficar no principal.
--   • classificacao_ia  — jsonb {v, fonte, tipo_escopo, contem_engenharia, fit}.
--     `fonte='regex'` hoje; um classificador LLM pode sobrescrever com
--     `fonte='llm'` sem mudar o schema.
--
-- Idempotente (IF NOT EXISTS), fora do journal do migrator Drizzle, no padrão
-- das migrations 0019+ — aplicar via psql:
--   docker compose exec -T db psql -U petro -d petro_radar \
--     -f /app/src/db/migrations/0027_transparencia_adjudicacoes.sql

ALTER TABLE transparencia_contratos
  ADD COLUMN IF NOT EXISTS data_log_inclusao text,
  ADD COLUMN IF NOT EXISTS patrocinio        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS papel_vencedor    text,
  ADD COLUMN IF NOT EXISTS classificacao_ia  jsonb;

-- A fila de vencedores ordena/filtra por início de vigência decrescente.
-- vigencia_inicio é TEXT em ISO (YYYY-MM-DD) — ordem lexicográfica == cronológica,
-- então o índice B-tree simples serve sem cast.
CREATE INDEX IF NOT EXISTS idx_tc_vigencia_inicio
  ON transparencia_contratos (vigencia_inicio DESC);

-- Recorte quente da consulta de adjudicações recentes.
CREATE INDEX IF NOT EXISTS idx_tc_origem_inicio
  ON transparencia_contratos (origem, vigencia_inicio DESC);

-- Só LICITAÇÃO/PREGÃO são "licitação ganha" (DISPENSA/INEXIGIBILIDADE/CONVÊNIO
-- são adjudicação direta). O portal não filtra modalidade server-side
-- (EnquadramentoDoProcesso só aceita 0), então o corte é nosso.
CREATE INDEX IF NOT EXISTS idx_tc_modalidade
  ON transparencia_contratos (modalidade);
