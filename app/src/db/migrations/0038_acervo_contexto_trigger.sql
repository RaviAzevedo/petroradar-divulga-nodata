-- 0038_acervo_contexto_trigger.sql
--
-- MANTÉM `acervo_chunks.contexto` PREENCHIDO EM QUALQUER ESCRITOR.
--
-- POR QUE UM GATILHO, E NÃO CÓDIGO NO INDEXADOR
-- ─────────────────────────────────────────────
-- A migração 0036 preencheu `contexto` nos chunks existentes, mas chunk
-- NOVO nasceria com NULL — e aí `busca_tsv` teria só o texto, sem a identidade
-- do documento. O resultado seria pior que o de antes: a busca híbrida
-- funcionaria bem no acervo antigo e mal no recém-indexado, de forma silenciosa.
--
-- Há mais de um escritor (o cron do Next em app/api/cron/acervo-index, e o que
-- vier depois), e nenhum deles carrega os dados de `operacoes` — o cron
-- seleciona só id/categoria/subcategoria/titulo/ocr_texto. Fazer cada escritor
-- buscar detentora, cliente, unidade e escopo é duplicar a mesma junção em
-- lugares que vão divergir. O contexto é DERIVADO de outras tabelas: pertence ao
-- banco, junto da coluna gerada que o consome.
--
-- O gatilho respeita `contexto` já informado — um backfill ou uma carga especial
-- pode passar o seu próprio valor sem ser sobrescrito.

CREATE OR REPLACE FUNCTION acervo_chunk_contexto() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.contexto IS NOT NULL AND btrim(NEW.contexto) <> '' THEN
    RETURN NEW;                       -- quem inseriu já sabia o que queria
  END IF;

  IF NEW.origem_tipo = 'DOC_HABILITACAO' THEN
    SELECT concat_ws(' · ',
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
      INTO NEW.contexto
      FROM documentos_habilitacao d
      LEFT JOIN operacoes o ON o.id = d.operacao_id
     WHERE d.id = NEW.origem_id;

  ELSIF NEW.origem_tipo = 'ANEXO_EDITAL' THEN
    SELECT concat_ws(' · ',
             nullif(btrim(a.descricao), ''),
             'Anexo de edital',
             left(nullif(btrim(l.objeto), ''), 400))
      INTO NEW.contexto
      FROM anexos a
      LEFT JOIN licitacoes l ON l.id = a.licitacao_id
     WHERE a.id = NEW.origem_id;
  END IF;

  RETURN NEW;
END;
$fn$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_acervo_chunk_contexto ON acervo_chunks;
--> statement-breakpoint

CREATE TRIGGER trg_acervo_chunk_contexto
  BEFORE INSERT ON acervo_chunks
  FOR EACH ROW EXECUTE FUNCTION acervo_chunk_contexto();
