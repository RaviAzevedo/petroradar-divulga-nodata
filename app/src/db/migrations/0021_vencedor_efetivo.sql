-- 0021_vencedor_efetivo.sql
-- Colunas GERADAS que unificam a visão "efetiva" de vencedor e valor,
-- combinando a coleta Petronect com o backfill do Portal da Transparência
-- (migrations 0019/0020). A inteligência competitiva consome ESTAS colunas:
--
--   cnpj_vencedor_efetivo       = COALESCE(cnpj_vencedor, contrato_cnpj)
--   fornecedor_vencedor_efetivo = COALESCE(fornecedor_vencedor, contrato_fornecedor)
--   valor_efetivo               = valor do contrato REAL, senão valor_vencedor
--                                 não-simbólico (>= R$ 100), senão menor_valor
--                                 não-simbólico. NULL quando só há simbólico/ranking.
--
-- GENERATED ALWAYS ... STORED: recalcula sozinho quando a coleta ou o cron da
-- Transparência atualizam as colunas-base — nenhum writer precisa conhecê-las.

ALTER TABLE resultados_licitacao
  ADD COLUMN IF NOT EXISTS cnpj_vencedor_efetivo text
    GENERATED ALWAYS AS (COALESCE(cnpj_vencedor, contrato_cnpj)) STORED,
  ADD COLUMN IF NOT EXISTS fornecedor_vencedor_efetivo text
    GENERATED ALWAYS AS (COALESCE(fornecedor_vencedor, contrato_fornecedor)) STORED,
  ADD COLUMN IF NOT EXISTS valor_efetivo numeric(18,2)
    GENERATED ALWAYS AS (
      COALESCE(
        valor_contrato_real,
        CASE WHEN valor_vencedor >= 100 THEN valor_vencedor END,
        CASE WHEN menor_valor    >= 100 THEN menor_valor    END
      )
    ) STORED;

CREATE INDEX IF NOT EXISTS idx_res_vencedor_efetivo
  ON resultados_licitacao (cnpj_vencedor_efetivo);

COMMENT ON COLUMN resultados_licitacao.cnpj_vencedor_efetivo       IS 'Vencedor unificado: Petronect, senão contrato da Transparência';
COMMENT ON COLUMN resultados_licitacao.fornecedor_vencedor_efetivo IS 'Nome do vencedor unificado (Petronect > Transparência)';
COMMENT ON COLUMN resultados_licitacao.valor_efetivo               IS 'Valor monetário real: contrato > valor_vencedor não-simbólico > menor_valor não-simbólico';
