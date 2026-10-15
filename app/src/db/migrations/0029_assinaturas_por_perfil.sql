-- =============================================================================
-- 0029 — assinatura de e-mail passa a ser por PERFIL DE INTERESSE
-- =============================================================================
-- Decisao do dono (06/08/2026), invertendo a de julho: os filtros de e-mail eram
-- uma entidade PROPRIA, com criterios jsonb duplicando o que os perfis ja fazem.
-- Eram duas listas para manter e dois lugares para errar. Agora quem cuida dos
-- perfis em /perfis ja define o que chega por e-mail.
--
-- Idempotente (padrao das 0019+, aplicadas por db/scripts/apply-extra-migrations.sh).
-- =============================================================================

-- 1) Assinatura pode apontar para um perfil.
ALTER TABLE assinaturas_email
  ADD COLUMN IF NOT EXISTS perfil_id uuid REFERENCES perfis_interesse(id) ON DELETE CASCADE;

-- 2) filtro_id deixa de ser obrigatorio (assinatura por perfil nao usa filtro).
ALTER TABLE assinaturas_email ALTER COLUMN filtro_id DROP NOT NULL;

-- 3) Exatamente UMA origem por assinatura — nunca as duas, nunca nenhuma.
ALTER TABLE assinaturas_email DROP CONSTRAINT IF EXISTS chk_assinatura_origem;
ALTER TABLE assinaturas_email
  ADD CONSTRAINT chk_assinatura_origem
  CHECK ((filtro_id IS NOT NULL) <> (perfil_id IS NOT NULL));

-- 4) Uma assinatura por pessoa por perfil.
CREATE UNIQUE INDEX IF NOT EXISTS uq_assinatura_user_perfil
  ON assinaturas_email (user_id, perfil_id) WHERE perfil_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ass_email_perfil ON assinaturas_email (perfil_id);

-- 5) O filtro "Inovacao e Inteligencia de Mercado" nao tem perfil equivalente —
--    vira um perfil. As keywords vieram do proprio filtro, com UMA correcao: a
--    keyword solta "piloto" casava "Piloto de Ignicao" (muito
--    ruido), entao virou "projeto/planta/unidade piloto".
--    Criado INATIVO de proposito: perfil ativo entra no motor de classificacao e
--    mexe na relevancia de toda a base. Ativar em /perfis depois de conferir o
--    preview e uma decisao consciente, nao efeito colateral de uma migration.
INSERT INTO perfis_interesse (nome, descricao, ativo, filtros)
SELECT
  'Inovação e Inteligência de Mercado',
  'Migrado do filtro de e-mail homônimo (0029). Keyword "piloto" restringida para não casar "Piloto de Ignição".',
  false,
  '{"peso": 6, "keywords_incluir": ["inovacao", "digitalizacao", "inteligencia", "analise de dados", "monitoramento remoto", "automacao", "transformacao digital", "pesquisa e desenvolvimento", "projeto piloto", "planta piloto", "unidade piloto"], "keywords_excluir": [], "prazo_minimo_dias": 5}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM perfis_interesse WHERE nome = 'Inovação e Inteligência de Mercado');

-- 6) Migra as assinaturas existentes para o perfil de mesmo nome (ou prefixo).
--    "Apoio Tecnico" (filtro) -> "Apoio Tecnico e Operacional" (perfil).
UPDATE assinaturas_email a
   SET perfil_id = p.id, filtro_id = NULL
  FROM filtros_email f, perfis_interesse p
 WHERE a.filtro_id = f.id
   AND a.perfil_id IS NULL
   AND (p.nome = f.nome OR p.nome ILIKE f.nome || '%');

-- 7) Sobrou assinatura sem perfil equivalente? Fica como esta (filtro_id), o
--    digest continua atendendo pelo caminho legado. Nada e apagado aqui.
