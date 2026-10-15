-- 0044_acervo_refino.sql
--
-- REFINO do acervo: os quatro itens de estrutura que faltavam e que
-- nenhum outro bloqueia - area da planta, revisao de engenharia, anotacao
-- livre e itens tagueados.
--
-- POR QUE
-- -------
--   * B5 `operacoes.area`: `unidade` e texto livre e mistura dois conceitos
--     ("Refinaria X" e uma planta; "U-32" e uma area dentro dela). Quem procura
--     atestado por area da planta hoje le escopo com o olho.
--   * B6 `documentos_habilitacao.revisao`: o carimbo da engenharia ("R0",
--     "02A") nao tem onde morar. `versao integer` NAO serve: e o versionamento
--     de certidao do cofre (v2 substitui v1, com documento_anterior_id), outra
--     coisa.
--   * B7 `acervo_anotacoes`: hoje a unica anotacao livre do modulo e
--     `documentos_familias.observacao` - observacao DO VINCULO documento x
--     familia. Nao existe lugar para dizer algo sobre uma OBRA, um
--     PROFISSIONAL. E `audit_log` nao serve: tem expurgo de 12
--     meses (comentario da 0035) - a anotacao desapareceria sozinha.
--   * `documento_itens_tag`: o equipamento com TAG e especificacao que o
--     atestado lista. Entra MINIMA (sem tela propria).
--
-- O QUE NAO EXISTE DE PROPOSITO
-- -----------------------------
-- * `area` e `revisao` NAO tem CHECK. Sao carimbo e nome proprio, escritos por
--   cliente e por projetista; um CHECK de formato recusaria o carimbo real do
--   proximo edital. Alem disso, CHECK sobre coluna de tabela PREEXISTENTE se
--   escreve como DROP+ADD e revalida a tabela inteira a cada `make migrate`
--   (milhares de linhas em documentos_habilitacao) - preco alto por uma regra que
--   nao temos. O teto de tamanho vive no zod.
-- * `acervo_anotacoes.alvo_id` NAO tem FK (ver bloco 3).
-- * `documento_itens_tag` NAO tem `quantidade numeric` nem `unidade_id`: e
--   inventario do que o documento cita, nao soma de obra.
--
-- Idempotente (IF NOT EXISTS / DO $$ com checagem em pg_constraint). Sem seed,
-- sem backfill, sem UPDATE. Fora do journal do Drizzle - aplicada por
-- db/scripts/apply-extra-migrations.sh, DEPOIS da 0043.

-- -- 1) operacoes.area (B5) ---------------------------------------------------
-- A area DENTRO da planta ("U-32", "Area 30", "Off-site", "Tancagem"), que o
-- edital cita e que hoje so existe misturada em `unidade` ou solta no escopo.
-- `unidade` PERMANECE como esta: ninguem reescreve centenas de linhas de texto livre
-- numa migration, e as duas convivem (uma diz ONDE fica a planta, a outra que
-- pedaco dela).
ALTER TABLE operacoes ADD COLUMN IF NOT EXISTS area text;
--> statement-breakpoint

-- Indice de EXPRESSAO, igual ao idx_oper_cliente_nome da 0033: casa area sem
-- depender de caixa ("U-32" = "u-32") em igualdade e prefixo. Nao atende
-- ILIKE '%termo%' - e com poucas centenas de linhas o seq scan e irrelevante, entao nao vale
-- um GIN trigram como o da 0018.
CREATE INDEX IF NOT EXISTS idx_oper_area ON operacoes (lower(area));
--> statement-breakpoint

COMMENT ON COLUMN operacoes.area IS
  'Area da planta em que a obra aconteceu (U-32, Area 30, Off-site) - 0044. Texto livre, nullable, SEM catalogo: o vocabulario e do cliente. `unidade` continua existindo e diz outra coisa (a planta/base). Indice em lower(area).';
--> statement-breakpoint

-- -- 2) documentos_habilitacao.revisao (B6) ------------------------------------
-- O carimbo de revisao do documento de engenharia ("R0", "R1", "02A",
-- "Rev. C"). NAO ordena, NAO substitui nada e NAO tem gramatica unica entre
-- clientes - por isso e text nullable e nao integer.
--
-- NAO confundir com `versao integer NOT NULL DEFAULT 1` + `documento_anterior_id`
-- (versionamento de certidao do cofre, 0004/0017): la v2 SUBSTITUI v1 e a
-- cadeia e navegavel; aqui e o que a engenharia escreveu na folha.
ALTER TABLE documentos_habilitacao ADD COLUMN IF NOT EXISTS revisao text;
--> statement-breakpoint

-- Sem indice: ninguem procura documento POR revisao (procura-se por obra, tipo
-- e data, e a revisao aparece na linha). Indice aqui seria custo de escrita em
-- toda a tabela para uma consulta que nao existe.

COMMENT ON COLUMN documentos_habilitacao.revisao IS
  'Revisao de engenharia como carimbada no documento (R0, R1, 02A) - 0044. Texto livre, nullable, sem CHECK. NAO e `versao`: aquela e o versionamento de certidao do cofre (v2 substitui v1 via documento_anterior_id). Exibida como chip ao lado do titulo, nunca na coluna Versao.';
--> statement-breakpoint

-- -- 3) acervo_anotacoes (B7) --------------------------------------------------
-- Anotacao livre sobre QUALQUER coisa do acervo: uma obra, um documento, um
-- ou um profissional. `documentos_familias.observacao` fica onde esta
-- (e observacao DO VINCULO, nao da coisa) e `audit_log` continua sendo so
-- trilha - com expurgo de 12 meses, nao serve de anotacao (0035).
--
-- POR QUE `alvo_id` NAO TEM FK
-- ----------------------------
-- O alvo e POLIMORFICO: tres tabelas diferentes. As duas formas de resolver
-- isso em Postgres sao (a) tres colunas uuid nullable, cada uma com sua FK,
-- mais um CHECK "exatamente uma preenchida", ou (b) um par (tipo, id) sem FK.
-- Escolhemos (b), pelo precedente ja adotado no proprio modulo:
-- `audit_download_restrito` (0035) guarda documento_id SEM FK e desnormaliza o
-- titulo, de proposito, para sobreviver ao DELETE do documento. Aqui vale o
-- mesmo: a anotacao "este atestado esta com a data errada" continua valendo
-- como registro depois que alguem apaga o documento.
-- O preco esta declarado: NAO ha CASCADE, entao anotacao de alvo apagado fica
-- ORFA. Quem lista sempre filtra por (alvo_tipo, alvo_id) de um alvo que
-- acabou de carregar, entao orfa nunca aparece na tela; e a limpeza, se um dia
-- doer, e um DELETE ... WHERE NOT EXISTS numa migration futura - nao um
-- gatilho que ninguem audita.
--
-- POR QUE `autor_nome` DESNORMALIZADO
-- -----------------------------------
-- `autor_id` e FK para users com ON DELETE SET NULL (o usuario pode ser
-- desligado e ate removido). Sem o nome gravado na linha, a anotacao viraria
-- "alguem escreveu isto" - que e pior do que nao ter anotacao. users.nome e
-- NULLABLE no schema (l. 88), entao quem grava usa `nome ?? email` e a coluna
-- e NOT NULL aqui.
CREATE TABLE IF NOT EXISTS acervo_anotacoes (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  alvo_tipo text NOT NULL,   -- 'OPERACAO' | 'DOCUMENTO' | 'PROFISSIONAL'
  alvo_id   uuid NOT NULL,   -- SEM FK, de proposito (ver acima)

  autor_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  autor_nome text NOT NULL,  -- desnormalizado: sobrevive ao desligamento

  -- Texto ja REDIGIDO (redigirPii) pela rota, antes do INSERT: CPF e e-mail
  -- viram [CPF-REMOVIDO]/[EMAIL-REMOVIDO], a mesma regra do ocr_texto.
  texto text NOT NULL,

  criado_em     timestamptz NOT NULL DEFAULT now(),
  -- Sem trigger (regra da casa): todo UPDATE seta na mao.
  atualizado_em timestamptz,
  -- NULL = aberta. Resolver e um UPDATE, nao um DELETE: o que foi anotado e
  -- resolvido continua sendo historia da obra.
  resolvida_em  timestamptz
);
--> statement-breakpoint

DO $$
BEGIN
  -- Vocabulario FECHADO dos tres alvos. Ele nasce completo de proposito:
  -- acrescentar valor depois exigiria DROP+ADD sobre uma tabela ja com linhas,
  -- e a checagem de existencia do alvo e da ROTA, nao do banco.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_anot_alvo' AND conrelid = 'acervo_anotacoes'::regclass
  ) THEN
    ALTER TABLE acervo_anotacoes ADD CONSTRAINT chk_anot_alvo
      CHECK (alvo_tipo IN ('OPERACAO', 'DOCUMENTO', 'PROFISSIONAL'));
  END IF;

  -- Anotacao vazia (ou so espaco) nao e anotacao: entraria na lista ocupando
  -- uma linha que ninguem consegue nem ler nem achar por busca. O teto de
  -- 4000 e o mesmo de `operacoes.escopo` no zod - texto de tela, nao arquivo.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_anot_texto' AND conrelid = 'acervo_anotacoes'::regclass
  ) THEN
    ALTER TABLE acervo_anotacoes ADD CONSTRAINT chk_anot_texto
      CHECK (length(btrim(texto)) >= 1 AND length(texto) <= 4000);
  END IF;
END $$;
--> statement-breakpoint

-- A UNICA consulta que existe: "as anotacoes DESTE alvo, da mais recente para
-- a mais antiga". As tres colunas na ordem (alvo_tipo, alvo_id, criado_em)
-- resolvem WHERE + ORDER BY sem sort. Nao ha indice por autor nem por
-- resolvida_em: nao existe tela "minhas anotacoes" nem "todas as pendentes" -
-- quando existir, o indice nasce com ela.
CREATE INDEX IF NOT EXISTS idx_anot_alvo
  ON acervo_anotacoes (alvo_tipo, alvo_id, criado_em DESC);
--> statement-breakpoint

COMMENT ON TABLE acervo_anotacoes IS
  'Anotacao livre sobre operacao, documento ou profissional (0044). `alvo_id` SEM FK de proposito (alvo polimorfico; molde audit_download_restrito da 0035) - a anotacao sobrevive ao DELETE do alvo e NAO ha CASCADE. `autor_nome` desnormalizado porque users.nome e nullable e o usuario pode ser desligado. `texto` ja entra REDIGIDO (redigirPii): CPF e e-mail nunca sao gravados. audit_log continua so como trilha - tem expurgo de 12 meses e por isso nao serve de anotacao.';
--> statement-breakpoint

-- -- 4) documento_itens_tag (minima) -------------------------------------------
-- O equipamento com TAG que o atestado/ART lista ("P-101 A/B", "TQ-4210",
-- "PSV-2201"), com a especificacao que varia sem virar coluna.
--
-- NAO confundir com `documentos_habilitacao.tags jsonb`: aquilo e rotulo livre
-- de arquivamento do ARQUIVO ("urgente", "obra-x"); isto e inventario de
-- EQUIPAMENTO citado dentro do documento.
--
-- POR QUE NAO TEM quantidade/unidade: e inventario do que o documento cita,
-- nao soma de obra.
CREATE TABLE IF NOT EXISTS documento_itens_tag (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  documento_id uuid NOT NULL REFERENCES documentos_habilitacao(id) ON DELETE CASCADE,

  tag          text NOT NULL,   -- 'P-101 A/B', 'TQ-4210'
  descricao    text,            -- 'Bomba centrifuga de carga'
  -- Material, diametro, classe, spec, TAG do P&ID... chave/valor livre.
  especificacao jsonb,

  ordem     integer NOT NULL DEFAULT 0,
  criado_em timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_docitem_tag' AND conrelid = 'documento_itens_tag'::regclass
  ) THEN
    ALTER TABLE documento_itens_tag ADD CONSTRAINT chk_docitem_tag
      CHECK (length(btrim(tag)) >= 1 AND length(tag) <= 100);
  END IF;
END $$;
--> statement-breakpoint

-- A MESMA TAG nao entra duas vezes no MESMO documento - e a chave de negocio
-- do item. UPPER(BTRIM(...)) porque 'p-101' e 'P-101 ' sao a mesma bomba.
-- Este indice tambem e o caminho de "os itens DESTE documento" (documento_id e
-- a coluna lider), entao nao ha indice separado por documento_id: a listagem
-- ordena por `ordem` dentro de algumas dezenas de linhas.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_docitem_tag
  ON documento_itens_tag (documento_id, upper(btrim(tag)));
--> statement-breakpoint

COMMENT ON TABLE documento_itens_tag IS
  'Equipamento com TAG listado no documento (0044, minimo). NAO e documentos_habilitacao.tags (aquilo e rotulo de arquivamento do arquivo). SEM quantidade numerica. `especificacao` jsonb guarda material/diametro/classe. UNIQUE (documento_id, upper(btrim(tag))): a mesma TAG nao se repete no mesmo documento. Nasce vazia: sem backfill.';
--> statement-breakpoint
