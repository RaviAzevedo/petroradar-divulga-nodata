-- 0023_transparencia_licitacoes.sql
-- Descoberta SUPLEMENTAR de licitações via módulo Licitações do Portal da
-- Transparência Petrobras (Lei 13.303). O scraper Petronect só enxerga o que o
-- perfil de coleta capturou; o Portal publica o UNIVERSO de licitações das 5
-- empresas (matriz + subsidiárias). Esta tabela é o espelho desse universo,
-- alimentada por um sweep semanal do worker (transparencia_licitacoes_job) que
-- baixa o EXPORT XLSX da consulta (todas as linhas do filtro de uma vez).
--
-- `no_banco` marca se a licitação também existe na nossa tabela `licitacoes`
-- (join por numero). no_banco = false => LACUNA de cobertura: o portal tem, o
-- scraper não coletou. Alimenta a superfície "Cobertura Petronect".

CREATE TABLE IF NOT EXISTS transparencia_licitacoes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  numero           text NOT NULL UNIQUE,    -- LITR_CD_LICITACAO (= nº Petronect 7004xxxxxx)
  processo         text,                     -- LITR_CD_PROCESSO
  objeto           text,                     -- LITR_DS_OBJETO (truncado ~40 chars na fonte)
  cidade           text,                     -- cidade de abertura
  uf               text,
  situacao         text,                     -- Em andamento / Concluído / ...
  modalidade       text,                     -- Enquadramento do processo (Lei 13.303 ...)
  data_abertura    text,                     -- ISO YYYY-MM-DD
  data_publicacao  text,                     -- ISO YYYY-MM-DD
  tem_contratos    boolean NOT NULL DEFAULT false,  -- há contrato(s) já assinado(s) para a licitação
  orgao            text,                     -- unidade administrativa (empresa)
  no_banco         boolean NOT NULL DEFAULT false,  -- EXISTS em licitacoes.numero
  capturado_em     timestamptz DEFAULT now(),
  atualizado_em    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tl_numero          ON transparencia_licitacoes (numero);
CREATE INDEX IF NOT EXISTS idx_tl_no_banco        ON transparencia_licitacoes (no_banco);
CREATE INDEX IF NOT EXISTS idx_tl_data_publicacao ON transparencia_licitacoes (data_publicacao);

COMMENT ON TABLE transparencia_licitacoes IS 'Universo de licitações do Portal da Transparência Petrobras (sweep semanal) — descoberta suplementar + superfície de cobertura (lacuna do scraper Petronect via no_banco)';
