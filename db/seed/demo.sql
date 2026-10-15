-- ═══════════════════════════════════════════════════════════════════════════
-- Seed de DEMONSTRAÇÃO — dados 100% FICTÍCIOS (IDEMPOTENTE).
--
-- Serve para quem clona o repositório ver as telas com conteúdo. Nada aqui
-- veio de portal, cliente ou acervo real:
--   · números de licitação na faixa 79990000xx (não existem no portal);
--   · CNPJs montados só para passar no dígito verificador; os nomes ao lado
--     são inventados e qualquer coincidência com um CNPJ real é acaso;
--   · operações, profissionais e CREAs inventados;
--   · documentos do cofre SÓ COM METADADO: `blob_key` aponta para um objeto
--     que não existe no storage, então o download falha — de propósito.
--
-- Datas RELATIVAS a CURRENT_DATE: a demo continua com licitações abertas em
-- qualquer dia em que for carregada.
--
-- Aplicação (depois de `make migrate`):
--   make seed-demo
-- Login: admin@demo.invalid / Demo!PetroRadar  (troque antes de expor a stack)
--
-- UUIDs fixos: d0000000-0000-4000-8000-<12 dígitos>, por bloco:
--   users 0001..0004 · licitações 01xx · resultados 02xx · famílias 03xx
--   perfis 04xx · operações 05xx · documentos 06xx · profissionais 07xx
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── USERS ────────────────────────────────────────────────────────────────────
-- Domínio `.invalid` (RFC 2606): os crons resolvem destinatário por papel e
-- nenhum e-mail desta demo pode chegar a uma caixa real.
INSERT INTO users (id, email, nome, password_hash, role, ativo) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'admin@demo.invalid',   'Ana Demonstração',   crypt('Demo!PetroRadar', gen_salt('bf', 12)), 'ADMIN',        true),
  ('d0000000-0000-4000-8000-000000000002', 'lider@demo.invalid',   'Bruno Exemplo',      crypt('Demo!PetroRadar', gen_salt('bf', 12)), 'LIDER',        true),
  ('d0000000-0000-4000-8000-000000000003', 'tecnico@demo.invalid', 'Carla Fictícia',     crypt('Demo!PetroRadar', gen_salt('bf', 12)), 'TECNICO',      true),
  ('d0000000-0000-4000-8000-000000000004', 'sgi@demo.invalid',     'Diego Ilustrativo',  crypt('Demo!PetroRadar', gen_salt('bf', 12)), 'SGI',          true)
ON CONFLICT (id) DO NOTHING;

-- ── LICITAÇÕES ───────────────────────────────────────────────────────────────
-- 30 oportunidades. `d_fim` é o deslocamento em dias do prazo de proposta:
-- positivo = aberta, negativo = já encerrada (vira "Prazo Encerrado" na tela).
INSERT INTO licitacoes (
  id, numero, objeto, objeto_resumido, empresa, empresa_codigo, fase, status,
  modalidade, tipo_oportunidade, abrangencia,
  data_publicacao, data_inicio, hora_inicio, data_fim, hora_fim,
  data_abertura, hora_abertura, regioes, limite_dias,
  natureza, tipo_servico, segmento, relevancia, score_interesse,
  perfis_match, melhor_perfil, fonte, dados_completos
)
SELECT
  ('d0000000-0000-4000-8000-0000000001' || lpad(v.n::text, 2, '0'))::uuid,
  '79990000' || lpad(v.n::text, 2, '0'),
  v.objeto,
  v.resumo,
  v.empresa,
  v.empresa,
  v.fase,
  v.fase,
  'Licitacao',
  'Licitacao Publica (Lei 13.303/16)',
  'Nacional',
  to_char(current_date + v.d_fim - 30, 'YYYY-MM-DD'),
  to_char(current_date + v.d_fim - 28, 'YYYY-MM-DD'), '08:00:00',
  to_char(current_date + v.d_fim,      'YYYY-MM-DD'), '17:00:00',
  to_char(current_date + v.d_fim + 1,  'YYYY-MM-DD'), '09:00:00',
  v.regioes,
  30,
  v.natureza, v.tipo, v.segmento, v.relevancia, v.score,
  v.perfil, v.perfil,
  'petronect',
  jsonb_build_object('origem', 'seed-demo')
FROM (VALUES
  ( 1, 'Serviços de engenharia de detalhamento para revamp de unidade de destilação atmosférica', 'Detalhamento — revamp de destilação', 'PETROBRAS', 'Recebendo Propostas', 'Bahia', 'SERVIÇO', 'Engenharia e Projetos', 'Equipamentos de Processo', 'ALTA', 92, 'Engenharia de processo', 21),
  ( 2, 'Manutenção preventiva e corretiva de bombas centrífugas em terminal aquaviário', 'Manutenção de bombas — terminal', 'TRANSPETRO', 'Recebendo Propostas', 'São Paulo', 'SERVIÇO', 'Manutenção e Reparo', 'Bombas e Compressores', 'ALTA', 88, 'Manutenção industrial', 14),
  ( 3, 'Inspeção de equipamentos estáticos e vasos de pressão conforme NR-13', 'Inspeção NR-13 de vasos', 'PETROBRAS', 'Recebendo Propostas', 'Rio de Janeiro', 'SERVIÇO', 'Inspeção, Calibração e Monitoramento', 'Equipamentos de Processo', 'ALTA', 85, 'Inspeção e integridade', 9),
  ( 4, 'Montagem eletromecânica de skids de medição fiscal de gás natural', 'Montagem de skids de medição', 'PETROBRAS', 'Recebendo Propostas', 'Espírito Santo', 'EPC / OBRA', 'Construção e Montagem', 'Instrumentação e Controle', 'MÉDIA', 71, 'Montagem eletromecânica', 25),
  ( 5, 'Fornecimento de válvulas esfera de grande diâmetro com atuador pneumático', 'Válvulas esfera com atuador', 'TRANSPETRO', 'Recebendo Propostas', 'Minas Gerais', 'AQUISIÇÃO', NULL, 'Válvulas e Atuadores', 'BAIXA', 34, NULL, 18),
  ( 6, 'Serviços de pintura industrial e revestimento anticorrosivo de tanques de armazenamento', 'Pintura de tanques', 'TRANSPETRO', 'Recebendo Propostas', 'Pernambuco', 'SERVIÇO', 'Pintura e Revestimento', 'Pintura e Revestimento', 'MÉDIA', 66, 'Manutenção industrial', 11),
  ( 7, 'Apoio técnico de engenharia à operação de plantas de tratamento de gás', 'Apoio técnico — tratamento de gás', 'PETROBRAS', 'Recebendo Propostas', 'Bahia, Sergipe', 'SERVIÇO', 'Apoio Técnico e Operacional', 'Geral / Multidisciplinar', 'ALTA', 90, 'Engenharia de processo', 6),
  ( 8, 'Projeto executivo de sistema de combate a incêndio de parque de tancagem', 'Projeto de combate a incêndio', 'TRANSPETRO', 'Recebendo Propostas', 'Rio Grande do Sul', 'SERVIÇO', 'Engenharia e Projetos', 'Segurança e Combate a Incêndio', 'ALTA', 83, 'Engenharia de processo', 30),
  ( 9, 'Calibração de instrumentos de campo e malhas de controle de unidade de refino', 'Calibração de instrumentos', 'PETROBRAS', 'Recebendo Propostas', 'São Paulo', 'SERVIÇO', 'Inspeção, Calibração e Monitoramento', 'Instrumentação e Controle', 'MÉDIA', 62, 'Inspeção e integridade', 16),
  (10, 'Serviços de caldeiraria e substituição de feixes tubulares de permutadores', 'Caldeiraria — permutadores', 'PETROBRAS', 'Agendada (Futura)', 'Paraná', 'SERVIÇO', 'Manutenção e Reparo', 'Equipamentos de Processo', 'ALTA', 87, 'Manutenção industrial', 40),
  (11, 'Locação de guindastes e equipamentos de movimentação de carga para parada de manutenção', 'Locação de guindastes', 'PETROBRAS', 'Recebendo Propostas', 'Rio de Janeiro', 'AFRETAMENTO / LOCAÇÃO', 'Logística e Transporte', 'Equipamentos de Movimentação', 'BAIXA', 28, NULL, 12),
  (12, 'Engenharia de automação e migração de sistema digital de controle distribuído', 'Migração de SDCD', 'PETROBRAS', 'Recebendo Propostas', 'Bahia', 'SERVIÇO', 'Engenharia e Projetos', 'Instrumentação e Controle', 'ALTA', 89, 'Engenharia de processo', 19),
  (13, 'Serviços de limpeza industrial e hidrojateamento de alta pressão', 'Hidrojateamento industrial', 'TRANSPETRO', 'Recebendo Propostas', 'São Paulo', 'SERVIÇO', 'Limpeza e Meio Ambiente', 'Meio Ambiente', 'BAIXA', 31, NULL, 8),
  (14, 'Gerenciamento de resíduos industriais classe I e II de unidade operacional', 'Gestão de resíduos', 'PETROBRAS', 'Em Análise', 'Rio Grande do Norte', 'SERVIÇO', 'Limpeza e Meio Ambiente', 'Meio Ambiente', 'BAIXA', 25, NULL, -5),
  (15, 'Construção de subestação elétrica 13,8 kV e interligação com painéis existentes', 'Subestação 13,8 kV', 'PETROBRAS', 'Recebendo Propostas', 'Espírito Santo', 'EPC / OBRA', 'Construção e Montagem', 'Elétrica e Eletrônica', 'MÉDIA', 69, 'Montagem eletromecânica', 27),
  (16, 'Inspeção de dutos por pig instrumentado e avaliação de integridade', 'Inspeção de dutos por pig', 'TRANSPETRO', 'Recebendo Propostas', 'Minas Gerais, São Paulo', 'SERVIÇO', 'Inspeção, Calibração e Monitoramento', 'Tubulação, Dutos e Conexões', 'ALTA', 84, 'Inspeção e integridade', 23),
  (17, 'Serviços de hotelaria marítima para unidades de produção offshore', 'Hotelaria marítima', 'PETROBRAS', 'Recebendo Propostas', 'Rio de Janeiro', 'SERVIÇO', 'Hotelaria Marítima', 'Naval e Offshore', 'SEM INTERESSE', 0, NULL, 15),
  (18, 'Treinamento operacional em segurança de processo e análise de riscos', 'Treinamento em segurança de processo', 'PETROBRAS', 'Recebendo Propostas', 'Bahia', 'SERVIÇO', 'Treinamento e Capacitação', 'Geral / Multidisciplinar', 'MÉDIA', 55, 'Engenharia de processo', 10),
  (19, 'Fabricação e montagem de tubulações de aço carbono para interligações de processo', 'Pré-fabricação de tubulação', 'PETROBRAS', 'Recebendo Propostas', 'Pernambuco', 'EPC / OBRA', 'Construção e Montagem', 'Tubulação, Dutos e Conexões', 'ALTA', 86, 'Montagem eletromecânica', 33),
  (20, 'Aquisição de catalisador para unidade de hidrotratamento', 'Catalisador de hidrotratamento', 'PETROBRAS', 'Recebendo Propostas', 'São Paulo', 'AQUISIÇÃO', NULL, 'Produtos Químicos e Catalisadores', 'SEM INTERESSE', 0, NULL, 20),
  (21, 'Engenharia conceitual e básica de unidade de recuperação de enxofre', 'Engenharia básica — recuperação de enxofre', 'PETROBRAS', 'Em Disputa', 'Rio de Janeiro', 'SERVIÇO', 'Engenharia e Projetos', 'Equipamentos de Processo', 'ALTA', 91, 'Engenharia de processo', -2),
  (22, 'Manutenção de compressores alternativos de estação de compressão de gás', 'Manutenção de compressores', 'TRANSPETRO', 'Prazo Encerrado', 'Bahia', 'SERVIÇO', 'Manutenção e Reparo', 'Bombas e Compressores', 'ALTA', 80, 'Manutenção industrial', -12),
  (23, 'Serviços de topografia e cadastro de faixa de dutos', 'Topografia de faixa de dutos', 'TRANSPETRO', 'Adjudicado', 'Santa Catarina', 'SERVIÇO', 'Engenharia e Projetos', 'Tubulação, Dutos e Conexões', 'MÉDIA', 58, 'Inspeção e integridade', -40),
  (24, 'Isolamento térmico e refratário de fornos de processo', 'Isolamento e refratário de fornos', 'PETROBRAS', 'Homologado', 'Paraná', 'SERVIÇO', 'Manutenção e Reparo', 'Equipamentos de Processo', 'ALTA', 82, 'Manutenção industrial', -60),
  (25, 'Desenvolvimento de software de gestão de integridade de ativos', 'Software de integridade de ativos', 'PETROBRAS', 'Concluído', 'Rio de Janeiro', 'SERVIÇO', 'Serviço Especializado', 'TI e Software', 'BAIXA', 30, NULL, -90),
  (26, 'Comissionamento e partida de sistemas de utilidades', 'Comissionamento de utilidades', 'PETROBRAS', 'Concluído', 'Bahia', 'SERVIÇO', 'Apoio Técnico e Operacional', 'Geral / Multidisciplinar', 'ALTA', 88, 'Engenharia de processo', -75),
  (27, 'Obras civis de base de equipamentos e pipe-racks', 'Obras civis — bases e pipe-racks', 'PETROBRAS', 'Cancelado', 'Sergipe', 'EPC / OBRA', 'Construção e Montagem', 'Geral / Multidisciplinar', 'MÉDIA', 60, 'Montagem eletromecânica', -20),
  (28, 'Monitoramento ambiental de efluentes e emissões atmosféricas', 'Monitoramento ambiental', 'TRANSPETRO', 'Deserto', 'Ceará', 'SERVIÇO', 'Limpeza e Meio Ambiente', 'Meio Ambiente', 'BAIXA', 22, NULL, -30),
  (29, 'Engenharia de confiabilidade e análise RAM de sistemas de produção', 'Análise RAM', 'PETROBRAS', 'Recebendo Propostas', 'Rio de Janeiro', 'SERVIÇO', 'Engenharia e Projetos', 'Geral / Multidisciplinar', 'ALTA', 87, 'Engenharia de processo', 4),
  (30, 'Reparo de tanques de armazenamento conforme API 653', 'Reparo de tanques API 653', 'TRANSPETRO', 'Recebendo Propostas', 'Bahia', 'SERVIÇO', 'Manutenção e Reparo', 'Equipamentos de Processo', 'ALTA', 85, 'Manutenção industrial', 2)
) AS v(n, objeto, resumo, empresa, fase, regioes, natureza, tipo, segmento, relevancia, score, perfil, d_fim)
ON CONFLICT (id) DO NOTHING;

-- Itens: 1 a 3 por licitação, descrição derivada do resumo.
INSERT INTO itens (licitacao_id, item_numero, descricao, quantidade, unidade)
SELECT l.id, lpad((10 * g)::text, 5, '0'),
       l.objeto_resumido || ' — lote ' || g,
       (g * 12)::real, 'UN'
  FROM licitacoes l
 CROSS JOIN generate_series(1, 3) g
 WHERE l.dados_completos->>'origem' = 'seed-demo'
   AND g <= 1 + (substr(l.numero, 9, 2)::int % 3)
   AND NOT EXISTS (SELECT 1 FROM itens i WHERE i.licitacao_id = l.id);

-- Uma circular de esclarecimento em duas licitações abertas.
INSERT INTO circulares (licitacao_id, tipo, autor, mensagem, data_publicacao, hash_conteudo, impacto_ia, dados_brutos)
SELECT l.id, 'ESCLARECIMENTO', 'Comissão de Licitação',
       'Esclarecimento n. 01: a visita técnica é facultativa e o prazo de envio de propostas fica mantido.',
       now() - interval '2 days',
       md5('seed-demo-circular-' || l.numero), 'BAIXO',
       jsonb_build_object('origem', 'seed-demo')
  FROM licitacoes l
 WHERE l.numero IN ('7999000001', '7999000012')
   AND NOT EXISTS (SELECT 1 FROM circulares c WHERE c.licitacao_id = l.id);

-- ── RESULTADOS ───────────────────────────────────────────────────────────────
-- Vencedores inventados para as licitações já decididas.
INSERT INTO resultados_licitacao (
  id, licitacao_id, numero_licitacao, cnpj_vencedor, fornecedor_vencedor,
  valor_vencedor, total_participantes, total_propostas, menor_valor, maior_valor,
  status_resultado, objeto, empresa, segmento, natureza, data_fim
)
SELECT ('d0000000-0000-4000-8000-0000000002' || substr(l.numero, 9, 2))::uuid,
       l.id, l.numero, r.cnpj, r.fornecedor,
       r.valor, r.participantes, r.participantes, r.valor, r.valor * 1.35,
       'VENCEDOR_DEFINIDO', l.objeto, l.empresa, l.segmento, l.natureza, l.data_fim
  FROM (VALUES
    ('7999000023', '11444777000161', 'Alfa Topografia e Engenharia Ltda',   1850000.00, 6),
    ('7999000024', '22555888000161', 'Beta Refratários Industriais S.A.',   7420000.00, 4),
    ('7999000025', '33666999000161', 'Gama Sistemas de Integridade Ltda',   2390000.00, 9),
    ('7999000026', '44777000000178', 'Delta Comissionamento e Partida Ltda', 12600000.00, 5),
    ('7999000022', '55888111000178', 'Épsilon Máquinas e Compressores Ltda', 5310000.00, 7)
  ) AS r(numero, cnpj, fornecedor, valor, participantes)
  JOIN licitacoes l ON l.numero = r.numero
ON CONFLICT (numero_licitacao) DO NOTHING;

-- ── CONTRATOS (Portal da Transparência, fictícios) ──────────────────────────
INSERT INTO transparencia_contratos (
  contrato_cd, processo, cnpj, fornecedor, objeto, valor, moeda, situacao,
  modalidade, unidade, vigencia_inicio, vigencia_fim, aditivos_qtd, origem,
  segmento_estimado
)
SELECT 'DEMO-' || lpad(g::text, 4, '0'),
       '79980000' || lpad(g::text, 2, '0'),
       c.cnpj, c.fornecedor, c.objeto, c.valor, 'BRL',
       CASE WHEN g % 4 = 0 THEN 'ENCERRADO' ELSE 'ATIVO' END,
       'Licitação', c.unidade,
       to_char(current_date - (g * 45), 'YYYY-MM-DD'),
       to_char(current_date - (g * 45) + 1095, 'YYYY-MM-DD'),
       g % 3, 'seed-demo', c.segmento
  FROM (VALUES
    (1, '11444777000161', 'Alfa Topografia e Engenharia Ltda',    'Levantamentos topográficos e cadastro de faixa de dutos',          1850000.00, 'Unidade Sul',      'Tubulação, Dutos e Conexões'),
    (2, '22555888000161', 'Beta Refratários Industriais S.A.',    'Manutenção de refratários de fornos e caldeiras',                  7420000.00, 'Refinaria Exemplo', 'Equipamentos de Processo'),
    (3, '44777000000178', 'Delta Comissionamento e Partida Ltda', 'Comissionamento de sistemas de utilidades',                       12600000.00, 'Refinaria Exemplo', 'Geral / Multidisciplinar'),
    (4, '55888111000178', 'Épsilon Máquinas e Compressores Ltda', 'Manutenção de compressores de estação de gás',                     5310000.00, 'Terminal Exemplo',  'Bombas e Compressores'),
    (5, '66999222000178', 'Zeta Instrumentação Ltda',             'Calibração de instrumentos e analisadores',                        3100000.00, 'Refinaria Exemplo', 'Instrumentação e Controle'),
    (6, '77000333000145', 'Eta Pintura Industrial Ltda',          'Pintura anticorrosiva de tanques e esferas',                       4280000.00, 'Terminal Exemplo',  'Pintura e Revestimento'),
    (7, '88111444000145', 'Teta Engenharia de Projetos S.A.',     'Engenharia de detalhamento multidisciplinar',                      9850000.00, 'Sede Exemplo',      'Geral / Multidisciplinar'),
    (8, '11444777000161', 'Alfa Topografia e Engenharia Ltda',    'Georreferenciamento de áreas operacionais',                         960000.00, 'Unidade Norte',     'Tubulação, Dutos e Conexões')
  ) AS c(g, cnpj, fornecedor, objeto, valor, unidade, segmento)
ON CONFLICT (contrato_cd) DO NOTHING;

-- ── FAMÍLIAS CRC ─────────────────────────────────────────────────────────────
-- Códigos 9999xxxx: fora da faixa usada pelo catálogo oficial.
INSERT INTO familias (
  id, codigo_crc, codigo_normalizado, nome, descricao, nivel,
  cadastro_corporativo, segmento_petrobras, status, status_fluxo_crc,
  validade_fim, proxima_renovacao_em, criterios, tags, criado_por
) VALUES
  ('d0000000-0000-4000-8000-000000000301', '99990001', '99990001', 'Engenharia de processo (demo)',
   'Família fictícia de demonstração.', 'FAMILIA', true, 'CRITICA', 'ATIVA', 'A',
   now() + interval '300 days', now() + interval '240 days',
   '{"JURIDICO": {"status": "APROVADO"}, "ECONOMICO": {"status": "APROVADO"}, "TECNICO": {"status": "APROVADO"}}'::jsonb,
   '["demo", "engenharia"]'::jsonb, 'd0000000-0000-4000-8000-000000000001'),
  ('d0000000-0000-4000-8000-000000000302', '99990002', '99990002', 'Manutenção industrial (demo)',
   'Família fictícia de demonstração.', 'FAMILIA', true, 'OPERACIONAL', 'ATIVA', 'A',
   now() + interval '180 days', now() + interval '120 days',
   '{"JURIDICO": {"status": "APROVADO"}, "TECNICO": {"status": "APROVADO"}}'::jsonb,
   '["demo", "manutencao"]'::jsonb, 'd0000000-0000-4000-8000-000000000001'),
  ('d0000000-0000-4000-8000-000000000303', '99990003', '99990003', 'Montagem eletromecânica (demo)',
   'Família fictícia de demonstração, em janela de renovação.', 'FAMILIA', true, 'OPERACIONAL', 'EM_RENOVACAO', 'Q',
   now() + interval '40 days', now() - interval '20 days',
   '{"JURIDICO": {"status": "APROVADO"}, "TECNICO": {"status": "EM_AVALIACAO"}}'::jsonb,
   '["demo", "montagem"]'::jsonb, 'd0000000-0000-4000-8000-000000000001'),
  ('d0000000-0000-4000-8000-000000000304', '99990004', '99990004', 'Inspeção de equipamentos (demo)',
   'Família fictícia de demonstração.', 'FAMILIA', true, 'OPERACIONAL', 'ATIVA', 'A',
   now() + interval '500 days', now() + interval '440 days',
   '{"TECNICO": {"status": "APROVADO"}}'::jsonb,
   '["demo", "inspecao"]'::jsonb, 'd0000000-0000-4000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;

-- ── PERFIS DE INTERESSE ──────────────────────────────────────────────────────
INSERT INTO perfis_interesse (id, nome, descricao, ativo, filtros) VALUES
  ('d0000000-0000-4000-8000-000000000401', 'Engenharia de processo', 'Projetos, apoio técnico e automação de plantas de processo.', true,
   '{"peso": 10, "natureza": ["SERVIÇO"], "tipo_servico": ["Engenharia e Projetos", "Apoio Técnico e Operacional"], "keywords_incluir": ["engenharia", "processo", "automação", "detalhamento"], "keywords_excluir": ["hotelaria"], "prazo_minimo_dias": 5}'::jsonb),
  ('d0000000-0000-4000-8000-000000000402', 'Manutenção industrial', 'Manutenção mecânica, caldeiraria, pintura e tanques.', true,
   '{"peso": 8, "natureza": ["SERVIÇO"], "tipo_servico": ["Manutenção e Reparo", "Pintura e Revestimento"], "keywords_incluir": ["manutenção", "tanques", "caldeiraria", "bombas"], "keywords_excluir": [], "prazo_minimo_dias": 5}'::jsonb),
  ('d0000000-0000-4000-8000-000000000403', 'Inspeção e integridade', 'Inspeção NR-13, dutos e calibração.', true,
   '{"peso": 7, "natureza": ["SERVIÇO"], "tipo_servico": ["Inspeção, Calibração e Monitoramento"], "keywords_incluir": ["inspeção", "integridade", "calibração"], "keywords_excluir": [], "prazo_minimo_dias": 3}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- ── ACERVO: OPERAÇÕES ────────────────────────────────────────────────────────
INSERT INTO operacoes (
  id, codigo, cliente_nome, cliente_grupo, cliente_cnpj, contrato_numero,
  unidade, detentora, ramo, onshore_offshore, periodo_inicio, periodo_fim,
  valor, hh, escopo, origem
) VALUES
  ('d0000000-0000-4000-8000-000000000501', 'OP-1001', 'Refinaria Exemplo do Nordeste', 'Grupo Petróleo Exemplo', '12345678000195', 'CT-2019-0001', 'Refinaria Exemplo — BA', 'PROPONENTE', 'Refino', 'ONSHORE', '2019-03-01', '2021-02-28', 18500000.00, 142000, 'Engenharia de detalhamento multidisciplinar para revamp de unidade de destilação.', 'MANUAL'),
  ('d0000000-0000-4000-8000-000000000502', 'OP-1002', 'Terminal Aquaviário Exemplo', 'Logística Exemplo S.A.', '23456789000195', 'CT-2020-0042', 'Terminal Exemplo — SP', 'PROPONENTE', 'Logística', 'ONSHORE', '2020-06-01', '2023-05-31', 9200000.00, 88000, 'Manutenção mecânica de bombas, válvulas e tanques de armazenamento.', 'MANUAL'),
  ('d0000000-0000-4000-8000-000000000503', 'OP-1003', 'Petroquímica Exemplo', NULL, '34567890000130', 'CT-2021-0107', 'Polo Exemplo — BA', 'PROPONENTE', 'Petroquímica', 'ONSHORE', '2021-01-15', '2022-07-14', 4300000.00, 31000, 'Inspeção de equipamentos estáticos e vasos de pressão (NR-13).', 'MANUAL'),
  ('d0000000-0000-4000-8000-000000000504', 'OP-1004', 'Unidade de Gás Exemplo', 'Grupo Petróleo Exemplo', '12345678000195', 'CT-2022-0015', 'UPGN Exemplo — ES', 'COLIGADA', 'Gás natural', 'ONSHORE', '2022-02-01', '2024-01-31', 12700000.00, 97000, 'Montagem eletromecânica de skids e interligações de processo.', 'MANUAL'),
  ('d0000000-0000-4000-8000-000000000505', 'OP-1005', 'Plataforma Exemplo P-00', 'Grupo Petróleo Exemplo', '12345678000195', 'CT-2023-0088', 'Bacia Exemplo', 'PROPONENTE', 'Exploração e produção', 'OFFSHORE', '2023-04-01', NULL, 6100000.00, 45000, 'Apoio técnico de engenharia à operação e confiabilidade de sistemas.', 'MANUAL'),
  ('d0000000-0000-4000-8000-000000000506', 'OP-1006', 'Indústria Química Exemplo', NULL, '45678901000175', 'CT-2018-0230', 'Fábrica Exemplo — RS', 'PARCEIRO', 'Química', 'ONSHORE', '2018-08-01', '2019-12-31', 2100000.00, 15000, 'Projeto executivo de sistema de combate a incêndio.', 'MANUAL')
ON CONFLICT (id) DO NOTHING;

-- Disciplinas de cada obra (o catálogo vem da migration 0043).
INSERT INTO operacao_disciplinas (operacao_id, disciplina_id)
SELECT o.id, d.id
  FROM (VALUES
    ('OP-1001', 'PRO'), ('OP-1001', 'TUB'), ('OP-1001', 'MEC'), ('OP-1001', 'INS'), ('OP-1001', 'ELE'),
    ('OP-1002', 'MEC'), ('OP-1002', 'CAL'), ('OP-1002', 'PIN'),
    ('OP-1003', 'MEC'), ('OP-1003', 'CAL'), ('OP-1003', 'SEG'),
    ('OP-1004', 'TUB'), ('OP-1004', 'ELE'), ('OP-1004', 'INS'), ('OP-1004', 'EST'),
    ('OP-1005', 'PRO'), ('OP-1005', 'PLA'),
    ('OP-1006', 'SEG'), ('OP-1006', 'TUB'), ('OP-1006', 'CIV')
  ) AS v(op, disc)
  JOIN operacoes o ON o.codigo = v.op
  JOIN disciplinas d ON d.codigo = v.disc
ON CONFLICT DO NOTHING;

-- ── ACERVO: DOCUMENTOS (só metadado) ─────────────────────────────────────────
INSERT INTO documentos_habilitacao (
  id, categoria, subcategoria, titulo, descricao, nome_arquivo, blob_url, blob_key,
  tamanho_bytes, content_type, numero_documento, emitido_em, validade_indeterminada,
  status, uploadado_por, operacao_id, papel, tipo_documento, situacao_prova, detentora
)
SELECT ('d0000000-0000-4000-8000-0000000006' || lpad(v.n::text, 2, '0'))::uuid,
       v.categoria, v.subcategoria, v.titulo, 'Documento fictício de demonstração (sem arquivo).',
       'demo-' || lpad(v.n::text, 2, '0') || '.pdf',
       'demo/demo-' || lpad(v.n::text, 2, '0') || '.pdf',
       'demo/demo-' || lpad(v.n::text, 2, '0') || '.pdf',
       250000 + v.n * 1000, 'application/pdf', v.numero, v.emitido::timestamptz, true,
       'VIGENTE', 'd0000000-0000-4000-8000-000000000001',
       o.id, v.papel, v.tipo, v.situacao, o.detentora
  FROM (VALUES
    ( 1, 'OP-1001', 'TECNICA',              'ATESTADO_ACT', 'Atestado de capacidade técnica — revamp de destilação', 'AT-0001', '2021-04-10', 'ATESTADO', 'ATESTADO', 'ASSINADA_CLIENTE'),
    ( 2, 'OP-1001', 'QUALIFICACAO_PESSOAL', 'ART_CAT',      'CAT com registro de atestado — revamp de destilação',   'CAT-0001', '2021-06-02', 'CAT_ART', 'CAT', 'ASSINADA_CLIENTE'),
    ( 3, 'OP-1001', 'TECNICA',              'OUTROS_TECNICOS', 'Contrato de prestação de serviços CT-2019-0001',    'CT-2019-0001', '2019-02-20', 'CONTRATO', 'CONTRATO', 'ASSINADA_CLIENTE'),
    ( 4, 'OP-1002', 'TECNICA',              'ATESTADO_ACT', 'Atestado de capacidade técnica — manutenção de terminal', 'AT-0002', '2023-07-01', 'ATESTADO', 'ATESTADO', 'ASSINADA_CLIENTE'),
    ( 5, 'OP-1002', 'QUALIFICACAO_PESSOAL', 'ART_CAT',      'ART de execução — manutenção de terminal',              'ART-0002', '2020-06-10', 'CAT_ART', 'ART', 'ASSINADA_PROPONENTE'),
    ( 6, 'OP-1003', 'TECNICA',              'ATESTADO_ACT', 'Atestado de capacidade técnica — inspeção NR-13',       'AT-0003', '2022-08-15', 'ATESTADO', 'ATESTADO', 'ASSINADA_CLIENTE'),
    ( 7, 'OP-1004', 'TECNICA',              'ATESTADO_ACT', 'Atestado de capacidade técnica — montagem de skids',    'AT-0004', '2024-03-05', 'ATESTADO', 'ATESTADO', 'RASCUNHO'),
    ( 8, 'OP-1004', 'QUALIFICACAO_PESSOAL', 'ART_CAT',      'ART de execução — montagem eletromecânica',             'ART-0004', '2022-02-15', 'CAT_ART', 'ART', 'ASSINADA_PROPONENTE'),
    ( 9, 'OP-1005', 'TECNICA',              'OUTROS_TECNICOS', 'Contrato de apoio técnico CT-2023-0088',             'CT-2023-0088', '2023-03-20', 'CONTRATO', 'CONTRATO', 'ASSINADA_CLIENTE'),
    (10, 'OP-1006', 'TECNICA',              'ATESTADO_ACT', 'Atestado de capacidade técnica — combate a incêndio',   'AT-0006', '2020-02-10', 'ATESTADO', 'ATESTADO', 'ASSINADA_CLIENTE')
  ) AS v(n, op, categoria, subcategoria, titulo, numero, emitido, papel, tipo, situacao)
  JOIN operacoes o ON o.codigo = v.op
ON CONFLICT (id) DO NOTHING;

-- Atestados vinculados às famílias fictícias.
INSERT INTO documentos_familias (documento_id, familia_id, observacao)
SELECT d.id, f.id, 'Vínculo de demonstração'
  FROM (VALUES
    ('AT-0001', '99990001'), ('AT-0002', '99990002'), ('AT-0003', '99990004'),
    ('AT-0004', '99990003'), ('AT-0006', '99990001')
  ) AS v(doc, fam)
  JOIN documentos_habilitacao d ON d.numero_documento = v.doc
  JOIN familias f ON f.codigo_crc = v.fam
 WHERE NOT EXISTS (
   SELECT 1 FROM documentos_familias x WHERE x.documento_id = d.id AND x.familia_id = f.id
 );

-- ── ACERVO: PROFISSIONAIS ────────────────────────────────────────────────────
INSERT INTO profissionais (id, nome, crea, crea_uf, formacao) VALUES
  ('d0000000-0000-4000-8000-000000000701', 'Eng. Fernanda Exemplo', '000000001-0', 'BA', 'Engenheira Química'),
  ('d0000000-0000-4000-8000-000000000702', 'Eng. Gustavo Modelo',   '000000002-0', 'SP', 'Engenheiro Mecânico'),
  ('d0000000-0000-4000-8000-000000000703', 'Eng. Helena Amostra',   '000000003-0', 'ES', 'Engenheira Eletricista')
ON CONFLICT (id) DO NOTHING;

INSERT INTO profissional_documentos (profissional_id, documento_id, papel, numero_art)
SELECT p.id, d.id, v.papel, v.art
  FROM (VALUES
    ('d0000000-0000-4000-8000-000000000701', 'AT-0001',  'RT',             'ART-0001'),
    ('d0000000-0000-4000-8000-000000000701', 'CAT-0001', 'RT',             'ART-0001'),
    ('d0000000-0000-4000-8000-000000000702', 'AT-0001',  'CORRESPONSAVEL', 'ART-0001B'),
    ('d0000000-0000-4000-8000-000000000702', 'AT-0002',  'RT',             'ART-0002'),
    ('d0000000-0000-4000-8000-000000000702', 'ART-0002', 'RT',             'ART-0002'),
    ('d0000000-0000-4000-8000-000000000702', 'AT-0003',  'RT',             'ART-0003'),
    ('d0000000-0000-4000-8000-000000000703', 'AT-0004',  'RT',             'ART-0004'),
    ('d0000000-0000-4000-8000-000000000703', 'ART-0004', 'RT',             'ART-0004'),
    ('d0000000-0000-4000-8000-000000000701', 'AT-0006',  'EQUIPE',         NULL)
  ) AS v(prof, doc, papel, art)
  JOIN profissionais p ON p.id = v.prof::uuid
  JOIN documentos_habilitacao d ON d.numero_documento = v.doc
ON CONFLICT DO NOTHING;

-- Atividades registradas nas ARTs/CATs (texto literal, como o documento traz).
INSERT INTO documento_atividades (documento_id, atividade, quantidade_texto, ordem)
SELECT d.id, v.atividade, v.qtd, v.ordem
  FROM (VALUES
    ('CAT-0001', 'Projeto de tubulação industrial',          '4.200 m',     1),
    ('CAT-0001', 'Projeto de instrumentação e controle',      '310 malhas',  2),
    ('ART-0002', 'Manutenção de bombas centrífugas',          '48 unidades', 1),
    ('ART-0002', 'Reparo de tanques de armazenamento',        '6 tanques',   2),
    ('ART-0004', 'Montagem de skids de medição',              '12 skids',    1),
    ('ART-0004', 'Montagem de painéis elétricos',             '35 painéis',  2)
  ) AS v(doc, atividade, qtd, ordem)
  JOIN documentos_habilitacao d ON d.numero_documento = v.doc
 WHERE NOT EXISTS (
   SELECT 1 FROM documento_atividades a WHERE a.documento_id = d.id AND a.atividade = v.atividade
 );

COMMIT;
