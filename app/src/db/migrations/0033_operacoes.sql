-- =============================================================================
-- 0033 — OPERAÇÕES: a obra vira entidade de primeira classe do cofre
-- =============================================================================
-- O cofre (documentos_habilitacao, migration 0005) foi modelado para CERTIDÃO:
-- 1 documento por tipo, com validade, e a nova SUBSTITUI a anterior (daí
-- `status='SUBSTITUIDO'`, `versao` e `documento_anterior_id`). O que de fato
-- entra nele é ATESTADO: N provas por obra, que NÃO vencem e se SOMAM (ACT +
-- CAT/ART + contrato + aditivo + nota fiscal da mesma operação).
--
-- Antes desta migration o cofre já tinha operações com mais de um documento,
-- duplicata exata que passou batido, e zero uso de
-- famílias/projetos/anexos/versão/tags. A operação só existia como
-- PREFIXO DIGITADO no título ("12345 - CLIENTE ..."): não dá para filtrar, não dá
-- para somar valor/HH por cliente e não dá para saber o que falta comprovar.
--
-- Esta migration cria a tabela `operacoes` (espelho da Relação de Operações do
-- catálogo do Acervo Técnico) e liga cada documento do cofre a uma
-- delas por FK, com `papel` dizendo O QUE aquele arquivo prova na operação.
--
-- ATENÇÃO — o que esta migration NÃO faz:
--   • NÃO insere as operações (carga de dados à parte, fora deste repositório)
--   • NÃO faz o backfill de operacao_id/papel dos documentos existentes
--     (também carga à parte)
-- Migration = estrutura; carga de dados fica fora, para poder reaplicar o
-- schema num banco limpo sem arrastar dado de negócio junto.
--
-- Idempotente (IF NOT EXISTS / DROP CONSTRAINT IF EXISTS + ADD). Fora do
-- journal do Drizzle — aplicada por db/scripts/apply-extra-migrations.sh, que
-- roda com `psql -v ON_ERROR_STOP=1`. Aplicação manual:
--   docker compose exec -T db psql -v ON_ERROR_STOP=1 -U petro -d petro_radar \
--     -f /app/src/db/migrations/0033_operacoes.sql
-- =============================================================================

-- ── 1) Tabela operacoes ──────────────────────────────────────────────────────
-- Chave de negócio é `codigo` (o número da Relação de Operações, "12345"), não
-- o uuid: é por ele que o seed casa (ON CONFLICT (codigo) DO NOTHING) e que o
-- backfill acha a operação a partir do prefixo do título. UNIQUE simples, sem
-- lower(): os códigos do catálogo são numéricos, e um índice único de
-- expressão quebraria o `ON CONFLICT (codigo)` do seed.
CREATE TABLE IF NOT EXISTS operacoes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo             text NOT NULL UNIQUE,   -- "12345" — código da Relação de Operações
  cliente_nome       text NOT NULL,          -- razão social do contratante
  cliente_grupo      text,                   -- "Petrobras" unificado (o catálogo separa Petrobras × Petrobras Transpetro)
  cliente_cnpj       text,                   -- só dígitos, quando conhecido
  contrato_numero    text,
  unidade            text,                   -- unidade/local da obra (REF-A, TSC, FPSO ...)
  detentora          text NOT NULL DEFAULT 'PROPONENTE',  -- de QUEM é o acervo: pode ser de terceiro (COLIGADA/parceiro)
  ramo               text,                   -- ramo de atividade do cliente
  onshore_offshore   text,
  periodo_inicio     date,
  periodo_fim        date,
  valor              numeric(18,2),
  hh                 numeric(14,2),
  escopo             text,                   -- objeto do contrato
  familias_sugeridas jsonb,                  -- códigos CRC do catálogo: REFERÊNCIA, não vínculo (o vínculo real é documentos_familias)
  origem             text NOT NULL DEFAULT 'CATALOGO',  -- CATALOGO (seed 0033) | MANUAL (cadastro na tela)
  ativo              boolean NOT NULL DEFAULT true,
  criado_em          timestamptz DEFAULT now(),
  atualizado_em      timestamptz DEFAULT now()
);

-- `detentora` é campo de primeira classe porque decide se a prova SERVE: um
-- atestado da COLIGADA só habilita a Proponente em licitação que aceite coligada.
-- O catálogo hoje só tem PROPONENTE e COLIGADA; PARCEIRO fica previsto
-- para consórcio/subcontratação.
ALTER TABLE operacoes DROP CONSTRAINT IF EXISTS chk_operacao_detentora;
ALTER TABLE operacoes ADD CONSTRAINT chk_operacao_detentora
  CHECK (detentora IN ('PROPONENTE', 'COLIGADA', 'PARCEIRO'));

-- CATALOGO = veio da Relação de Operações (semeada); MANUAL = cadastrada na
-- tela de upload. Separar as duas permite re-semear o catálogo sem pisar no
-- que foi digitado à mão.
ALTER TABLE operacoes DROP CONSTRAINT IF EXISTS chk_operacao_origem;
ALTER TABLE operacoes ADD CONSTRAINT chk_operacao_origem
  CHECK (origem IN ('CATALOGO', 'MANUAL'));

-- Recorte de "todas as obras do grupo Petrobras" — o corte mais usado.
CREATE INDEX IF NOT EXISTS idx_oper_cliente_grupo ON operacoes (cliente_grupo);

-- Índice de expressão para casar cliente sem depender de caixa. Serve
-- igualdade e prefixo (`lower(cliente_nome) LIKE 'petrobras%'`), que é o que o
-- gerador do seed e a deduplicação de cliente usam. NÃO serve o
-- `ILIKE '%termo%'` da busca da tela — mas com poucas centenas de linhas o seq scan é
-- irrelevante, então não criamos GIN trigram aqui (ver 0017/0018, onde o
-- trigram só entrou nas tabelas de dezenas de milhares de linhas).
CREATE INDEX IF NOT EXISTS idx_oper_cliente_nome ON operacoes (lower(cliente_nome));

COMMENT ON TABLE operacoes IS
  'Relação de Operações (acervo técnico): a obra como entidade. 1 operação : N provas em documentos_habilitacao.';
COMMENT ON COLUMN operacoes.detentora IS
  'PROPONENTE | COLIGADA | PARCEIRO — de quem é o acervo. Decide se a prova serve para habilitar a Proponente.';
COMMENT ON COLUMN operacoes.familias_sugeridas IS
  'Códigos CRC sugeridos pelo catálogo (array json de texto). Referência para triagem — o vínculo que vale é documentos_familias.';
COMMENT ON COLUMN operacoes.origem IS
  'CATALOGO = semeada por carga de catálogo; MANUAL = cadastrada pela tela (POST /api/conformidade/operacoes).';
COMMENT ON COLUMN operacoes.atualizado_em IS
  'NÃO há trigger de atualização no banco (nenhuma tabela deste schema tem) — todo UPDATE precisa setar atualizado_em = now() explicitamente.';

-- ── 2) documentos_habilitacao ← operação ─────────────────────────────────────
-- ON DELETE SET NULL: apagar uma operação (cadastro manual errado) não pode
-- levar junto a prova digitalizada; o documento volta a ficar solto no cofre.
ALTER TABLE documentos_habilitacao
  ADD COLUMN IF NOT EXISTS operacao_id uuid,
  ADD COLUMN IF NOT EXISTS papel       text;

-- A FK vem separada do ADD COLUMN de propósito: `ADD COLUMN IF NOT EXISTS` com
-- REFERENCES inline PULA a constraint inteira quando a coluna já existe (numa
-- base onde a coluna foi criada à mão, a FK nunca apareceria). Nomeada +
-- DROP/ADD garante o estado final, no mesmo padrão da 0032.
ALTER TABLE documentos_habilitacao DROP CONSTRAINT IF EXISTS fk_doch_operacao;
ALTER TABLE documentos_habilitacao ADD CONSTRAINT fk_doch_operacao
  FOREIGN KEY (operacao_id) REFERENCES operacoes(id) ON DELETE SET NULL;

-- `papel` diz O QUE o arquivo prova NA operação (o par categoria/subcategoria
-- continua dizendo o que ele é do ponto de vista de habilitação).
-- CAT/ART tem dois destinos por decisão de escopo: quando INSTRUI um atestado
-- específico entra como anexo daquele documento (documentos_habilitacao_anexos);
-- quando é prova autônoma de acervo profissional, é documento com papel CAT_ART.
--
-- O `papel IS NULL OR` NÃO é decoração: as linhas que já existem nascem com
-- papel NULL e só ganham 'ATESTADO' no backfill (que roda DEPOIS, e é um seed).
-- Sem essa cláusula o ADD CONSTRAINT falha, e com ON_ERROR_STOP=1 derruba a
-- migration inteira.
ALTER TABLE documentos_habilitacao DROP CONSTRAINT IF EXISTS chk_doch_papel;
ALTER TABLE documentos_habilitacao ADD CONSTRAINT chk_doch_papel
  CHECK (papel IS NULL OR papel IN (
    'ATESTADO', 'CAT_ART', 'CONTRATO', 'ADITIVO', 'NOTA_FISCAL', 'DECLARACAO', 'OUTRO'
  ));

-- Fila quente das duas telas novas: a lista agrupada por operação
-- (COUNT por operacao_id) e o dossiê (WHERE operacao_id = $1). Também cobre o
-- SET NULL do DELETE de operação, que sem índice varre a tabela toda.
CREATE INDEX IF NOT EXISTS idx_doch_operacao ON documentos_habilitacao (operacao_id);

COMMENT ON COLUMN documentos_habilitacao.operacao_id IS
  'Operação (obra) que este documento comprova. NULL = prova solta / documento que não é de obra (certidão, ISO, declaração).';
COMMENT ON COLUMN documentos_habilitacao.papel IS
  'ATESTADO | CAT_ART | CONTRATO | ADITIVO | NOTA_FISCAL | DECLARACAO | OUTRO — papel da prova na operação. NULL = anterior à 0033 ou não classificado.';
