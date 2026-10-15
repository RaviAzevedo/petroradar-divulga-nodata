-- ═══════════════════════════════════════════════════════════════════════════
-- WP12 §1.2 — Dataset-âncora determinístico do harness e2e (IDEMPOTENTE).
--
-- FONTE ÚNICA DE VERDADE DAS CONSTANTES: tests/lib/fixtures.py — este arquivo
-- materializa EXATAMENTE aqueles UUIDs/e-mails/senha. Alterou lá, altera aqui
-- no MESMO commit (e vice-versa).
--
-- Aplicação (Makefile `seed-e2e`):
--   docker compose exec -T db psql -v ON_ERROR_STOP=1 -U $USER -d $DB < este_arquivo
--
-- Conferido coluna a coluna contra app/src/db/schema.ts (branch feat/onprem-prereqs).
-- Tabela → colunas cobertas:
--   users                    id, email, nome, password_hash, role, ativo
--   licitacoes               id, numero, objeto, objeto_resumido, empresa,
--                            empresa_codigo, status_code, status, fase, modalidade,
--                            tipo_oportunidade, abrangencia, data_inicio, hora_inicio,
--                            data_fim, hora_fim, data_publicacao, data_abertura,
--                            hora_abertura, regioes, limite_dias, natureza,
--                            tipo_servico, segmento, relevancia, score_interesse,
--                            perfis_match, melhor_perfil, dados_completos
--   participacoes_licitacao  id, numero_edital, empresa_contratante, objeto,
--                            url_portal, licitacao_petro_radar_id, prazo_portal,
--                            prazo_interno, fase, proposto_por, lider_id,
--                            responsavel_tecnico, responsavel_orcamento, versao,
--                            observacoes
--   familias                 id, codigo_crc, codigo_normalizado, nome, descricao,
--                            nivel, cadastro_corporativo, segmento_petrobras,
--                            status, status_fluxo_crc, validade_fim,
--                            proxima_renovacao_em, criterios, tags, criado_por
--   perfis_interesse         id, nome, descricao, ativo, filtros
--   circulares               id, licitacao_id, tipo, autor, mensagem,
--                            data_publicacao, hash_conteudo, impacto_ia,
--                            notificado_em, dados_brutos
--
-- NÃO semeia acervo_chunks: a migration 0015 trunca a tabela e o embedding
-- vector(1024) vem do fluxo vivo (tasks.embedding_reindex_acervo / BGE-m3).
--
-- UUIDs fixos: 00000000-0000-4000-8000-<12 dígitos> — users 01..07 (ordem de
-- permissions.ts), licitações 0101/0102, participação 0201, famílias 0301/0302,
-- perfil 0401, circular 0501. Sufixo ff = reservado (nunca semeado).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- pgcrypto: as migrations do app NÃO criam a extensão (só db/init/01-extensions.sql,
-- que não roda em banco restaurado de dump). Defensivo e idempotente:
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── USERS: 1 por papel real (permissions.ts) ─────────────────────────────────
-- Consumido por: TODAS as suítes (login NextAuth via auth_helpers.login_web +
-- JWT forjado do BFF) — auth_rbac_api em especial (matriz allow/deny por papel).
-- Senha única E2e!PetroRadar2026 (fixtures.E2E_PASSWORD); hash bcrypt REAL via
-- pgcrypto (gen_salt('bf',12) emite $2a$, aceito pelo bcryptjs do authorize()).
-- DO UPDATE (mesmos valores) p/ reassentar senha/role/ativo em re-runs.
-- DOMÍNIO `.invalid` (RFC 2606), NUNCA `example.com` — 2026-07-13.
-- Estas caixas não existem no Exchange, mas os crons resolvem destinatário por
-- PAPEL e o transporte Graph envia DE VERDADE (pela caixa de produção
-- no-reply@example.com). Com o domínio real, semear estas fixtures
-- fazia o cron de prazos disparar e-mail para 7 endereços inexistentes
-- @example.com → bounce em cima da caixa remetente de produção.
-- `.invalid` é reservado por RFC e não-resolvível: mesmo semeado, nada sai.
-- O login por senha não valida domínio (auth.ts::signIn só barra domínio no
-- provider microsoft-entra-id), então isto não afeta as suítes.
INSERT INTO users (id, email, nome, password_hash, role, ativo) VALUES
  ('00000000-0000-4000-8000-000000000001', 'admin.e2e@example.invalid',        'Admin E2E',        crypt('E2e!PetroRadar2026', gen_salt('bf', 12)), 'ADMIN',        true),
  ('00000000-0000-4000-8000-000000000002', 'lider.e2e@example.invalid',        'Lider E2E',        crypt('E2e!PetroRadar2026', gen_salt('bf', 12)), 'LIDER',        true),
  ('00000000-0000-4000-8000-000000000003', 'orcamentista.e2e@example.invalid', 'Orcamentista E2E', crypt('E2e!PetroRadar2026', gen_salt('bf', 12)), 'ORCAMENTISTA', true),
  ('00000000-0000-4000-8000-000000000004', 'tecnico.e2e@example.invalid',      'Tecnico E2E',      crypt('E2e!PetroRadar2026', gen_salt('bf', 12)), 'TECNICO',      true),
  ('00000000-0000-4000-8000-000000000005', 'sgi.e2e@example.invalid',          'SGI E2E',          crypt('E2e!PetroRadar2026', gen_salt('bf', 12)), 'SGI',          true),
  ('00000000-0000-4000-8000-000000000006', 'visualizador.e2e@example.invalid', 'Visualizador E2E', crypt('E2e!PetroRadar2026', gen_salt('bf', 12)), 'VISUALIZADOR', true),
  ('00000000-0000-4000-8000-000000000007', 'externo.e2e@example.invalid',      'Externo E2E',      crypt('E2e!PetroRadar2026', gen_salt('bf', 12)), 'EXTERNO',      true)
ON CONFLICT (id) DO UPDATE SET
  email         = EXCLUDED.email,
  nome          = EXCLUDED.nome,
  password_hash = EXCLUDED.password_hash,
  role          = EXCLUDED.role,
  ativo         = EXCLUDED.ativo;

-- ── LICITACOES: 2 âncoras verossímeis Petrobras ──────────────────────────────
-- Consumido por: licitacoes_api, busca_api, pacote_orcamento_api,
-- petitorio_minuta_api, parity/test_route_inventory ([id]/[licitacaoId]).
-- Colunas de data são TEXT no schema (formato ISO, compatível com o
-- diasRestantes() do reclassify).
--
-- INVARIANTE: cada linha é PONTO FIXO de POST /api/licitacoes/reclassify com o
-- perfil 0401 ativo — rodar o reclassify NÃO altera nada (dataset imune à ordem
-- das suítes). O classificador NÃO normaliza acentos (classificarNatureza casa
-- "serviço"/"prestação"/"manutenção", nunca "servico"), então os objetos abaixo
-- carregam as palavras-gatilho ACENTUADAS. Derivação conferida gatilho a
-- gatilho contra route.ts:
-- 0101: "prestação"/"serviços"→SERVIÇO; "engenharia"→Engenharia e Projetos;
--       sem gatilho de segmento→Geral / Multidisciplinar. Perfil 0401 (peso 10):
--       20(natureza)+25(tipo)+20(segmento)+25(3 keywords) = 90, sem bloqueios
--       (data_fim futura > prazo_minimo_dias) → ALTA/90, perfis_match
--       preenchido — elegível ao cron oportunidades-novas (limiar default 60).
-- 0102: "serviço"/"manutenção"→SERVIÇO; "manutenção"→Manutenção e Reparo;
--       "permutador"→Equipamentos de Processo. Score 20+25+20+15(só "refino")
--       = 80, mas data_fim no PASSADO → -30 e bloqueio "Prazo curto" → 50,
--       isMatch=false → BAIXA/50, perfis_match '' (vazio mesmo), melhor_perfil
--       preenchido (weighted 50 > 0). Negativo determinístico do cron.
INSERT INTO licitacoes (
  id, numero, objeto, objeto_resumido, empresa, empresa_codigo,
  status_code, status, fase, modalidade, tipo_oportunidade, abrangencia,
  data_inicio, hora_inicio, data_fim, hora_fim, data_publicacao,
  data_abertura, hora_abertura, regioes, limite_dias,
  natureza, tipo_servico, segmento, relevancia, score_interesse,
  perfis_match, melhor_perfil, dados_completos
) VALUES
  (
    '00000000-0000-4000-8000-000000000101', '7004990101',
    'Prestação de serviços de engenharia de detalhamento e apoio técnico para unidades de processo de refino (âncora e2e)',
    'Engenharia de detalhamento - refino (âncora e2e)',
    'PETROBRAS', 'PETROBRAS',
    '05', 'Recebendo Propostas', 'Divulgacao de oportunidade',
    'Licitacao', 'Licitacao Publica (Lei 13.303/16)', 'Nacional',
    '2026-05-20', '08:00:00', '2026-07-15', '17:00:00', '2026-05-18',
    '2026-07-16', '09:00:00', 'BA', 30,
    'SERVIÇO', 'Engenharia e Projetos', 'Geral / Multidisciplinar', 'ALTA', 100,
    'Engenharia de refino (e2e)', 'Engenharia de refino (e2e)',
    '{"origem": "seed-e2e", "ancora": true}'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000000102', '7004990102',
    'Serviço de hotelaria e hospedagem para força de trabalho embarcada (âncora e2e)',
    'Hotelaria e hospedagem (âncora e2e)',
    'PETROBRAS', 'PETROBRAS',
    '08', 'Concluido', 'Encerrada',
    'Licitacao', 'Licitacao Publica (Lei 13.303/16)', 'Nacional',
    '2026-02-10', '08:00:00', '2026-03-20', '17:00:00', '2026-02-08',
    '2026-03-21', '09:00:00', 'BA', 30,
    'SERVIÇO', 'Serviço Especializado', 'Geral / Multidisciplinar', 'SEM INTERESSE', 0,
    '', '',
    '{"origem": "seed-e2e", "ancora": true}'::jsonb
  )
ON CONFLICT (id) DO NOTHING;

-- ── PARTICIPACAO: 1, ligada à licitação 0101 ─────────────────────────────────
-- Consumido por: notificacoes_api (prazos), parity/test_route_inventory
-- (/api/participacoes/[id]/*: fase, lock, documentos, extensao, benchmark).
-- NOT NULL cobertos: numero_edital, empresa_contratante, objeto, prazo_portal,
-- proposto_por (TECNICO pode propor — ROLES_PROPOR). FK real:
-- licitacao_petro_radar_id (NÃO "licitacao_id" — erro #6 da auditoria).
INSERT INTO participacoes_licitacao (
  id, numero_edital, empresa_contratante, objeto, url_portal,
  licitacao_petro_radar_id, prazo_portal, prazo_interno, fase,
  proposto_por, lider_id, responsavel_tecnico, responsavel_orcamento,
  versao, observacoes
) VALUES (
  '00000000-0000-4000-8000-000000000201',
  '7004990101',
  'PETROBRAS - Petroleo Brasileiro S.A.',
  'Prestação de serviços de engenharia de detalhamento e apoio técnico para unidades de processo de refino (âncora e2e)',
  'https://www.petronect.com.br',
  '00000000-0000-4000-8000-000000000101',
  '2026-07-15 17:00:00-03',
  '2026-07-10 17:00:00-03',
  'PROSPECCAO',
  '00000000-0000-4000-8000-000000000004',  -- proposto_por: TECNICO
  '00000000-0000-4000-8000-000000000002',  -- lider_id: LIDER
  '00000000-0000-4000-8000-000000000004',  -- responsavel_tecnico: TECNICO
  '00000000-0000-4000-8000-000000000003',  -- responsavel_orcamento: ORCAMENTISTA
  0,
  'Participacao-ancora do harness e2e (nao usar em producao).'
)
ON CONFLICT (id) DO NOTHING;

-- ── FAMILIAS CRC: 2 (match × renovação) ──────────────────────────────────────
-- Consumido por: cofre_api (vínculo documento↔família), acervo_rag_api
-- (gap-habilitacao), parity (/api/conformidade/familias/[id]).
-- NOT NULL cobertos: codigo_crc (unique), codigo_normalizado, nome (erro #3
-- da auditoria: o seed antigo usava "codigo"/"descricao", inexistentes).
-- codigo_crc: códigos FICTÍCIOS 9999xxxx (fixtures.FAM_CODIGO_CRC*) — NUNCA
-- usar códigos CRC reais da Proponente: codigo_crc tem UNIQUE
-- real no schema mas o arbiter abaixo é só (id); em banco restaurado de dump
-- de produção a família verdadeira existiria com OUTRO uuid e a colisão de
-- unique não-coberta abortaria o seed INTEIRO sob BEGIN + ON_ERROR_STOP=1.
-- Domínios reais: nivel FAMILIA|SUBFAMILIA|GRUPO|ITEM; status ATIVA|EM_RENOVACAO|
-- SUSPENSA|VENCIDA|REJEITADA; status_fluxo_crc D|Q|A|X; segmento_petrobras
-- YELLOW_PAGES|OPERACIONAL|CRITICA|ESTRATEGICA; criterios JSONB por critério CRC.
INSERT INTO familias (
  id, codigo_crc, codigo_normalizado, nome, descricao, nivel,
  cadastro_corporativo, segmento_petrobras, status, status_fluxo_crc,
  validade_fim, proxima_renovacao_em, criterios, tags, criado_por
) VALUES
  (
    '00000000-0000-4000-8000-000000000301',
    '99990066', '99990066',
    'Servicos de engenharia de processo',
    'Familia CRC ancora e2e - engenharia de processo (refino).',
    'FAMILIA', true, 'CRITICA', 'ATIVA', 'A',
    '2027-03-31 23:59:59-03', '2027-01-30 00:00:00-03',
    '{"JURIDICO": {"status": "APROVADO", "validadeFim": "2027-03-31"}, "ECONOMICO": {"status": "APROVADO", "validadeFim": "2027-03-31"}, "TECNICO": {"status": "APROVADO", "validadeFim": "2027-03-31"}}'::jsonb,
    '["e2e", "refino"]'::jsonb,
    '00000000-0000-4000-8000-000000000001'
  ),
  (
    '00000000-0000-4000-8000-000000000302',
    '99990070', '99990070',
    'Montagem eletromecanica industrial',
    'Familia CRC ancora e2e - montagem eletromecanica (janela de renovacao).',
    'FAMILIA', true, 'OPERACIONAL', 'EM_RENOVACAO', 'Q',
    '2026-08-15 23:59:59-03', '2026-06-16 00:00:00-03',
    '{"JURIDICO": {"status": "APROVADO", "validadeFim": "2026-08-15"}, "TECNICO": {"status": "EM_AVALIACAO", "validadeFim": null}}'::jsonb,
    '["e2e", "montagem"]'::jsonb,
    '00000000-0000-4000-8000-000000000001'
  )
ON CONFLICT (id) DO NOTHING;

-- ── PERFIL DE INTERESSE: 1, casa a licitação 0101 ────────────────────────────
-- Consumido por: crons_api (reclassify + oportunidades-novas), parity
-- (/api/perfis/[id]). filtros é jsonb NOT NULL (erro #4 da auditoria: o seed
-- antigo usava coluna "keywords", inexistente). Shape real = FiltrosPerfil de
-- /api/licitacoes/reclassify (peso, natureza[], tipo_servico[], segmento[],
-- keywords_incluir[], keywords_excluir[], prazo_minimo_dias).
-- ATENÇÃO peso: escala 0-10 (default `f.peso ?? 5`; weighted = score * peso/10).
-- peso 10 ⇒ weighted == score bruto; peso 1 dividiria o score por 10 e a 0101
-- cairia para 9/SEM INTERESSE, matando a cadeia perfil→match→cron.
INSERT INTO perfis_interesse (id, nome, descricao, ativo, filtros) VALUES (
  '00000000-0000-4000-8000-000000000401',
  'Engenharia de refino (e2e)',
  'Perfil-ancora do harness: casa a licitacao 7004990101 por natureza, tipo de servico e keywords.',
  true,
  '{"peso": 10, "natureza": ["SERVIÇO"], "tipo_servico": ["Engenharia e Projetos", "Manutenção e Reparo"], "segmento": ["Geral / Multidisciplinar", "Equipamentos de Processo"], "keywords_incluir": ["engenharia", "refino", "detalhamento"], "keywords_excluir": ["hotelaria", "embarcacao"], "prazo_minimo_dias": 7}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- ── CIRCULAR: 1, ligada à licitação 0101 ─────────────────────────────────────
-- Consumido por: notificacoes_api + crons_api (circulares-watch: notificado_em
-- NULL = pendente de alerta; o cron preenche e o DO NOTHING preserva),
-- licitacoes_api (/api/licitacoes/[id]/circulares). Colunas REAIS — sem
-- "numero" (erro #5 da auditoria). Domínios: tipo MENSAGEM|ADENDO|COMUNICADO|
-- ESCLARECIMENTO|OUTRO; impacto_ia NENHUM|PRAZO|ESCOPO|HABILITACAO|VALOR.
INSERT INTO circulares (
  id, licitacao_id, tipo, autor, mensagem, data_publicacao,
  hash_conteudo, impacto_ia, notificado_em, dados_brutos
) VALUES (
  '00000000-0000-4000-8000-000000000501',
  '00000000-0000-4000-8000-000000000101',
  'ESCLARECIMENTO',
  'Comissao de Licitacao - PETROBRAS',
  'Esclarecimento n. 01: fica prorrogado o prazo de envio de propostas da oportunidade 7004990101 para 15/07/2026 as 17h (ancora e2e).',
  '2026-06-05 14:30:00',
  'aa11bb22cc33dd44ee55ff660718293a4b5c6d7e8f90a1b2c3d4e5f607182930',
  'PRAZO',
  NULL,
  '{"origem": "seed-e2e"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
