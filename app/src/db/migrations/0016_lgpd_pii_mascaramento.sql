-- 0016_lgpd_pii_mascaramento.sql
-- LGPD (auditoria 02/07) — minimização/mascaramento de PII em REPOUSO nos dados
-- LEGADOS já gravados. Fecha os achados Altos #1 e #2 da Frente A:
--   1. CPF em claro em envelope_carta_versoes.signatarios[].cpf (JSONB).
--   2. PII em claro em documentos_habilitacao.ocr_texto e cnpj_status_log.dados_brutos.
--
-- Decisão de engenharia (pós-auditoria LGPD): MASCARAR/REDIGIR na origem em vez de cifrar. O CPF completo
-- não é necessário para o negócio (a feature "cartas"/render-docx foi removida e
-- não há writer ativo); ocr_texto é um RESUMO de exibição (NÃO alimenta busca) e
-- dados_brutos é payload raw raramente lido. Mascarar mantém a leitura/exibição
-- intactas SEM exigir chave de cifra (APP_CRYPTO_KEY) nem caminho de decifra —
-- pgcrypto permanece disponível para uma evolução futura se surgir requisito de
-- reversibilidade. Migration IDEMPOTENTE (só toca linhas ainda não mascaradas).
--
-- Roda em TRANSAÇÃO (migrator node-postgres): falha no meio => rollback total.

-- 1) CPF dos signatários de cartas de envelope: mantém só os 2 últimos dígitos
--    (***.***.***-XX). Reconstrói o array JSONB elemento a elemento; só atualiza
--    linhas que tenham ao menos um CPF ainda NÃO mascarado (sem '*').
UPDATE envelope_carta_versoes v
SET signatarios = s.novos
FROM (
  SELECT ev.id,
         jsonb_agg(
           CASE
             WHEN (elem->>'cpf') IS NOT NULL
              AND (elem->>'cpf') <> ''
              AND position('*' in (elem->>'cpf')) = 0
             THEN jsonb_set(
                    elem,
                    '{cpf}',
                    to_jsonb('***.***.***-' || right(regexp_replace(elem->>'cpf', '\D', '', 'g'), 2))
                  )
             ELSE elem
           END
           ORDER BY ord
         ) AS novos
  FROM envelope_carta_versoes ev,
       jsonb_array_elements(ev.signatarios) WITH ORDINALITY AS t(elem, ord)
  WHERE jsonb_typeof(ev.signatarios) = 'array'
  GROUP BY ev.id
) s
WHERE v.id = s.id
  AND EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v.signatarios) e
     WHERE (e->>'cpf') IS NOT NULL
       AND (e->>'cpf') <> ''
       AND position('*' in (e->>'cpf')) = 0
  );--> statement-breakpoint

-- 2) OCR (resumo de documentos de habilitação): redige CPF (formatado e “nu” de
--    11 dígitos) e e-mails. Texto puro -> replace direto; idempotente (o token de
--    máscara não volta a casar). Só toca linhas que ainda contenham PII detectável.
UPDATE documentos_habilitacao
SET ocr_texto = regexp_replace(
                  regexp_replace(
                    regexp_replace(
                      ocr_texto,
                      '\d{3}\.\d{3}\.\d{3}-\d{2}', '[CPF-REMOVIDO]', 'g'
                    ),
                    '\y\d{11}\y', '[CPF-REMOVIDO]', 'g'
                  ),
                  '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[EMAIL-REMOVIDO]', 'g'
                )
WHERE ocr_texto IS NOT NULL
  AND (
        ocr_texto ~ '\d{3}\.\d{3}\.\d{3}-\d{2}'
     OR ocr_texto ~ '\y\d{11}\y'
     OR ocr_texto ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
  );--> statement-breakpoint

-- 3) Payload raw da consulta de CNPJ (BrasilAPI): redige CPF FORMATADO e e-mail no
--    JSONB serializado. NÃO redige “11 dígitos nus” aqui (poderiam ser um número
--    JSON e quebrar o cast ::jsonb); CPF formatado e e-mail sempre vivem dentro de
--    strings JSON, então o replace preserva a validade do JSON. Nomes de sócios
--    (nome_socio) permanecem — residual conhecido e aceito.
UPDATE cnpj_status_log
SET dados_brutos = regexp_replace(
                     regexp_replace(
                       dados_brutos::text,
                       '\d{3}\.\d{3}\.\d{3}-\d{2}', '[CPF-REMOVIDO]', 'g'
                     ),
                     '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[EMAIL-REMOVIDO]', 'g'
                   )::jsonb
WHERE dados_brutos IS NOT NULL
  AND (
        dados_brutos::text ~ '\d{3}\.\d{3}\.\d{3}-\d{2}'
     OR dados_brutos::text ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
  );
