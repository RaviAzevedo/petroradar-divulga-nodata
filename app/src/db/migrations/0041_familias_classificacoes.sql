-- 0041_familias_classificacoes.sql
--
-- INDÍCIO de família por documento — a FILA, separada da PROVA CONFIRMADA.
--
-- POR QUE UMA TABELA NOVA, E NÃO COLUNAS EM `documentos_familias`
-- ---------------------------------------------------------------
-- `documentos_familias` significa UMA coisa hoje, e 15 pontos de leitura nos dois
-- backends contam qualquer linha dela como PROVA. Despejar palpites de
-- maquina la dentro mudaria o significado da tabela em todos eles de uma vez —
-- inclusive no contador de "uso a jusante" do desfazer de importacao
-- (app/src/app/api/conformidade/import/jobs/[id]/desfazer/route.ts), que
-- passaria a recusar o undo de todas as ondas do acervo.
--
-- Aqui o palpite vive separado e SO VIRA VINCULO pela mao de uma pessoa. A
-- separacao e estrutural (tabela + CHECK), nao um filtro de coluna que alguem
-- esquece de aplicar no 16o ponto de leitura.
--
-- DE ONDE VEM O DADO
-- ------------------
-- Das fichas produzidas pelo pipeline de OCR do acervo (fora deste repositorio):
-- cada ficha pode trazer `familias_crc[]` com codigo, confianca e
-- justificativa. Esse material ja foi lido e nunca tinha entrado no banco. O
-- carregador e um job de CARGA, nao de IA: nao tem custo de modelo e nao
-- acrescenta entrada nenhuma na allowlist de app/src/lib/ia/gate.ts.
--
-- ⚠️ LIMITE CONHECIDO DO DADO: se a extracao usa como vocabulario so as familias
-- do cadastro, ela SO consegue classificar dentro delas. Ou seja, a carga
-- responde "o que sustenta o que ja temos" e NAO "em que familia nova
-- poderiamos entrar". Para a segunda pergunta e preciso reclassificar contra as
-- familias de SERVICO do catalogo (0040) — trabalho separado.

CREATE TABLE IF NOT EXISTS familias_classificacoes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  documento_id  uuid NOT NULL REFERENCES documentos_habilitacao(id) ON DELETE CASCADE,
  -- Codigo, nao FK: o indicio pode apontar familia que a Proponente NAO tem
  -- cadastrada — que e justamente o caso "oportunidade". FK para `familias`
  -- impediria de gravar exatamente o que mais interessa.
  familia_codigo text NOT NULL,

  -- O que a maquina disse
  veredito      text NOT NULL CHECK (veredito IN ('PROVA','PARCIAL','NAO','ABSTEM')),
  confianca     real CHECK (confianca IS NULL OR (confianca >= 0 AND confianca <= 1)),
  -- A justificativa do extrator. NAO e citacao literal garantida: so parte
  -- dos pares tem fragmento ancoravel no texto do documento. Por
  -- isso o campo se chama `justificativa`, e nao `trecho`.
  justificativa text,

  -- Procedencia — sem isto ninguem sabe se a linha veio de maquina ou de gente
  procedencia   text NOT NULL DEFAULT 'EXTRACAO_OCR',
  modelo        text,
  job_id        text,

  -- Revisao humana. REJEITADA PRECISA PERSISTIR: representar "nao" por ausencia
  -- de linha faz a proxima carga ressuscitar a sugestao, e a revisao vira Sisifo.
  revisao       text CHECK (revisao IS NULL OR revisao IN ('CONFIRMADA','REJEITADA','PARCIAL')),
  revisado_por  uuid REFERENCES users(id) ON DELETE SET NULL,
  revisado_em   timestamptz,
  motivo_revisao text,
  -- Aponta o vinculo criado quando a revisao CONFIRMA. Enquanto for NULL, este
  -- indicio NAO e prova e nao pode ser contado como tal.
  vinculo_id    uuid REFERENCES documentos_familias(id) ON DELETE SET NULL,

  criado_em     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

COMMENT ON TABLE familias_classificacoes IS
  'INDICIO de familia por documento (fila de revisao). NAO e prova: prova confirmada vive em documentos_familias, e so entra la pela mao de uma pessoa.';
--> statement-breakpoint

-- Um indicio por (documento, familia, carga). Permite recarregar sem duplicar e
-- preserva o historico entre cargas diferentes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_famclass_unico
  ON familias_classificacoes (documento_id, familia_codigo, coalesce(job_id, ''));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_famclass_familia ON familias_classificacoes (familia_codigo, veredito);
--> statement-breakpoint
-- Indice da FILA: o que ainda nao foi revisado, do mais confiante para o menos.
CREATE INDEX IF NOT EXISTS idx_famclass_fila
  ON familias_classificacoes (confianca DESC) WHERE revisao IS NULL;
