-- =============================================================================
-- 0035 — Espelho de downloads de documento restrito
-- =============================================================================
-- O expurgo de 12 meses do audit_log continua; ESTA tabela não tem expurgo.
-- Sem FK para users/documentos de propósito: a linha precisa sobreviver à
-- exclusão do usuário e do documento (é prova, não relacionamento).
-- Gravada pelas rotas de download/ZIP ALÉM do audit_log normal.
-- Idempotente; fora do journal; padrão apply-extra-migrations.sh.
-- =============================================================================
CREATE TABLE IF NOT EXISTS audit_download_restrito (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  documento_id    uuid NOT NULL,
  titulo          text NOT NULL,          -- desnormalizado: sobrevive ao DELETE do documento
  operacao_codigo text,
  user_id         uuid NOT NULL,
  user_email      text NOT NULL,
  role            text NOT NULL,
  via             text NOT NULL,          -- 'DOWNLOAD' | 'ZIP_DOSSIE' | 'ZIP_SELECAO' | 'DOWNLOAD_ANEXO'
  criado_em       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_adr_documento ON audit_download_restrito (documento_id);
CREATE INDEX IF NOT EXISTS idx_adr_criado    ON audit_download_restrito (criado_em);

COMMENT ON TABLE audit_download_restrito IS
  'Espelho SEM EXPURGO dos downloads de documento restrito (P7/D-7). Desnormalizado de propósito: responde "quem baixou o contrato restrito" mesmo 12 meses depois.';
