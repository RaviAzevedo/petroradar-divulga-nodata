-- 0025_sso_entra_id.sql
-- Login SSO Microsoft 365 (Entra ID).
--
-- O login passa a ser feito pela conta corporativa Microsoft (tenant Proponente);
-- o login local por senha vira break-glass (AUTH_BREAKGLASS=1). Mudanças:
--   • password_hash vira NULLABLE — usuários só-SSO não têm senha local;
--   • entra_oid — claim `oid` do Entra ID (imutável; e-mail pode mudar, oid não).
--     UNIQUE via índice (Postgres permite múltiplos NULLs);
--   • pendente — fila de aprovação: conta do tenant que autenticou mas ainda
--     não foi liberada pelo ADMIN (ativo=false + pendente=true). Aprovar seta
--     ativo=true + pendente=false; recusar remove a linha;
--   • ultimo_login — visibilidade operacional no Admin Center.
--
-- Idempotente (IF NOT EXISTS / DROP NOT NULL é no-op se já aplicado), no padrão
-- das migrations 0019+ — aplicar via psql no on-prem (não está no journal do
-- migrator Drizzle, como as demais pós-0018).

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS entra_oid text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_entra_oid ON users (entra_oid);

ALTER TABLE users ADD COLUMN IF NOT EXISTS pendente boolean NOT NULL DEFAULT false;

ALTER TABLE users ADD COLUMN IF NOT EXISTS ultimo_login timestamptz;
