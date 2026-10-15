-- scripts/parity/04_db_keys.sql
-- Lista TODAS as chaves de objeto referenciadas pelo banco (as 7 colunas de blob
-- do schema). Usada pelo passo de validacao banco<->MinIO do load-and-run.sh
-- (--restore-blobs) p/ garantir "blobs faltando: 0" apos o mirror R2->MinIO.
-- Saida: uma chave por linha (sem cabecalho). Rode com: psql -tA -f este.sql
SELECT s3_key  AS key FROM anexos                         WHERE s3_key  IS NOT NULL AND s3_key  <> ''
UNION
SELECT blob_key FROM documentos_habilitacao               WHERE blob_key IS NOT NULL AND blob_key <> ''
UNION
SELECT blob_key FROM documentos_habilitacao_anexos        WHERE blob_key IS NOT NULL AND blob_key <> ''
UNION
SELECT blob_key FROM familias_anexos                      WHERE blob_key IS NOT NULL AND blob_key <> ''
UNION
SELECT blob_key FROM iqf_avaliacoes                       WHERE blob_key IS NOT NULL AND blob_key <> ''
UNION
SELECT blob_key FROM participacoes_documentos             WHERE blob_key IS NOT NULL AND blob_key <> ''
UNION
SELECT blob_key FROM petitorios_licitacao                 WHERE blob_key IS NOT NULL AND blob_key <> '';
