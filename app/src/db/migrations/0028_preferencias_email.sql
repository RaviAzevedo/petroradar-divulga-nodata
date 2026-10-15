-- 0028_preferencias_email.sql
-- Preferências de e-mail POR TIPO e POR USUÁRIO — a matriz de /admin/emails.
--
-- Motivação (2026-07-13): os crons resolviam destinatário só por PAPEL, num
-- broadcast sem escape — todo ADMIN recebia todo alerta de sistema, todo
-- ADMIN/LIDER recebia todo digest. Não havia como um usuário sair de um tipo
-- sem perder o papel. Esta tabela dá esse controle ao admin.
--
-- SEMÂNTICA — SUBTRATIVA (decisão do dono):
--   • O papel continua sendo o GATE: quem não tem o papel do tipo NUNCA recebe,
--     mesmo com a preferência ligada. A matriz só DESLIGA.
--   • AUSÊNCIA DE LINHA = HABILITADO. É o que preserva o comportamento atual:
--     ninguém deixa de receber sem uma ação explícita do admin. Por isso os
--     crons fazem LEFT JOIN + (habilitado IS NULL OR habilitado = true) — um
--     INNER JOIN silenciaria todo mundo que nunca foi tocado na tela.
--
-- Catálogo dos 13 tipos: app/src/lib/email/tipos.ts (FONTE ÚNICA DE VERDADE —
-- alterou lá, altera o CHECK aqui no MESMO commit).
-- O digest de licitações por filtro (0026) NÃO entra aqui: já é opt-in por
-- assinatura (assinaturas_email).
--
-- Idempotente (IF NOT EXISTS), no padrão das migrations 0019+ — aplicar via
-- psql no on-prem (fora do journal do migrator Drizzle, como as pós-0018).

CREATE TABLE IF NOT EXISTS preferencias_email (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tipo          text NOT NULL,
  habilitado    boolean NOT NULL DEFAULT true,
  criado_em     timestamptz DEFAULT now(),
  atualizado_em timestamptz DEFAULT now(),
  CONSTRAINT preferencias_email_tipo_check CHECK (tipo IN (
    'PRAZO_PORTAL',
    'PRAZO_INTERNO',
    'PRAZO_CRITICO_LICITACAO',
    'CIRCULAR_PUBLICADA',
    'CONVOCACAO_REMANESCENTE',
    'VENCIMENTO_DOCUMENTO',
    'VENCIMENTO_FAMILIA',
    'ENVELOPE_INCOMPLETO',
    'CONTRATO_CRITICO',
    'CNPJ_SITUACAO',
    'DIGEST_EXECUTIVO',
    'RELATORIO_MENSAL',
    'SYNC_FALHOU'
  ))
);

-- Chave natural: 1 linha por (usuário, tipo). É o alvo do ON CONFLICT do upsert
-- e o índice que serve o LEFT JOIN dos crons.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pref_email_user_tipo
  ON preferencias_email (user_id, tipo);
CREATE INDEX IF NOT EXISTS idx_pref_email_user ON preferencias_email (user_id);

COMMENT ON TABLE preferencias_email IS
  'Quais tipos de e-mail cada usuário recebe (0028). Subtrativa: o papel é o gate, isto só desliga. Ausência de linha = habilitado.';
COMMENT ON COLUMN preferencias_email.tipo IS
  'Chave do catálogo em app/src/lib/email/tipos.ts (13 tipos, 1:1 com os templates).';
