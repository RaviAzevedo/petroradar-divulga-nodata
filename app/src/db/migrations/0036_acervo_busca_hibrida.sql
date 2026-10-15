-- 0036_acervo_busca_hibrida.sql
--
-- BUSCA HÍBRIDA NO ACERVO: texto + vetor.
--
-- POR QUE
-- ───────
-- A busca era 100% vetorial e isso foi medido como o maior defeito. Com o
-- conjunto de referência de 40 perguntas (golden set interno) a linha
-- de base ficou em hit@10 = 30% e MRR = 0,242. O recorte explica onde dói:
--
--   semântica      35% hit@10   (o vetor faz o que promete: reconhece assunto)
--   identificador  17% hit@10   (número de contrato, sigla de unidade — falha)
--   fato           38% hit@10   (citar frase LITERAL do documento não o acha)
--
-- O caso "fato" é a prova. Para 5 das 8 perguntas, o chunk que CONTÉM a frase
-- citada está na posição exata 46 a 130 do ranking por cosseno — ou seja,
-- dezenas de chunks são genuinamente mais próximos de uma citação literal do que
-- o próprio trecho citado. Não é falha de recall do HNSW (verificado com
-- enable_indexscan=off: o ranking exato é o mesmo). É o bi-encoder não
-- discriminando: a amplitude de similaridade entre a 1ª e a 20ª posição é de
-- 0,03 a 0,07. Ele agrupa por assunto e para aí.
--
-- Busca textual resolve exatamente esse recorte: um número de contrato como
-- `1234.0003333.17.2` aparece em N chunks e o full-text acha os N; o vetor acha ~nenhum. O contrário também
-- é verdade — "tubulação industrial refinaria" no full-text dá 0 resultado
-- porque plainto_tsquery faz AND. Por isso FUNDIR, nunca substituir.
--
-- O QUE ESTA MIGRAÇÃO FAZ
-- ───────────────────────
--   1. `contexto`: a identidade do documento colada em cada chunk. Hoje o
--      cabeçalho de metadado ("Tipo: … | Detentora: … Cliente: …") existe no
--      ocr_texto, mas só o chunk 0 de cada documento o carrega — uma
--      fração mínima. Todos os demais são texto sem procedência. Com esta
--      coluna, "o que a Proponente fez na REF-A" alcança um trecho que só fala de
--      tubulação, porque o chunk agora sabe que é Proponente e é REF-A.
--   2. `busca_tsv`: tsvector em português, sem acento (o OCR mistura "Serviços"
--      e "Servicos"), gerado de contexto + texto.
--   3. Índice GIN. Sem ele o full-text varre a tabela: 5 segundos por consulta
--      medidos no protótipo.
--
-- CUSTO: reescrita da tabela (conferir espaço livre antes). Nenhum re-embedding —
-- os vetores não são tocados.
--
-- ATENÇÃO: quem insere chunk (worker/indexer) precisa preencher `contexto`.
-- `busca_tsv` é GENERATED e se atualiza sozinha.

-- ── 1) Contexto por chunk ────────────────────────────────────────────────────
ALTER TABLE acervo_chunks ADD COLUMN IF NOT EXISTS contexto text;
--> statement-breakpoint

-- Documentos de habilitação: identidade + operação. `concat_ws` ignora NULL,
-- então campo vazio não vira separador solto.
UPDATE acervo_chunks c
   SET contexto = concat_ws(' · ',
         nullif(btrim(d.titulo), ''),
         d.tipo_documento,
         nullif(btrim(d.numero_documento), ''),
         o.detentora,
         CASE WHEN o.codigo IS NOT NULL THEN 'Operação ' || o.codigo END,
         CASE WHEN nullif(btrim(o.contrato_numero),'') IS NOT NULL
              THEN 'Contrato ' || o.contrato_numero END,
         nullif(btrim(o.cliente_nome), ''),
         nullif(btrim(o.cliente_grupo), ''),
         nullif(btrim(o.unidade), ''),
         nullif(btrim(o.ramo), ''),
         left(nullif(btrim(o.escopo), ''), 400))
  FROM documentos_habilitacao d
  LEFT JOIN operacoes o ON o.id = d.operacao_id
 WHERE c.origem_tipo = 'DOC_HABILITACAO' AND d.id = c.origem_id;
--> statement-breakpoint

-- Anexos de edital: descrição do anexo + objeto da licitação.
UPDATE acervo_chunks c
   SET contexto = concat_ws(' · ',
         nullif(btrim(a.descricao), ''),
         'Anexo de edital',
         left(nullif(btrim(l.objeto), ''), 400))
  FROM anexos a
  LEFT JOIN licitacoes l ON l.id = a.licitacao_id
 WHERE c.origem_tipo = 'ANEXO_EDITAL' AND a.id = c.origem_id;
--> statement-breakpoint

-- ── 2) tsvector gerado ───────────────────────────────────────────────────────
-- f_unaccent é o wrapper IMUTÁVEL criado em 0018 — obrigatório aqui, porque
-- coluna GENERATED só aceita expressão imutável (o unaccent nativo não é).
ALTER TABLE acervo_chunks
  ADD COLUMN IF NOT EXISTS busca_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('portuguese',
      f_unaccent(coalesce(contexto, '') || ' ' || coalesce(texto, '')))
  ) STORED;
--> statement-breakpoint

-- ── 3) Índice ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_acervo_busca_tsv
  ON acervo_chunks USING gin (busca_tsv);
--> statement-breakpoint

ANALYZE acervo_chunks;
