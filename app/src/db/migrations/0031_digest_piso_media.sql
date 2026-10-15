-- =============================================================================
-- 0031 — digest diario so com ALTA e MEDIA
-- =============================================================================
-- Decisao do dono (07/08/2026): "todo dia de manha um e-mail com as licitacoes
-- mais relevantes, altas e medias, num e-mail so".
--
-- O default da coluna muda para MEDIA (score >= 55, a mesma regua do badge no
-- Explorar) e as assinaturas existentes que estavam em TODAS sobem para MEDIA.
-- Quem tiver escolhido ALTA explicitamente NAO e rebaixado.
-- =============================================================================

ALTER TABLE assinaturas_email ALTER COLUMN relevancia_minima SET DEFAULT 'MEDIA';

UPDATE assinaturas_email SET relevancia_minima = 'MEDIA' WHERE relevancia_minima = 'TODAS';
