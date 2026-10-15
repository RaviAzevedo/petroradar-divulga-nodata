-- 0026_digest_email.sql
-- Digest de e-mail de licitações.
--
-- Gestores assinam FILTROS DE E-MAIL (entidade PRÓPRIA, independente dos
-- perfis_interesse do sistema — decisão do dono 2026-07-08) e recebem e-mail
-- com as licitações novas que casam, com link p/ a plataforma (o Briefing e o
-- Checklist são gerados EXCLUSIVAMENTE na plataforma — o e-mail só avisa).
--   • filtros_email — o filtro em si: criterios jsonb avaliado em SQL puro na
--     hora do envio (keywords_incluir/excluir, naturezas, tipos_servico,
--     segmentos, estados, min_relevancia ALTA|MEDIA|TODAS); {} = todas;
--   • assinaturas_email — quem recebe qual filtro, formato resumido|completo,
--     frequencia tempo-real|diario|semanal, ativo, último envio;
--   • assinaturas_email_envios — ledger de dedup POR ASSINANTE: cada
--     (assinatura, licitação) é enviada UMA vez (ON CONFLICT DO NOTHING).
--     NÃO reusar licitacoes.notificado_perfil_em (marca GLOBAL do broadcast
--     webhook/push — sem dimensão de destinatário).
--
-- Idempotente (IF NOT EXISTS), no padrão das migrations 0019+ — aplicar via
-- psql no on-prem (fora do journal do migrator Drizzle, como as pós-0018).

CREATE TABLE IF NOT EXISTS filtros_email (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome          text NOT NULL,                 -- ex.: "Engenharia", "Manutenção", "Todas"
  descricao     text,
  criterios     jsonb NOT NULL DEFAULT '{}',   -- todos opcionais; {} = todas as novas
  ativo         boolean NOT NULL DEFAULT true,
  criado_em     timestamptz DEFAULT now(),
  atualizado_em timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_filtros_email_nome ON filtros_email (nome);

CREATE TABLE IF NOT EXISTS assinaturas_email (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  filtro_id       uuid NOT NULL REFERENCES filtros_email(id) ON DELETE CASCADE,
  formato         text NOT NULL DEFAULT 'resumido',
  frequencia      text NOT NULL DEFAULT 'diario',
  ativo           boolean NOT NULL DEFAULT true,
  ultimo_envio_em timestamptz,
  criado_em       timestamptz DEFAULT now(),
  CONSTRAINT assinaturas_email_formato_check
    CHECK (formato IN ('resumido','completo')),
  CONSTRAINT assinaturas_email_frequencia_check
    CHECK (frequencia IN ('tempo-real','diario','semanal'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ass_email_user_filtro
  ON assinaturas_email (user_id, filtro_id);
CREATE INDEX IF NOT EXISTS idx_ass_email_filtro ON assinaturas_email (filtro_id);

CREATE TABLE IF NOT EXISTS assinaturas_email_envios (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assinatura_id uuid NOT NULL REFERENCES assinaturas_email(id) ON DELETE CASCADE,
  licitacao_id  uuid NOT NULL REFERENCES licitacoes(id)        ON DELETE CASCADE,
  enviado_em    timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ass_envio
  ON assinaturas_email_envios (assinatura_id, licitacao_id);

COMMENT ON TABLE filtros_email IS
  'Filtros do digest de e-mail — entidade própria, independente de perfis_interesse (0026)';
COMMENT ON TABLE assinaturas_email IS
  'Assinaturas do digest: quem recebe qual filtro, formato e frequência (0026)';
COMMENT ON TABLE assinaturas_email_envios IS
  'Ledger de dedup por assinante: cada (assinatura, licitação) enviada 1x (0026)';
