-- =============================================================================
-- 0034 — DOSSIÊ DA OPERAÇÃO: as 6 colunas que faltam para a ficha existir
-- =============================================================================
-- A 0033 ligou documento a operação (operacao_id + papel). Esta migration dá ao
-- documento o vocabulário do DOSSIÊ (N1..N6):
--   N1 tipo_documento — a seção da ficha deriva DELE (por `papel`, a maior
--      parte do acervo cai em dois baldes indistintos);
--   N2 situacao_prova — há arquivo com sinal de não-prova no nome (minuta,
--      cancelado, modelo) classificado como prova; sem a coluna a barra
--      de comprovação mente para cima;
--   N3 detentora NO DOCUMENTO — atestado de coligada pode chegar sem
--      operação, logo sem detentora herdada; e fk_doch_operacao é ON DELETE
--      SET NULL, então apagar operação apagaria o rótulo em silêncio;
--   N4 restrito — operações com cláusula de sigilo;
--   N5 import_job_id — a chave do DESFAZER (sem ela uma ingestão de mil linhas
--      é irreversível);
--   N6 origem_path — reconciliação disco × cofre.
--
-- DIFERENTE da 0033, esta migration TAMBÉM carimba o dossiê nos documentos que
-- já existem (backfill EMBUTIDO — parte 2 deste arquivo, decisão da rodada de
-- implementação; o plano original previa seed separado). Como o
-- apply-extra-migrations.sh reaplica TODAS as extras a cada `make migrate`, o
-- backfill foi desenhado para reaplicação segura:
--   • tipo_documento e detentora: predicados idempotentes por IS NULL, que
--     CONVERGEM — na 1ª aplicação em produção os legados ainda estão sem
--     papel/operacao_id (o backfill da 0033 é seed e roda DEPOIS do migrate),
--     então essas duas colunas só completam na reaplicação seguinte;
--   • situacao_prova = INDEFINIDA: SÓ na primeira aplicação (sentinela
--     _0034_sentinela). "Avaliada e indefinida" é o carimbo do LEGADO; um
--     documento novo com situacao_prova NULL significa "não avaliada" e NÃO
--     pode ganhar INDEFINIDA num make migrate futuro — apagaria a distinção
--     que a coluna existe para registrar.
--
-- ORDEM RECOMENDADA NO DEPLOY (para o dossiê dos legados ficar completo):
--   1) make migrate            (aplica 0033 + 0034; carimba situacao_prova)
--   2) carga das operações + backfill da 0033 (dados à parte, fora do repositório)
--   3) make migrate            (reaplica 0034; completa tipo_documento e
--                               detentora a partir do papel/operação da etapa 2)
-- Conferência manual do placar (esperado: os três contadores iguais ao total):
--   SELECT count(*) FILTER (WHERE tipo_documento IS NOT NULL) AS com_tipo,
--          count(*) FILTER (WHERE situacao_prova IS NOT NULL) AS com_situacao,
--          count(*) FILTER (WHERE detentora IS NOT NULL)      AS com_detentora
--   FROM documentos_habilitacao;
--
-- O que esta migration NÃO faz:
--   • NÃO cria a tabela-espelho de auditoria -> 0035_audit_restrito.sql
--   • NÃO cria ordem_no_grupo nem numero_art (decidido não criar)
--   • NÃO insere operações (carga de dados à parte)
--
-- PRÉ-REQUISITO: 0033 aplicada (documentos_habilitacao e import_jobs existem).
-- Num banco sem elas o primeiro ALTER falha alto — é o comportamento desejado.
--
-- Idempotente (IF NOT EXISTS / DROP CONSTRAINT IF EXISTS + ADD; backfill por
-- IS NULL + sentinela). Transação única: falha no meio NÃO deixa DDL aplicada
-- com backfill perdido — reverte tudo e a reaplicação recomeça do zero.
-- Fora do journal do Drizzle — aplicada por db/scripts/apply-extra-migrations.sh,
-- que roda com `psql -v ON_ERROR_STOP=1`. Aplicação manual:
--   docker compose exec -T db psql -v ON_ERROR_STOP=1 -U petro -d petro_radar \
--     -f /app/src/db/migrations/0034_dossie_operacao.sql
-- =============================================================================

BEGIN;

-- ── Sentinela de primeira aplicação ──────────────────────────────────────────
-- Capturada ANTES do primeiro ALTER: se `tipo_documento` já existia quando este
-- arquivo começou a rodar, é reaplicação — e o carimbo de situacao_prova (parte
-- 2.2) não roda de novo. Temp table com ON COMMIT DROP: some sozinha no COMMIT.
CREATE TEMP TABLE _0034_sentinela ON COMMIT DROP AS
SELECT EXISTS (
  SELECT 1
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name   = 'documentos_habilitacao'
    AND column_name  = 'tipo_documento'
) AS ja_aplicada;

-- ═════════════════════════════════════════════════════════════════════════════
-- PARTE 1 — ESTRUTURA (DDL)
-- ═════════════════════════════════════════════════════════════════════════════

-- ── N1 · tipo_documento ──────────────────────────────────────────────────────
-- NULL = "Sem tipo definido" (seção 9, fila de trabalho), nunca um 21º valor.
ALTER TABLE documentos_habilitacao
  ADD COLUMN IF NOT EXISTS tipo_documento text;

-- DROP IF EXISTS + ADD nomeada (não DO $$): o par não emite NOTICE, não duplica
-- constraint e o ADD revalida a tabela inteira a cada reaplicação — dado que
-- viole o CHECK derruba o make migrate em vez de conviver com lixo.
ALTER TABLE documentos_habilitacao DROP CONSTRAINT IF EXISTS chk_doch_tipo_documento;
ALTER TABLE documentos_habilitacao ADD CONSTRAINT chk_doch_tipo_documento
  CHECK (tipo_documento IS NULL OR tipo_documento IN (
    'ART', 'CAT', 'ATESTADO', 'CONTRATO', 'ADITIVO', 'ANEXO_CONTRATO',
    'CREA_PJ', 'ISO', 'DECLARACAO', 'PROPOSTA', 'ANEXO_ET', 'DOC_PROJETO',
    'PEDIDO', 'NF', 'CARTA', 'RELATORIO', 'PESSOAL', 'CAPA_OP',
    'COMPACTADO', 'OUTRO'
  ));

CREATE INDEX IF NOT EXISTS idx_doch_tipo_documento
  ON documentos_habilitacao (tipo_documento);

-- ── N2 · situacao_prova ──────────────────────────────────────────────────────
-- NULL = anterior à 0034 / não avaliada. RASCUNHO/SUPERADA/CANCELADA/MODELO
-- NÃO contam na barra de comprovação (regra única).
ALTER TABLE documentos_habilitacao
  ADD COLUMN IF NOT EXISTS situacao_prova text;

ALTER TABLE documentos_habilitacao DROP CONSTRAINT IF EXISTS chk_doch_situacao_prova;
ALTER TABLE documentos_habilitacao ADD CONSTRAINT chk_doch_situacao_prova
  CHECK (situacao_prova IS NULL OR situacao_prova IN (
    'RASCUNHO', 'ASSINADA_PROPONENTE', 'ASSINADA_CLIENTE',
    'SUPERADA', 'CANCELADA', 'MODELO', 'INDEFINIDA'
  ));

-- ── N3 · detentora NO DOCUMENTO ──────────────────────────────────────────────
ALTER TABLE documentos_habilitacao
  ADD COLUMN IF NOT EXISTS detentora text;

ALTER TABLE documentos_habilitacao DROP CONSTRAINT IF EXISTS chk_doch_detentora;
ALTER TABLE documentos_habilitacao ADD CONSTRAINT chk_doch_detentora
  CHECK (detentora IS NULL OR detentora IN ('PROPONENTE', 'COLIGADA', 'PARCEIRO'));

-- ── N4 · restrito ────────────────────────────────────────────────────────────
-- Grão do DOCUMENTO: o contrato é restrito, o atestado da mesma obra não.
-- Índice PARCIAL: a fração true é ínfima e o predicado quente é "só os
-- restritos" (auditoria) — um índice cheio de false não paga.
ALTER TABLE documentos_habilitacao
  ADD COLUMN IF NOT EXISTS restrito boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_doch_restrito
  ON documentos_habilitacao (restrito) WHERE restrito;

-- ── N5 · import_job_id ───────────────────────────────────────────────────────
-- SET NULL: apagar o job não pode levar o documento. FK separada do ADD COLUMN
-- de propósito (mesmo motivo da 0033: ADD COLUMN IF NOT EXISTS com REFERENCES
-- inline PULA a constraint quando a coluna já existe).
ALTER TABLE documentos_habilitacao
  ADD COLUMN IF NOT EXISTS import_job_id uuid;

ALTER TABLE documentos_habilitacao DROP CONSTRAINT IF EXISTS fk_doch_import_job;
ALTER TABLE documentos_habilitacao ADD CONSTRAINT fk_doch_import_job
  FOREIGN KEY (import_job_id) REFERENCES import_jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_doch_import_job
  ON documentos_habilitacao (import_job_id);

-- ── N6 · origem_path ─────────────────────────────────────────────────────────
ALTER TABLE documentos_habilitacao
  ADD COLUMN IF NOT EXISTS origem_path text;

-- ── Comentários ──────────────────────────────────────────────────────────────
COMMENT ON COLUMN documentos_habilitacao.tipo_documento IS
  'Taxonomia fina (20 valores) que gera a seção da ficha da operação. NULL = seção 9 "Sem tipo definido" (fila de trabalho).';
COMMENT ON COLUMN documentos_habilitacao.situacao_prova IS
  'RASCUNHO|ASSINADA_PROPONENTE|ASSINADA_CLIENTE|SUPERADA|CANCELADA|MODELO|INDEFINIDA — rascunho/superada/cancelada/modelo NÃO contam na barra de comprovação.';
COMMENT ON COLUMN documentos_habilitacao.detentora IS
  'PROPONENTE|COLIGADA|PARCEIRO — de quem é ESTA prova. Independente da operação: órfão precisa carregar a marca (evita falso positivo de família).';
COMMENT ON COLUMN documentos_habilitacao.restrito IS
  'true = documento sob cláusula de sigilo (ex.: contrato com NDA). Só ADMIN/LIDER/SGI veem, listam, baixam. Download espelhado fora do expurgo (0035).';
COMMENT ON COLUMN documentos_habilitacao.import_job_id IS
  'Rodada de ingestão que criou esta linha. Chave do desfazer — import_jobs nunca é apagado.';
COMMENT ON COLUMN documentos_habilitacao.origem_path IS
  'Caminho relativo do arquivo na árvore de origem do acervo na data da ingestão. Reconciliação disco × cofre.';

-- ═════════════════════════════════════════════════════════════════════════════
-- PARTE 2 — BACKFILL DO DOSSIÊ NOS DOCUMENTOS EXISTENTES
-- ═════════════════════════════════════════════════════════════════════════════
-- As três regras travadas:
--   1) tipo_documento derivado de papel/subcategoria (projeção inversa do
--      de-para canônico — o de-para é UMA decisão);
--   2) situacao_prova = 'INDEFINIDA' (legado foi aceito como prova sem
--      avaliação de assinatura: "avaliada e não concluída", conta na barra);
--   3) detentora herdada de operacoes.detentora (único sinal disponível;
--      órfão fica NULL — a marca errada é o mecanismo do falso positivo).
-- import_job_id e origem_path ficam NULL de propósito: os legados entraram
-- pela tela, não por ingestão — NULL é o valor verdadeiro.
-- NÃO toca atualizado_em: backfill de sistema, não edição de usuário (mesma
-- decisão do backfill da 0033; mesmo critério da 0016).

-- 2.1) tipo_documento <- papel/subcategoria. Papel OUTRO e papel NULL ficam com
--      tipo NULL: caem na seção 9 "Sem tipo definido", que é fila de trabalho —
--      não se chuta tipo. CAT_ART: 'ART' é o palpite de menor erro (ART é muito
--      mais frequente que CAT); o regex \mCAT\M só resgata título que diz CAT sem dizer
--      ART. Erro residual corrige-se pela tela — presunção
--      documentada, como o COALESCE 'ATESTADO' do backfill da 0033.
--      SEM sentinela de propósito: em produção o papel dos legados só nasce no
--      backfill da 0033 (seed, roda DEPOIS do migrate) — é a REAPLICAÇÃO desta
--      migration que completa o tipo. Consequência aceita e documentada:
--      documento futuro com papel definido e tipo deixado NULL também ganha o
--      tipo derivado no próximo make migrate (mesma projeção canônica).
UPDATE documentos_habilitacao
SET tipo_documento = CASE
  WHEN papel = 'ATESTADO'    THEN 'ATESTADO'
  WHEN papel = 'CONTRATO'    THEN 'CONTRATO'
  WHEN papel = 'ADITIVO'     THEN 'ADITIVO'
  WHEN papel = 'NOTA_FISCAL' THEN 'NF'
  WHEN papel = 'DECLARACAO' AND subcategoria = 'CREA_PJ'                             THEN 'CREA_PJ'
  WHEN papel = 'DECLARACAO' AND subcategoria IN ('ISO_9001','ISO_14001','ISO_45001') THEN 'ISO'
  WHEN papel = 'DECLARACAO'  THEN 'DECLARACAO'
  WHEN papel = 'CAT_ART' AND titulo ~* '\mCAT\M' AND titulo !~* '\mART\M'            THEN 'CAT'
  WHEN papel = 'CAT_ART'     THEN 'ART'
END
WHERE tipo_documento IS NULL
  AND papel IN ('ATESTADO','CAT_ART','CONTRATO','ADITIVO','NOTA_FISCAL','DECLARACAO');

-- 2.2) situacao_prova: legado vira INDEFINIDA (avaliado, sem conclusão).
--      COM sentinela: roda UMA vez, na primeira aplicação. Documento criado
--      depois da 0034 com situacao_prova NULL significa "não avaliada" e um
--      make migrate futuro NÃO pode transformá-lo em "avaliada e indefinida".
--      (Este UPDATE não depende do backfill da 0033 — carimba os legados já na
--      primeira aplicação, antes de papel/operacao existirem.)
UPDATE documentos_habilitacao
SET situacao_prova = 'INDEFINIDA'
WHERE situacao_prova IS NULL
  AND NOT (SELECT ja_aplicada FROM _0034_sentinela);

-- 2.3) detentora herdada da operação (só quem TEM operação; órfão fica NULL).
--      SEM sentinela pelo mesmo motivo de 2.1 (converge na reaplicação, depois
--      do backfill da 0033). Herdar em reaplicações futuras é a própria regra
--      do domínio: documento com operação e sem detentora herda a da operação.
UPDATE documentos_habilitacao d
SET detentora = o.detentora
FROM operacoes o
WHERE d.operacao_id = o.id
  AND d.detentora IS NULL;

COMMIT;
