-- =============================================================================
-- 0030 — piso de relevância por assinatura
-- =============================================================================
-- Ate aqui o digest por perfil mandava TUDO que casava com o perfil, sem corte.
-- Na pratica isso misturava, no mesmo e-mail, licitacao de score alto com score 0:
-- parte saia SEM INTERESSE com score 0 (casaram por palavra-chave do perfil,
-- mas o motor nao pontuou).
--
-- Reaproveita a regua que o motor de criterios ja tem
-- (SCORE_POR_RELEVANCIA: ALTA=75, MEDIA=55, TODAS=0), entao nao inventa escala
-- nova: e a MESMA que o /explorar usa para pintar o badge.
--
-- Default TODAS = comportamento atual preservado; ninguem para de receber por
-- causa desta migration.
-- =============================================================================

ALTER TABLE assinaturas_email
  ADD COLUMN IF NOT EXISTS relevancia_minima text NOT NULL DEFAULT 'TODAS';

ALTER TABLE assinaturas_email DROP CONSTRAINT IF EXISTS chk_assinatura_relevancia;
ALTER TABLE assinaturas_email
  ADD CONSTRAINT chk_assinatura_relevancia
  CHECK (relevancia_minima IN ('ALTA', 'MEDIA', 'TODAS'));
