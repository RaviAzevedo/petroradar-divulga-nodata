-- 0017_db_hardening_consolidado.sql
-- Hardening consolidado do banco (plano de melhorias 07/2026). 100% IDEMPOTENTE:
-- toda instrução tem guarda (IF EXISTS / IF NOT EXISTS / DO $$ / WHERE) — rodar
-- N vezes produz o mesmo estado, sem erro. Roda em TRANSAÇÃO no migrator
-- node-postgres (falha no meio => rollback total); também aplicável via psql.
--
-- Conteúdo:
--   1. UNIQUE de verdade em idx_alerta_unique / idx_docfam_unique — foram criados
--      como index comuns (indisunique=f): o banco NÃO impedia alerta/vínculo
--      duplicado. Dedup antes (mantém a linha mais recente), depois recria UNIQUE
--      com o MESMO nome e colunas.
--   2. users.desativado_em (timestamptz) + backfill p/ usuários já inativos.
--   3. CHECK users_role_check com os 7 papéis canônicos. Antes, normaliza os
--      legados admin→ADMIN / editor→LIDER / viewer→VISUALIZADOR — exatamente o
--      mapa que normalizeRole (app/src/lib/auth.ts) e normalize_role
--      (bff/app/core/security.py) já aplicam em TODA leitura; nenhum código
--      compara com os valores minúsculos crus, então o UPDATE é invisível.
--      Padrão seguro: ADD CONSTRAINT ... NOT VALID + VALIDATE CONSTRAINT.
--   4. Índice em audit_log(criado_em) — consulta da trilha de auditoria por
--      período (hoje só havia índice por usuário).
--   5. Índices nas 3 FKs quentes sem índice (das 24 detectadas via pg_constraint):
--      ver justificativa em cada CREATE INDEX abaixo.
--   6. Drop de 12 índices EXATAMENTE redundantes: prefixo de colunas 100% coberto
--      por outro índice da MESMA tabela; nunca se dropa índice que sustenta
--      PK/UNIQUE constraint. Cada drop documenta qual índice o cobre.
--   7. A8 — UNIQUE parcial em licitacao_eventos_vencedor (numero_licitacao, cnpj,
--      tipo) WHERE fonte='PORTAL_PETRONECT': fecha a corrida projeção×backfill do
--      worker (o INSERT usa ON CONFLICT DO NOTHING SEM alvo — genérico —, que
--      passa a ser protegido por este UNIQUE; o código do worker
--      não precisa mudar). Dedup antes (mantém a MAIS ANTIGA por registrado_em).
--   8. E12-DDL — CREATE EXTENSION unaccent + pg_trgm e índices GIN trigram nas
--      colunas usadas pela busca global (licitacoes.numero/objeto/empresa — ver
--      app/src/app/api/licitacoes/search/route.ts e o espelho BFF
--      licitacoes_search.py): ILIKE '%x%' passa a usar índice automaticamente,
--      acelerando a busca ATUAL sem mudar comportamento.

-- ── 8a) Extensões (antes dos índices trigram; clones frescos ganham as mesmas
--        em db/init/01-extensions.sql) ─────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint

-- ── 1) UNIQUE de verdade em alertas e doc-família ────────────────────────────

-- 1a. Dedup de alertas_vencimento por (documento_id, tipo_alerta): mantém a mais
--     recente (criado_em DESC; ctid DESC desempata inserções no mesmo instante).
DELETE FROM alertas_vencimento t
USING (
  SELECT ctid,
         ROW_NUMBER() OVER (
           PARTITION BY documento_id, tipo_alerta
           ORDER BY criado_em DESC NULLS LAST, ctid DESC
         ) AS rn
  FROM alertas_vencimento
) dup
WHERE t.ctid = dup.ctid
  AND dup.rn > 1;--> statement-breakpoint

-- 1b. Recria idx_alerta_unique como UNIQUE (mesmo nome/colunas). Só dropa se a
--     versão existente NÃO for unique (idempotente: no re-run não dropa nada).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'idx_alerta_unique' AND NOT i.indisunique
  ) THEN
    DROP INDEX idx_alerta_unique;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerta_unique
  ON alertas_vencimento (documento_id, tipo_alerta);--> statement-breakpoint

-- 1c. Dedup de documentos_familias por (documento_id, familia_id): idem 1a.
DELETE FROM documentos_familias t
USING (
  SELECT ctid,
         ROW_NUMBER() OVER (
           PARTITION BY documento_id, familia_id
           ORDER BY criado_em DESC NULLS LAST, ctid DESC
         ) AS rn
  FROM documentos_familias
) dup
WHERE t.ctid = dup.ctid
  AND dup.rn > 1;--> statement-breakpoint

-- 1d. Recria idx_docfam_unique como UNIQUE (mesmo nome/colunas).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'idx_docfam_unique' AND NOT i.indisunique
  ) THEN
    DROP INDEX idx_docfam_unique;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_docfam_unique
  ON documentos_familias (documento_id, familia_id);--> statement-breakpoint

-- ── 2) users.desativado_em + backfill ────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS desativado_em timestamptz;--> statement-breakpoint
UPDATE users
SET desativado_em = now()
WHERE ativo = false
  AND desativado_em IS NULL;--> statement-breakpoint

-- ── 3) CHECK de role em users ────────────────────────────────────────────────
-- Normaliza papéis legados ainda gravados em claro no banco (mapa idêntico ao
-- normalizeRole/normalize_role usado em toda leitura — ver cabeçalho).
UPDATE users
SET role = CASE role
             WHEN 'admin'  THEN 'ADMIN'
             WHEN 'editor' THEN 'LIDER'
             WHEN 'viewer' THEN 'VISUALIZADOR'
           END
WHERE role IN ('admin', 'editor', 'viewer');--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_role_check' AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('ADMIN','LIDER','ORCAMENTISTA','TECNICO','SGI','VISUALIZADOR','EXTERNO'))
      NOT VALID;
  END IF;
END $$;--> statement-breakpoint
-- VALIDATE é no-op se a constraint já está validada (idempotente).
ALTER TABLE users VALIDATE CONSTRAINT users_role_check;--> statement-breakpoint

-- ── 4) Índice de auditoria por período ───────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_audit_criado_em ON audit_log (criado_em);--> statement-breakpoint

-- ── 5) Índices nas FKs quentes (3 de 24 sem índice) ──────────────────────────
-- participacoes_licitacao.licitacao_petro_radar_id → licitacoes (SET NULL):
-- única FK da lista realmente CONSULTADA por igualdade no app (lookup de
-- participação existente em licitacoes/[id]/page.tsx e join do cron
-- circulares-watch).
CREATE INDEX IF NOT EXISTS idx_part_licradar
  ON participacoes_licitacao (licitacao_petro_radar_id);--> statement-breakpoint
-- documentos_habilitacao.documento_anterior_id → self-FK (SET NULL): todo DELETE
-- de documento do cofre (rota admin existente) varre a PRÓPRIA tabela sem este
-- índice; tabela cresce com o acervo de habilitação.
CREATE INDEX IF NOT EXISTS idx_doch_doc_anterior
  ON documentos_habilitacao (documento_anterior_id);--> statement-breakpoint
-- gap_habilitacao.documento_id → documentos_habilitacao (SET NULL): mesmo caminho
-- de DELETE de documento — sem índice, cada exclusão varre gap_habilitacao
-- (acumula linhas por análise de gap por licitação).
CREATE INDEX IF NOT EXISTS idx_gaphab_doc
  ON gap_habilitacao (documento_id);--> statement-breakpoint

-- ── 6) Drop de índices exatamente redundantes ────────────────────────────────
-- Critério: prefixo de colunas 100% coberto por outro índice da MESMA tabela
-- (índices completos, sem WHERE/expressão dos dois lados); nunca se dropa o
-- índice que sustenta PK/UNIQUE constraint.
-- Coberto por idx_alerta_unique (documento_id, tipo_alerta) — recriado em 1b.
DROP INDEX IF EXISTS idx_alerta_doc;--> statement-breakpoint
-- Coberto por idx_docfam_unique (documento_id, familia_id) — recriado em 1d.
DROP INDEX IF EXISTS idx_docfam_doc;--> statement-breakpoint
-- Coberto por idx_doch_cat_status (categoria, status).
DROP INDEX IF EXISTS idx_doch_categoria;--> statement-breakpoint
-- Coberto por idx_carta_env_versao UNIQUE (envelope_id, versao).
DROP INDEX IF EXISTS idx_carta_env;--> statement-breakpoint
-- Coberto por idx_envextras_env_doc UNIQUE (envelope_id, documento_id).
DROP INDEX IF EXISTS idx_envextras_env;--> statement-breakpoint
-- Coberto por idx_levev_lic_ordem UNIQUE (numero_licitacao, ordem).
DROP INDEX IF EXISTS idx_levev_lic;--> statement-breakpoint
-- Coberto por idx_lic_relevancia_score (relevancia, score_interesse).
DROP INDEX IF EXISTS idx_lic_relevancia;--> statement-breakpoint
-- Coberto por idx_notif_usuario_lida (usuario_id, lida).
DROP INDEX IF EXISTS idx_notif_usuario;--> statement-breakpoint
-- Duplicata exata da UNIQUE constraint api_keys_prefixo_unique (prefixo), que
-- permanece (vem do .unique() da coluna no schema).
DROP INDEX IF EXISTS uniq_apikey_prefixo;--> statement-breakpoint
-- Duplicata exata da UNIQUE constraint contratos_execucao_numero_unique (numero).
DROP INDEX IF EXISTS idx_contrato_numero;--> statement-breakpoint
-- Duplicata exata da UNIQUE constraint
-- licitacoes_familias_match_licitacao_id_unique (licitacao_id).
DROP INDEX IF EXISTS idx_lfm_licitacao;--> statement-breakpoint
-- Duplicata exata da UNIQUE constraint
-- resultados_licitacao_numero_licitacao_unique (numero_licitacao).
DROP INDEX IF EXISTS idx_res_numero;--> statement-breakpoint

-- ── 7) A8: UNIQUE parcial nos marcos do portal ───────────────────────────────
-- 7a. Dedup dos eventos do portal por (numero_licitacao, cnpj, tipo): mantém a
--     MAIS ANTIGA (registrado_em ASC; ordem ASC desempata — ordem é única por
--     licitação via idx_levev_lic_ordem). Eventos manuais (outras fontes) ficam
--     fora do dedup e do UNIQUE.
DELETE FROM licitacao_eventos_vencedor t
USING (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY numero_licitacao, cnpj, tipo
           ORDER BY registrado_em ASC NULLS LAST, ordem ASC
         ) AS rn
  FROM licitacao_eventos_vencedor
  WHERE fonte = 'PORTAL_PETRONECT'
) dup
WHERE t.id = dup.id
  AND dup.rn > 1;--> statement-breakpoint
-- 7b. UNIQUE parcial: 1 marco por (licitação, cnpj, tipo) vindo do portal.
CREATE UNIQUE INDEX IF NOT EXISTS uq_levev_marco_portal
  ON licitacao_eventos_vencedor (numero_licitacao, cnpj, tipo)
  WHERE fonte = 'PORTAL_PETRONECT';--> statement-breakpoint

-- ── 8b) Índices GIN trigram da busca global ──────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_lic_numero_trgm
  ON licitacoes USING gin (numero gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lic_objeto_trgm
  ON licitacoes USING gin (objeto gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lic_empresa_trgm
  ON licitacoes USING gin (empresa gin_trgm_ops);
