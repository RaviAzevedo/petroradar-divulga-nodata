-- 0020_transparencia_vencedor_backfill.sql
-- Backfill de VENCEDOR + metadados do contrato vindos do Portal da Transparência.
--
-- O primeiro backfill (migration 0019) revelou que quase todos os contratos
-- encontrados eram "invisíveis": a coleta Petronect os tinha como "Aguardando
-- definição" SEM vencedor. A resposta da Transparência traz o vencedor
-- (COTR_NM_FORNECEDOR/COTR_CD_CNPJ_CPF) e metadados úteis do contrato — esta
-- migration cria as colunas para persisti-los SEM conflitar com os campos
-- do Petronect (cnpj_vencedor/fornecedor_vencedor seguem exclusivos da coleta;
-- a UI usa contrato_* como fallback rotulado "Transparência").

ALTER TABLE resultados_licitacao
  ADD COLUMN IF NOT EXISTS contrato_fornecedor      text,
  ADD COLUMN IF NOT EXISTS contrato_cnpj            text,
  ADD COLUMN IF NOT EXISTS contrato_situacao        text,
  ADD COLUMN IF NOT EXISTS contrato_aditivos        integer,
  ADD COLUMN IF NOT EXISTS contrato_moeda           text,
  ADD COLUMN IF NOT EXISTS contrato_vigencia_inicio text,
  ADD COLUMN IF NOT EXISTS contrato_dados           jsonb;

COMMENT ON COLUMN resultados_licitacao.contrato_fornecedor      IS 'Vencedor segundo o contrato na Transparência (fallback quando a coleta Petronect não capturou)';
COMMENT ON COLUMN resultados_licitacao.contrato_cnpj            IS 'CNPJ do vencedor (só dígitos) segundo a Transparência';
COMMENT ON COLUMN resultados_licitacao.contrato_situacao        IS 'Situação do contrato (Ativo/Concluído/Cancelado)';
COMMENT ON COLUMN resultados_licitacao.contrato_aditivos        IS 'Quantidade de aditivos do contrato';
COMMENT ON COLUMN resultados_licitacao.contrato_moeda           IS 'Moeda do valor do contrato (R$/US$)';
COMMENT ON COLUMN resultados_licitacao.contrato_vigencia_inicio IS 'Início de vigência (ISO YYYY-MM-DD)';
COMMENT ON COLUMN resultados_licitacao.contrato_dados           IS 'Extras da Transparência: objeto do contrato, unidade administrativa, modalidade, instrumento jurídico, fundamento legal';
