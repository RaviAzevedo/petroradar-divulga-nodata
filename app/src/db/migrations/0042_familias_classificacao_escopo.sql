-- 0042_familias_classificacao_escopo.sql
--
-- O VOCABULARIO de cada carga de classificacao — o que foi PROCURADO.
--
-- POR QUE
-- -------
-- A 0041 grava o que a maquina ENCONTROU. Faltava registrar o que ela chegou a
-- PROCURAR, e sem isso nao da para distinguir dois estados que significam coisas
-- opostas para uma decisao de habilitacao:
--
--   "a familia foi avaliada e nenhum documento a sustenta"  -> SEM LASTRO, e um
--       "nao" com fundamento: cadastrado e disputando sem poder provar.
--   "ninguem nunca perguntou por esta familia"              -> A APURAR, e nao
--       se pode afirmar nada.
--
-- Derivar o universo avaliado das linhas ENCONTRADAS colapsa os dois: familia que
-- estava no vocabulario e nao casou nada fica sem linha, e passa por
-- "nao perguntamos" — e a familia cadastrada que o acervo nao sustenta e
-- justamente o achado que mais interessa.
--
-- Cada extracao usa um vocabulario de familias (em geral, as do cadastro). O
-- carregador grava esse vocabulario aqui, e a consulta do mapa passa a ler
-- DAQUI o que foi avaliado.

CREATE TABLE IF NOT EXISTS familias_classificacao_escopo (
  job_id         text NOT NULL,
  familia_codigo text NOT NULL,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, familia_codigo)
);
--> statement-breakpoint

COMMENT ON TABLE familias_classificacao_escopo IS
  'Vocabulario de cada carga de classificacao: o que foi PROCURADO. Separa "avaliada e sem lastro" de "nunca avaliada" — a 0041 so registra o que foi encontrado.';
