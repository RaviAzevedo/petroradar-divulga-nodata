-- 0022_transparencia_contratos.sql
-- Repositório próprio dos contratos do Portal da Transparência (Fase 2).
--
-- Até aqui os dados da Transparência viviam em colunas de resultados_licitacao
-- (apenas contratos LIGADOS a licitações coletadas pelo scraper). Esta tabela
-- guarda o universo maior, alimentada por 2 sweeps semanais do worker:
--   • cnpj-sweep  (F3): histórico ALL-TIME por CNPJ de interesse (vencedores
--     efetivos da base + Proponente) → market share, série histórica, unidades.
--   • objeto-sweep (F4): termos de engenharia com vencimento próximo → universo
--     de renovações de QUALQUER fornecedor (prospecção pré-licitação).

CREATE TABLE IF NOT EXISTS transparencia_contratos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contrato_cd      text NOT NULL UNIQUE,   -- COTR_CD_CONTRATO
  processo         text,                   -- COTR_CD_PROCESSO = nº licitação Petronect
  cnpj             text,                   -- só dígitos
  fornecedor       text,
  objeto           text,
  valor            numeric(18,2),
  moeda            text,
  situacao         text,                   -- Ativo / Concluído / Cancelado
  modalidade       text,
  unidade          text,                   -- unidade administrativa (geografia)
  orgao_superior   text,
  vigencia_inicio  text,                   -- ISO YYYY-MM-DD
  vigencia_fim     text,                   -- ISO YYYY-MM-DD
  aditivos_qtd     integer,
  fundamento_legal text,
  instrumento      text,
  origem           text NOT NULL DEFAULT 'cnpj-sweep',  -- cnpj-sweep | objeto-sweep
  aderencia        integer DEFAULT 0,      -- 1 = casa regex O&G/industrial (prospecção)
  segmento_estimado text,                  -- classificador do radar-contratos
  capturado_em     timestamptz DEFAULT now(),
  atualizado_em    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tc_cnpj          ON transparencia_contratos (cnpj);
CREATE INDEX IF NOT EXISTS idx_tc_vigencia_fim  ON transparencia_contratos (vigencia_fim);
CREATE INDEX IF NOT EXISTS idx_tc_processo      ON transparencia_contratos (processo);
CREATE INDEX IF NOT EXISTS idx_tc_origem        ON transparencia_contratos (origem);

COMMENT ON TABLE transparencia_contratos IS 'Contratos do Portal da Transparência Petrobras (sweeps semanais do worker) — histórico all-time por CNPJ + universo de prospecção por objeto';
