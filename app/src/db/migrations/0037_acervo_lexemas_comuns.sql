-- 0037_acervo_lexemas_comuns.sql
--
-- LISTA DE PARADA DERIVADA DO PRÓPRIO ACERVO.
--
-- POR QUE
-- ───────
-- A busca híbrida roda duas consultas textuais: `estrita` (AND, boa para
-- identificador) e `ampla` (OR, boa para linguagem natural). A ampla tinha dois
-- defeitos, e os dois têm a mesma causa.
--
-- Medido com ts_stat sobre o índice, a frequência de lexema no acervo é
-- extrema — em parte porque a coluna `contexto` (migração 0036) passou a repetir
-- a identidade do documento em TODO chunk. Lexemas como `contrat`, `operaca` e
-- `servic` aparecem em quase todos os chunks; outros termos do domínio, em
-- cerca de metade deles.
--
-- Consequência 1 (qualidade): "Contrato 1234.0001111.17.2" vira
-- `contrat | 5125…`, e como ts_rank_cd pesa frequência e proximidade mas NÃO
-- raridade, os milhares de trechos com "contrato" afogam o único que traz o
-- número. Medido: identificador caiu de 75% para 17% de hit@10 com OR puro.
--
-- Consequência 2 (latência): um termo presente em 99% do índice faz a ampla
-- pontuar quase tudo. A busca foi de 293 ms para 3.594 ms.
--
-- A solução é IDF pobre porém eficaz: tirar da consulta AMPLA os lexemas que o
-- corpus torna inúteis. A `estrita` NÃO usa esta lista — lá o termo comum só
-- restringe, e restringir é o que ela deve fazer.
--
-- MANUTENÇÃO: reexecutar o INSERT quando o corpus mudar de forma relevante
-- (indexar os anexos de edital, por exemplo, muda o vocabulário). Não é uma
-- lista de stopwords do português — é derivada do acervo indexado.

CREATE TABLE IF NOT EXISTS acervo_lexemas_comuns (
  lexema     text PRIMARY KEY,
  frequencia real NOT NULL,          -- fração dos chunks que contêm o lexema
  medido_em  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Amostra de 12.000 chunks: estável o bastante e roda em ~1 s. Corte em 20% —
-- abaixo disso o termo ainda discrimina alguma coisa.
INSERT INTO acervo_lexemas_comuns (lexema, frequencia)
SELECT word, ndoc::real / 12000
  FROM ts_stat($$SELECT busca_tsv FROM acervo_chunks
                  WHERE id IN (SELECT id FROM acervo_chunks ORDER BY id LIMIT 12000)$$)
 WHERE ndoc::real / 12000 >= 0.20
ON CONFLICT (lexema) DO UPDATE
   SET frequencia = excluded.frequencia, medido_em = now();
