-- 0043_acervo_disciplina_profissional.sql
--
-- DISCIPLINA e PROFISSIONAL no acervo: as duas chaves pelas quais o edital
-- escreve a exigencia tecnica e pelas quais a habilitacao e julgada.
--
-- POR QUE
-- -------
-- O edital nao pede "documento": pede "atestado de montagem de tubulacao" e
-- "acervo tecnico do responsavel tecnico em instrumentacao". Hoje o acervo nao
-- sabe responder nenhuma das duas:
--   * `disciplina` tem ZERO ocorrencia no schema;
--   * o responsavel tecnico existe como TRES colunas de TEXTO LIVRE em
--     documentos_projetos (engenheiro_responsavel, registro_crea, numero_art) —
--     nao da para listar as obras de um engenheiro, nem contar quantas.
--
-- O QUE ENTRA
-- -----------
--   disciplinas             catalogo curto, escrito a mao (codigo UNIQUE).
--   operacao_disciplinas    quais disciplinas a OBRA teve (N:N).
--   documentos_habilitacao.disciplina_id   qual disciplina o DOCUMENTO prova.
--   profissionais           o RT como entidade (sem CPF — ver LGPD abaixo).
--   profissional_documentos qual documento cada profissional assina, e como.
--   documento_atividades    o que a ART lista, com a quantidade como TEXTO.
--   detentora_cnpj          em operacoes e documentos_habilitacao.
--
-- O QUE NAO EXISTE DE PROPOSITO
-- -----------------------------
-- * `profissionais` NAO tem CPF. lib/seguranca/pii.ts redige CPF do ocr_texto
--   antes de gravar e o BFF espelha; guardar CPF aqui contrariaria a politica
--   do proprio modulo. O CREA identifica o profissional para habilitacao.
-- * `documento_atividades` NAO tem `quantidade numeric` nem `unidade_id`. A
--   quantidade da atividade e TEXTO (`quantidade_texto`), evidencia literal do
--   que a ART escreveu, exibida e nunca somada.
-- * `disciplinas` NAO tem CHECK de enum nem tupla espelho no TS: e catalogo de
--   LINHA (cresce com o uso), nao dominio fechado. O rotulo vem do banco.
--
-- Idempotente (IF NOT EXISTS / DO $$ com checagem em pg_constraint / DROP+ADD
-- para constraint sobre coluna preexistente / ON CONFLICT DO NOTHING / UPDATE
-- com predicado). Fora do journal do Drizzle — aplicada por
-- db/scripts/apply-extra-migrations.sh, DEPOIS da 0042.

-- ── 1) disciplinas ───────────────────────────────────────────────────────────
-- Catalogo curto, `codigo` como chave de negocio
-- (o seed casa por ele), `ativo` em vez de DELETE (disciplina em desuso
-- continua referenciada pelo historico). Sem timestamps: ninguem audita a
-- criacao de uma linha de catalogo escrita a mao na migration.
CREATE TABLE IF NOT EXISTS disciplinas (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo text NOT NULL UNIQUE,             -- 'TUB', 'EST', 'INS'...
  nome   text NOT NULL,                    -- rotulo de tela; vem daqui, nunca do TS
  ordem  integer NOT NULL DEFAULT 0,       -- ordem de exibicao (select, chips, cobertura)
  ativo  boolean NOT NULL DEFAULT true
);
--> statement-breakpoint

-- Sem indice alem do UNIQUE de `codigo`: sao 16 linhas, e todo SELECT desta
-- tabela e um seq scan mais barato que qualquer indice.

-- Seed do catalogo. UMA TUPLA POR LINHA, no formato exato
-- ('CODIGO', 'Nome', ordem) — e contrato com o teste que le este arquivo por
-- regex. Quem reformatar o INSERT ve o teste cair, de proposito.
--
-- A lista cobre as disciplinas usuais de engenharia industrial. Ela vai
-- REFINAR com o uso: acrescentar disciplina e acrescentar tupla (numa migration
-- futura), nunca escrever codigo novo no TS.
--
-- ON CONFLICT (codigo) DO NOTHING: a reaplicacao nao duplica. Consequencia
-- declarada — corrigir o `nome` de uma disciplina ja semeada exige um UPDATE
-- explicito numa migration posterior (o DO NOTHING nao atualiza).
INSERT INTO disciplinas (codigo, nome, ordem) VALUES
  ('TUB', 'Tubulação', 1),
  ('EST', 'Estruturas metálicas', 2),
  ('CIV', 'Civil', 3),
  ('MEC', 'Mecânica e equipamentos', 4),
  ('ELE', 'Elétrica', 5),
  ('INS', 'Instrumentação e automação', 6),
  ('PRO', 'Processo', 7),
  ('CAL', 'Caldeiraria', 8),
  ('SOL', 'Soldagem', 9),
  ('PIN', 'Pintura e isolamento', 10),
  ('GEO', 'Geotecnia e fundações', 11),
  ('ARQ', 'Arquitetura', 12),
  ('SEG', 'Segurança e SMS', 13),
  ('TEL', 'Telecomunicações', 14),
  ('PLA', 'Planejamento e gestão', 15),
  ('DOC', 'Documentação técnica', 16)
ON CONFLICT (codigo) DO NOTHING;
--> statement-breakpoint

COMMENT ON TABLE disciplinas IS
  'Catalogo de disciplinas tecnicas do acervo. `codigo` e a chave de negocio (3 letras maiusculas); `nome` e o rotulo de tela e vem DAQUI, nunca de tupla no TS. Sem CHECK de enum: e catalogo de linha, que cresce com o uso. `ativo` em vez de DELETE — disciplina em desuso continua referenciada pelo historico.';
--> statement-breakpoint

-- ── 2) operacao_disciplinas ──────────────────────────────────────────────────
-- Quais disciplinas a OBRA teve. PK composta: o par e a linha inteira, nao ha
-- atributo proprio alem de quando foi vinculado.
--
-- POR QUE os dois lados sao CASCADE (e `documentos_habilitacao.disciplina_id`
-- e SET NULL): aqui a linha NAO tem conteudo proprio — sem a operacao ou sem a
-- disciplina ela nao diz nada. La, o documento continua existindo e provando o
-- que provava; so perde o rotulo.
CREATE TABLE IF NOT EXISTS operacao_disciplinas (
  operacao_id   uuid NOT NULL REFERENCES operacoes(id)   ON DELETE CASCADE,
  disciplina_id uuid NOT NULL REFERENCES disciplinas(id) ON DELETE CASCADE,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operacao_id, disciplina_id)
);
--> statement-breakpoint

-- A PK ja resolve "as disciplinas DESTA operacao" (o lado esquerdo da chave).
-- Este indice resolve o contrario — "as operacoes DESTA disciplina" —, que e
-- a consulta do C3 (cobertura por disciplina) e do filtro da tela de operacoes.
CREATE INDEX IF NOT EXISTS idx_opdisc_disciplina ON operacao_disciplinas (disciplina_id);
--> statement-breakpoint

COMMENT ON TABLE operacao_disciplinas IS
  'N:N entre operacao e disciplina: o que a obra teve. PK composta (operacao_id, disciplina_id); CASCADE nos dois lados porque a linha nao tem conteudo proprio. Escrita apenas pelo PUT /api/conformidade/operacoes/[id]/disciplinas, em transacao (delete+insert), com audit DEFINIR_DISCIPLINAS_OPERACAO.';
--> statement-breakpoint

-- ── 3) documentos_habilitacao.disciplina_id ──────────────────────────────────
-- Qual disciplina o DOCUMENTO prova. Nullable: documento sem disciplina segue
-- identico ao de hoje, e a coluna entra como FILTRO, nunca como obrigacao.
ALTER TABLE documentos_habilitacao ADD COLUMN IF NOT EXISTS disciplina_id uuid;
--> statement-breakpoint

-- FK separada do ADD COLUMN de proposito: `ADD COLUMN IF NOT EXISTS ...
-- REFERENCES` PULA a constraint inteira quando a coluna ja existe (mesma nota
-- da 0033, fk_doch_operacao). Nomeada + DROP/ADD garante o estado final.
-- SET NULL: apagar uma disciplina do catalogo nao pode apagar documento.
ALTER TABLE documentos_habilitacao DROP CONSTRAINT IF EXISTS fk_doch_disciplina;
--> statement-breakpoint
ALTER TABLE documentos_habilitacao ADD CONSTRAINT fk_doch_disciplina
  FOREIGN KEY (disciplina_id) REFERENCES disciplinas(id) ON DELETE SET NULL;
--> statement-breakpoint

-- Parcial: hoje a coluna nasce NULL em todas as linhas e um indice cheio de NULL
-- nao paga.
CREATE INDEX IF NOT EXISTS idx_doch_disciplina
  ON documentos_habilitacao (disciplina_id) WHERE disciplina_id IS NOT NULL;
--> statement-breakpoint

COMMENT ON COLUMN documentos_habilitacao.disciplina_id IS
  'Disciplina que ESTE documento prova (0043). Nullable: documento sem disciplina se comporta como antes. FK ON DELETE SET NULL; indice parcial. Preenchida pelo PATCH/POST do cofre, nunca por heuristica.';
--> statement-breakpoint

-- ── 4) profissionais ─────────────────────────────────────────────────────────
-- O RT como ENTIDADE. Hoje ele e texto livre em tres colunas de
-- documentos_projetos — e por isso nao da para listar as obras de um
-- engenheiro. (`participacoes_licitacao.responsavel_tecnico -> users` NAO
-- serve: e o usuario do sistema que acompanha a licitacao, nao o profissional
-- que assina a ART.)
--
-- SEM CPF, de proposito: ver o cabecalho (LGPD). `crea` identifica.
CREATE TABLE IF NOT EXISTS profissionais (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome     text NOT NULL,
  crea     text,                      -- numero do registro, como esta no documento
  crea_uf  text,                      -- UF do registro ('BA', 'RJ')
  formacao text,                      -- titulo profissional ('Engenheiro Mecanico')
  ativo    boolean NOT NULL DEFAULT true,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  -- Sem trigger (regra da casa): todo UPDATE seta na mao.
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

DO $$
BEGIN
  -- `nome` e o unico campo obrigatorio, e vem de texto livre no backfill.
  -- Sem este CHECK, uma linha com nome ' ' entraria e a tela mostraria um
  -- profissional sem nome que ninguem consegue corrigir por busca.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_prof_nome' AND conrelid = 'profissionais'::regclass
  ) THEN
    ALTER TABLE profissionais ADD CONSTRAINT chk_prof_nome
      CHECK (length(btrim(nome)) >= 2);
  END IF;

  -- UF em duas maiusculas ou NULL. Nao e enum de 27 valores por escolha: a
  -- forma ja impede o lixo ('Bahia', 'ba ') e um catalogo de UF seria uma
  -- tabela a mais para nada.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_prof_crea_uf' AND conrelid = 'profissionais'::regclass
  ) THEN
    ALTER TABLE profissionais ADD CONSTRAINT chk_prof_crea_uf
      CHECK (crea_uf IS NULL OR crea_uf ~ '^[A-Z]{2}$');
  END IF;

  -- CREA vazio e CREA ausente sao a mesma coisa, e o indice unico parcial
  -- abaixo trata NULL como "sem registro". Sem este CHECK, duas linhas com
  -- crea = '' passariam pelo unique (string vazia nao e NULL) e virariam dois
  -- profissionais sem registro que o backfill nunca reconcilia.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_prof_crea' AND conrelid = 'profissionais'::regclass
  ) THEN
    ALTER TABLE profissionais ADD CONSTRAINT chk_prof_crea
      CHECK (crea IS NULL OR length(btrim(crea)) >= 3);
  END IF;
END $$;
--> statement-breakpoint

-- A chave de deduplicacao (§1d): uma pessoa, um CREA. PARCIAL porque
-- profissional sem registro informado e caso real e frequente no acervo — e
-- N linhas com crea NULL tem de conviver.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_profissional_crea
  ON profissionais (crea) WHERE crea IS NOT NULL;
--> statement-breakpoint

-- Busca por nome na tela /acervo/profissionais, sem depender de caixa (mesmo
-- molde do idx_oper_cliente_nome da 0033).
CREATE INDEX IF NOT EXISTS idx_profissional_nome ON profissionais (lower(nome));
--> statement-breakpoint

COMMENT ON TABLE profissionais IS
  'Responsavel tecnico / profissional do acervo. SEM CPF de proposito (lib/seguranca/pii.ts redige CPF do ocr_texto; guardar aqui contrariaria a politica) — o CREA identifica. Deduplicacao: indice unico PARCIAL em `crea` (uma pessoa, um registro); sem crea, a chave e lower(nome) e a decisao e humana. As tres colunas de texto de documentos_projetos ficam onde estao: sao a origem do backfill.';
--> statement-breakpoint

-- ── 5) profissional_documentos ───────────────────────────────────────────────
-- Qual documento cada profissional assina, e COMO. `papel` aqui e o papel do
-- PROFISSIONAL no documento (RT / corresponsavel / equipe) — nao confundir com
-- `documentos_habilitacao.papel`, que diz o que o ARQUIVO prova na operacao
-- (ATESTADO, CONTRATO...). Os dois CHECKs tem nomes distintos por isso.
--
-- CASCADE nos dois lados: o vinculo nao sobrevive nem ao profissional nem ao
-- documento — sem um dos dois nao ha o que dizer. `numero_art` fica NA LINHA
-- (e nao so em documentos_projetos) porque a ART e do par profissional x
-- documento: dois corresponsaveis do mesmo atestado tem numeros diferentes.
CREATE TABLE IF NOT EXISTS profissional_documentos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profissional_id uuid NOT NULL REFERENCES profissionais(id)          ON DELETE CASCADE,
  documento_id    uuid NOT NULL REFERENCES documentos_habilitacao(id) ON DELETE CASCADE,
  papel           text NOT NULL DEFAULT 'RT',
  numero_art      text,
  criado_em       timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_profdoc_papel' AND conrelid = 'profissional_documentos'::regclass
  ) THEN
    ALTER TABLE profissional_documentos ADD CONSTRAINT chk_profdoc_papel
      CHECK (papel IN ('RT', 'CORRESPONSAVEL', 'EQUIPE'));
  END IF;
END $$;
--> statement-breakpoint

-- Um profissional aparece UMA vez por documento (trocar o papel e UPDATE, nao
-- segunda linha). E o arbitro do ON CONFLICT DO NOTHING do backfill.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_profdoc
  ON profissional_documentos (profissional_id, documento_id);
--> statement-breakpoint

-- "Quem assina ESTE documento" (pagina do documento e ficha) e o CASCADE do
-- DELETE de documento.
CREATE INDEX IF NOT EXISTS idx_profdoc_documento ON profissional_documentos (documento_id);
--> statement-breakpoint

COMMENT ON TABLE profissional_documentos IS
  'Vinculo profissional x documento de habilitacao. `papel` e o papel do PROFISSIONAL (RT/CORRESPONSAVEL/EQUIPE), nao o de documentos_habilitacao.papel. `numero_art` mora aqui porque a ART e do par. UNIQUE (profissional_id, documento_id): trocar papel e UPDATE, nao linha nova.';
--> statement-breakpoint

-- ── 6) documento_atividades ──────────────────────────────────────────────────
-- O que a ART LISTA. Hoje so existe `documentos_projetos.numero_art` (o numero)
-- e o numero do documento ART — nada sobre O QUE foi feito.
--
-- POR QUE `quantidade_texto` e TEXT e NAO numeric+unidade: a quantidade e
-- EVIDENCIA LITERAL ("3.600,00 HH", "12.000 m de tubulacao"), exibida como
-- texto e nunca somada.
CREATE TABLE IF NOT EXISTS documento_atividades (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  documento_id     uuid NOT NULL REFERENCES documentos_habilitacao(id) ON DELETE CASCADE,
  atividade        text NOT NULL,
  quantidade_texto text,
  ordem            integer NOT NULL DEFAULT 0,
  criado_em        timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_docativ_atividade' AND conrelid = 'documento_atividades'::regclass
  ) THEN
    ALTER TABLE documento_atividades ADD CONSTRAINT chk_docativ_atividade
      CHECK (length(btrim(atividade)) >= 2);
  END IF;
END $$;
--> statement-breakpoint

-- "As atividades DESTE documento, na ordem" (uma consulta so) e o CASCADE do
-- DELETE de documento.
CREATE INDEX IF NOT EXISTS idx_docativ_doc ON documento_atividades (documento_id, ordem);
--> statement-breakpoint

COMMENT ON TABLE documento_atividades IS
  'Atividades listadas na ART do documento. `quantidade_texto` e TEXTO (evidencia literal), nunca numero somavel. `atividade` e texto livre por enquanto; catalogo de atividades nasce depois, com vocabulario limpo.';
--> statement-breakpoint

-- ── 7) backfill: as 3 colunas de texto viram profissional + vinculo ──────────
-- Fonte: documentos_projetos.engenheiro_responsavel / registro_crea /
-- numero_art (0004). As colunas FICAM onde estao — sao o dado bruto de onde
-- isto saiu, e apaga-las tornaria o backfill irreproduzivel.
--
-- Idempotencia: os tres statements tem predicado (NOT EXISTS) e/ou ON CONFLICT
-- DO NOTHING, e por isso podem rodar a cada `make migrate` sem duplicar.
--
-- Deduplicacao, na ordem:
--   A) quem TEM crea: a chave e o crea. Entre grafias diferentes do mesmo
--      registro vence a mais LONGA ('Joao A. Silva' > 'Joao Silva'), com o
--      nome em ordem alfabetica como desempate estavel entre reaplicacoes.
--   B) quem NAO tem crea: a chave e lower(btrim(nome)), e a linha so nasce se
--      nenhum profissional com aquele nome existir (inclusive um criado em A).
--   C) o vinculo casa por crea quando ha crea, por lower(nome) quando nao ha.
-- O que o backfill NAO faz: unificar 'J. A. Silva' com 'Joao Antonio Silva'.
-- Sem crea, sao duas pessoas ate alguem dizer o contrario — e quem diz e a
-- tela /acervo/profissionais, nao uma heuristica que ninguem audita.

-- A) profissionais COM crea
INSERT INTO profissionais (nome, crea)
SELECT DISTINCT ON (crea) nome, crea
  FROM (
    SELECT btrim(engenheiro_responsavel)        AS nome,
           nullif(btrim(registro_crea), '')     AS crea
      FROM documentos_projetos
     WHERE length(btrim(coalesce(engenheiro_responsavel, ''))) >= 2
       AND length(btrim(coalesce(registro_crea, '')))          >= 3
  ) s
 ORDER BY crea, length(nome) DESC, nome ASC
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- B) profissionais SEM crea, cujo nome ainda nao existe
INSERT INTO profissionais (nome, crea)
SELECT DISTINCT ON (lower(nome)) nome, NULL
  FROM (
    SELECT btrim(engenheiro_responsavel) AS nome
      FROM documentos_projetos
     WHERE length(btrim(coalesce(engenheiro_responsavel, ''))) >= 2
       AND length(btrim(coalesce(registro_crea, '')))          <  3
  ) s
 WHERE NOT EXISTS (
   SELECT 1 FROM profissionais p WHERE lower(p.nome) = lower(s.nome)
 )
 ORDER BY lower(nome), length(nome) DESC, nome ASC
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- C) vinculos. Papel 'RT' porque e o que a coluna de origem diz
-- ("engenheiro_responsavel"); corresponsavel e equipe entram pela tela.
-- DISTINCT ON com criado_em DESC: quando o mesmo par aparece em duas linhas de
-- documentos_projetos, vale a ART mais recente.
INSERT INTO profissional_documentos (profissional_id, documento_id, papel, numero_art)
SELECT DISTINCT ON (p.id, dp.documento_id)
       p.id, dp.documento_id, 'RT', nullif(btrim(dp.numero_art), '')
  FROM documentos_projetos dp
  JOIN profissionais p
    ON (length(btrim(coalesce(dp.registro_crea, ''))) >= 3
        AND p.crea = btrim(dp.registro_crea))
    OR (length(btrim(coalesce(dp.registro_crea, ''))) <  3
        AND lower(p.nome) = lower(btrim(dp.engenheiro_responsavel)))
 WHERE length(btrim(coalesce(dp.engenheiro_responsavel, ''))) >= 2
 ORDER BY p.id, dp.documento_id, dp.criado_em DESC
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ── 8) detentora_cnpj ───────────────────────────────────────────────────────
-- QUAL estabelecimento (matriz x filial) detem o acervo. Nullable, sem default:
-- `detentora` continua a chave e nenhuma linha existente muda.
-- Regex em CHECK: so 14 digitos, sem mascara — igual ao que `cliente_cnpj` ja
-- recebe do zod (/^\d{14}$/). NULL passa: nenhuma linha existente muda.
ALTER TABLE documentos_habilitacao ADD COLUMN IF NOT EXISTS detentora_cnpj text;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_doch_detentora_cnpj' AND conrelid = 'documentos_habilitacao'::regclass
  ) THEN
    ALTER TABLE documentos_habilitacao ADD CONSTRAINT chk_doch_detentora_cnpj
      CHECK (detentora_cnpj IS NULL OR detentora_cnpj ~ '^\d{14}$');
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE operacoes ADD COLUMN IF NOT EXISTS detentora_cnpj text;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_oper_detentora_cnpj' AND conrelid = 'operacoes'::regclass
  ) THEN
    ALTER TABLE operacoes ADD CONSTRAINT chk_oper_detentora_cnpj
      CHECK (detentora_cnpj IS NULL OR detentora_cnpj ~ '^\d{14}$');
  END IF;
END $$;
--> statement-breakpoint
