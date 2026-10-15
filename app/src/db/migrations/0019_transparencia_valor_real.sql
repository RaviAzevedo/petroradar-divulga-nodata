-- 0019_transparencia_valor_real.sql
-- Valor REAL de contratos vindos do Portal da Transparência Petrobras.
--
-- Em disputas de modalidade FECHADA o Petronect publica apenas valores
-- SIMBÓLICOS de ranking (centavos — ex.: R$ 0,94); o valor real é sigiloso.
-- Após a assinatura, porém, o contrato aparece no Portal da Transparência
-- (Lei 13.303) com o valor real e com COTR_CD_PROCESSO = nº da licitação
-- Petronect (join direto, conferido ao vivo: o processo leva ao contrato e ao
-- valor homologado).
--
-- O cron transparencia-valores (worker, Playwright) enriquece resultados
-- Homologados/Adjudicados com valor simbólico/ausente. Colunas NULLáveis —
-- zero impacto em dados existentes.

ALTER TABLE resultados_licitacao
  ADD COLUMN IF NOT EXISTS valor_contrato_real       numeric(18,2),
  ADD COLUMN IF NOT EXISTS contrato_transparencia    text,
  ADD COLUMN IF NOT EXISTS contrato_vigencia_fim     text,
  ADD COLUMN IF NOT EXISTS transparencia_checado_em  timestamptz;

COMMENT ON COLUMN resultados_licitacao.valor_contrato_real      IS 'Valor real do contrato (Portal da Transparência Petrobras); preenche o vazio dos valores simbólicos de disputa fechada';
COMMENT ON COLUMN resultados_licitacao.contrato_transparencia   IS 'Código do contrato na Transparência (COTR_CD_CONTRATO)';
COMMENT ON COLUMN resultados_licitacao.contrato_vigencia_fim    IS 'Fim de vigência do contrato (ISO YYYY-MM-DD)';
COMMENT ON COLUMN resultados_licitacao.transparencia_checado_em IS 'Última consulta à Transparência (evita re-consulta; recheck após 7 dias quando não encontrado)';
