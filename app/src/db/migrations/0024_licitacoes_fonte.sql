-- 0024_licitacoes_fonte.sql
-- Origem da licitação: coletada NATIVAMENTE pelo scraper Petronect ('petronect',
-- o default e o caso de todas as linhas existentes) OU DESCOBERTA no Portal da
-- Transparência e ingerida ('transparencia' — dados finos: objeto ~40ch, sem
-- valor/itens/anexos). Permite:
--   • diferenciar as duas fontes no Explorar (pin/badge);
--   • a Cobertura Petronect medir cobertura NATIVA (fonte='petronect'), de modo
--     que ingerir as descobertas NÃO zere a lacuna;
--   • o sync promover 'transparencia' → 'petronect' quando o scraper enfim
--     coletar a licitação nativamente.

ALTER TABLE licitacoes
  ADD COLUMN IF NOT EXISTS fonte text NOT NULL DEFAULT 'petronect';

CREATE INDEX IF NOT EXISTS idx_lic_fonte ON licitacoes (fonte);

COMMENT ON COLUMN licitacoes.fonte IS 'petronect (scraper nativo) | transparencia (descoberta no Portal da Transparência e ingerida)';
