-- 0039_acervo_lexemas_df.sql
--
-- FREQUENCIA DE DOCUMENTO DE **TODOS** OS LEXEMAS, MEDIDA NO CORPUS INTEIRO.
--
-- POR QUE
-- ───────
-- A 0037 acertou o diagnostico e errou o instrumento. Ela mede ts_stat sobre uma
-- AMOSTRA de 12.000 chunks e guarda so os lexemas com frequencia
-- >= 20%. Medido contra o corpus inteiro:
--
--   * a amostra estava CERTA: os lexemas praticamente coincidem com os que o
--     corpus inteiro da no mesmo corte de 20%. Amostrar NAO era o defeito.
--   * o defeito e a REGRA: um corte fixo de 20% por termo, sem nocao do custo
--     ACUMULADO da consulta. Uma pergunta longa em linguagem natural perde o
--     termo mais comum para a lista da 0037 e mantem varios termos que, cada um
--     sozinho, ficam abaixo do corte — mas juntos cobrem mais da metade do
--     indice e levam a busca para a casa dos segundos.
--
-- ts_rank_cd pesa frequencia e proximidade mas NAO raridade: nao ha IDF nativo
-- no Postgres. Esta tabela e o IDF que falta, em forma de dado.
--
-- O QUE MUDA NA CONSULTA (retrieval.ts, CTE consulta_ampla)
-- ───────────────────────────────────────────────────────────────────────────
-- Sai o "NOT IN (SELECT lexema FROM acervo_lexemas_comuns)". Entra um ORCAMENTO:
-- os lexemas da pergunta sao ordenados do mais raro para o mais comum e entram
-- na consulta AMPLA enquanto a SOMA dos ndoc couber em 12.000 chunks. O termo
-- mais raro tem sempre a primeira reivindicacao do orcamento, entao o piso de
-- seguranca K=1 e implicito — nao precisa de clausula. Se nem o mais raro cabe
-- (pergunta so de palavras ultracomuns, "contrato de prestacao de servicos"),
-- a AMPLA fica NULA e o braco desliga, que e exatamente o que a 0037 ja fazia
-- nesse caso.
--
-- 12.000 foi calibrado num golden set de 40 perguntas com um corpus da ordem de
-- dezenas de milhares de chunks (~19% do indice). O hit@10 fica igual, o MRR@10
-- sobe um pouco e a latencia cai varias vezes (mediana, p90 e pior caso). Com
-- orcamento maior, pergunta de identificador comeca a afogar; com menor, perde
-- termo util. O joelho e estreito — RECALIBRAR se o corpus mudar de ordem de
-- grandeza.
--
-- MANUTENCAO: o INSERT abaixo e idempotente e roda em poucos segundos (ts_stat
-- sobre o corpus inteiro). Reexecutar SEMPRE que o corpus
-- mudar de tamanho relevante — apply-extra-migrations.sh ja o faz a cada
-- `make migrate`. Um lexema ausente da tabela e tratado como ndoc = 0 (custo
-- zero, entra de graca), entao tabela desatualizada degrada para "AMPLA mais
-- larga", nunca para "AMPLA que perde termo raro".

CREATE TABLE IF NOT EXISTS acervo_lexemas_df (
  lexema     text PRIMARY KEY,
  ndoc       integer NOT NULL,       -- nº de chunks que contem o lexema (ts_stat)
  frequencia real    NOT NULL,       -- ndoc / total de chunks, so para leitura humana
  medido_em  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

COMMENT ON TABLE acervo_lexemas_df IS
  'IDF do acervo: ndoc de TODOS os lexemas de acervo_chunks.busca_tsv, corpus inteiro (0039). Consumida pela CTE consulta_ampla da busca hibrida como orcamento de custo. Lexema ausente = ndoc 0 = custo zero.';
--> statement-breakpoint

-- Refresh sem janela vazia: UPSERT de tudo e, depois, remocao do que nao foi
-- tocado nesta rodada (now() e constante dentro do statement). Nada de TRUNCATE:
-- a tabela e lida por toda busca do acervo e um instante vazia deixaria a AMPLA
-- larga demais.
INSERT INTO acervo_lexemas_df (lexema, ndoc, frequencia, medido_em)
SELECT word,
       ndoc,
       ndoc::real / greatest((SELECT count(*) FROM acervo_chunks), 1),
       now()
  FROM ts_stat($$SELECT busca_tsv FROM acervo_chunks$$)
 WHERE ndoc >= 1
ON CONFLICT (lexema) DO UPDATE
   SET ndoc       = excluded.ndoc,
       frequencia = excluded.frequencia,
       medido_em  = excluded.medido_em;
--> statement-breakpoint

DELETE FROM acervo_lexemas_df
 WHERE medido_em < (SELECT max(medido_em) FROM acervo_lexemas_df);
--> statement-breakpoint

ANALYZE acervo_lexemas_df;
