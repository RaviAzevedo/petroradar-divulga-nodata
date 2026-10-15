-- =============================================================================
-- 0032 — Procedência da análise de IA: sobre QUAL texto ela foi feita
-- =============================================================================
-- Ate aqui, `analise/route.ts` fazia:
--
--   const textoParaAnalise = (textosDisponiveis || lic.objeto || "") + textoCirculares;
--
-- Sem texto de anexo a analise NAO falhava: caia em `licitacoes.objeto` e gerava
-- um briefing completo de 12 secoes com a mesma cara de um feito sobre o edital
-- inteiro. Medido em 07/08/2026: `licitacoes.objeto` tem 70 CARACTERES em media,
-- contra ~350.000 disponiveis nos anexos de um edital real. A analise recebia
-- 0,02% do material e ninguem tinha como saber.
--
-- Estas duas colunas tornam isso VISIVEL e AUDITAVEL depois do fato:
--   fonte_texto   ANEXOS  -> leu os documentos do edital
--                 OBJETO  -> leu so a linha de objeto (analise PARCIAL)
--   chars_entrada quantos caracteres o modelo realmente recebeu
--
-- Sem elas, a unica forma de saber se um briefing tem lastro seria olhar se a
-- licitacao TEM texto de anexo HOJE — o que mente para analises antigas, feitas
-- antes da extracao rodar.
--
-- Idempotente (IF NOT EXISTS). Fora do journal do Drizzle — ver
-- db/scripts/apply-extra-migrations.sh.
-- =============================================================================

ALTER TABLE analises_ia ADD COLUMN IF NOT EXISTS fonte_texto text;
ALTER TABLE analises_ia ADD COLUMN IF NOT EXISTS chars_entrada integer;

-- Analises antigas ficam NULL de proposito: nao sabemos o que elas leram, e
-- chutar 'OBJETO' marcaria como pobre uma analise que pode ter sido rica.
-- NULL = "procedencia desconhecida", que e a verdade.

ALTER TABLE analises_ia DROP CONSTRAINT IF EXISTS chk_analise_fonte_texto;
ALTER TABLE analises_ia ADD CONSTRAINT chk_analise_fonte_texto
  CHECK (fonte_texto IS NULL OR fonte_texto IN ('ANEXOS', 'OBJETO'));

COMMENT ON COLUMN analises_ia.fonte_texto IS
  'ANEXOS = analise leu os documentos do edital; OBJETO = leu so licitacoes.objeto (PARCIAL); NULL = anterior a 0032.';
COMMENT ON COLUMN analises_ia.chars_entrada IS
  'Caracteres de entrada que o modelo recebeu de fato (depois do corte ANALISE_MAX_CHARS).';
