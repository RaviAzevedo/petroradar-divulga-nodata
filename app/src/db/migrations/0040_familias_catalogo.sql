-- 0040_familias_catalogo.sql
--
-- O CATALOGO DE FAMILIAS CRC, SEPARADO DO NOSSO CADASTRO.
--
-- POR QUE
-- -------
-- A tabela `familias` tem poucas linhas: as familias em que a Proponente esta
-- CADASTRADA no CRC. Ela carrega estado operacional caro — status_fluxo_crc,
-- validade_fim, proxima_renovacao_em, cadastro_corporativo, e os anexos de
-- certificado em `familias_anexos`.
--
-- Isso responde "estamos cadastrados na familia X?" e mais nada. Nao responde as
-- duas perguntas que decidem dinheiro:
--
--   1. Em que familia o mercado exige e nos NAO estamos cadastrados?
--   2. Em que familia estamos cadastrados e NAO temos como provar?
--
-- Exemplo do problema: uma familia exigida em varias licitacoes e que NAO esta
-- no cadastro nunca aparece na tela. A tela de familias, do jeito que esta, e
-- incapaz de mostrar a familia que mais custa oportunidade, porque so lista o
-- que ja esta cadastrado.
--
-- POR QUE TABELA SEPARADA, E NAO LINHAS NOVAS EM `familias`
-- --------------------------------------------------------
-- Sao duas coisas com significados e ciclos de vida diferentes:
--
--   `familias`           NOSSO CADASTRO. Poucas linhas curadas, com validade,
--                        renovacao e certificado. Cada linha e um ativo da
--                        empresa.
--   `familias_catalogo`  O MERCADO OBSERVADO. Centenas de linhas, quase sem
--                        informacao, reconstruidas a cada `make migrate` a
--                        partir do que o Petro Radar coletou.
--
-- Despejar o catalogo dentro de `familias` afogaria as linhas operacionais em
-- centenas de linhas vazias, e o aviso de renovacao vencendo — que e o que a
-- tela existe para dar — sumiria no meio. Alem disso `familias` tem writers
-- (POST/PATCH/DELETE em conf_familias*), enquanto o catalogo e derivado: um
-- humano nao edita observacao de mercado.
--
-- ⚠️ O CATALOGO NAO E O CATALOGO OFICIAL DA PETROBRAS. E "familias que
-- apareceram nas licitacoes que coletamos". Prova: ha familia do cadastro que
-- nao aparece em licitacao nenhuma da base. Ela existe — so nunca foi exigida
-- no que coletamos. Portanto: ausencia do catalogo NAO significa que a familia nao
-- existe, e a coluna `licitacoes` mede DEMANDA OBSERVADA, nao demanda real. Ate
-- o catalogo oficial do CRC entrar, esta tabela e um mapa parcial, e a tela tem
-- de dizer isso.
--
-- A CHAVE
-- -------
-- O SAP devolve o mesmo codigo em dois formatos: `98010591` e
-- `000000000098010591`. Sem remover o padding, a mesma familia e contada duas
-- vezes. Nenhum codigo comeca
-- legitimamente com zero depois da poda, e nenhum vira vazio.
--
-- `normalizarCodigoCrc` (app/src/lib/conformidade/familias/validations.ts:83 e os
-- espelhos em conf_familias_id.py:191 / conf_familias_w.py:290) NAO remove zero a
-- esquerda — e nao deve passar a remover, porque e a chave unica do cadastro e
-- mudar isso remapearia linha existente. Por isso a funcao abaixo e NOVA e
-- convive com ela: poda o padding SO para efeito de juncao com o catalogo.

CREATE OR REPLACE FUNCTION f_codigo_crc(codigo text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$
  -- IMMUTABLE de proposito: permite indice funcional e uso em coluna gerada.
  SELECT nullif(
           regexp_replace(
             regexp_replace(upper(codigo), '[^A-Z0-9]', '', 'g'),
             '^0+', ''),
           '')
$$;
--> statement-breakpoint

COMMENT ON FUNCTION f_codigo_crc(text) IS
  'Chave de juncao de familia CRC: maiusculas, so alfanumerico, sem zero a esquerda do padding do SAP. NAO substitui normalizarCodigoCrc, que e a chave unica do cadastro em `familias`.';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS familias_catalogo (
  codigo          text PRIMARY KEY,       -- f_codigo_crc() do codigo do Petronect
  codigo_origem   text NOT NULL,          -- como veio, para rastrear ate a fonte
  nome            text,                   -- NULL e comum: o Petronect nem sempre manda
  -- 98* = BEM/MATERIAL (valvula gaveta, transmissor de vazao, conversor de
  -- frequencia). 99* = SERVICO. Para uma proponente de servicos o cadastro e
  -- todo 99*, entao MATERIAL e ruido para ela — mas fica gravado,
  -- porque filtrar na consulta e reversivel e apagar na carga nao e.
  segmento        text NOT NULL CHECK (segmento IN ('MATERIAL','SERVICO','OUTRO')),
  licitacoes      integer NOT NULL DEFAULT 0,   -- DEMANDA OBSERVADA, nao real
  itens           integer NOT NULL DEFAULT 0,
  primeira_vez_em timestamptz,
  ultima_vez_em   timestamptz,            -- recencia: familia exigida em 2019 nao e oportunidade
  fontes          text[] NOT NULL DEFAULT '{}',
  medido_em       timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

COMMENT ON TABLE familias_catalogo IS
  'Familias CRC OBSERVADAS nas licitacoes coletadas (nao e o catalogo oficial da Petrobras). Derivada: reconstruida a cada make migrate. O cadastro da Proponente fica em `familias`.';
--> statement-breakpoint

-- ── Catalogo OFICIAL da Petrobras (carregado pela 0043) ─────────────────────
-- Estas colunas NAO vem da observacao de licitacao: vem do documento oficial
-- "RELACAO DE FAMILIAS PETROBRAS" (804 familias, 802 delas de servico), que traz
-- o ESCOPO canonico de cada uma. E o gabarito contra o qual um atestado pode ser
-- comparado — sem ele, dizer que o acervo "sustenta" uma familia e opiniao.
--
-- Ficam nesta tabela, e nao em `familias`, porque descrevem o MERCADO e nao o
-- nosso cadastro. As colunas sao adicionadas aqui, e nao numa migracao
-- posterior, porque apply-extra-migrations.sh roda por ordem de nome e o DELETE
-- guardado no fim desta migracao ja precisa da coluna `oficial`.
ALTER TABLE familias_catalogo ADD COLUMN IF NOT EXISTS escopo text;
--> statement-breakpoint
ALTER TABLE familias_catalogo ADD COLUMN IF NOT EXISTS grupo text;
--> statement-breakpoint
ALTER TABLE familias_catalogo ADD COLUMN IF NOT EXISTS segmento_petrobras text;
--> statement-breakpoint
-- True = veio do catalogo oficial. Protege a linha do expurgo abaixo: familia
-- que existe no catalogo mas nunca apareceu numa licitacao nossa NAO pode sumir.
ALTER TABLE familias_catalogo ADD COLUMN IF NOT EXISTS oficial boolean NOT NULL DEFAULT false;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_fam_catalogo_segmento ON familias_catalogo (segmento, licitacoes DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_fam_catalogo_demanda  ON familias_catalogo (licitacoes DESC);
--> statement-breakpoint

-- Refresh sem janela vazia: UPSERT de tudo e remocao do que nao foi tocado.
-- Nada de TRUNCATE — a tabela e lida pela tela e um instante vazia mentiria
-- "nenhuma oportunidade". Mesmo desenho da 0039.
--
-- DUAS FONTES, de proposito:
--   petronect_lic_items  o raspao cru (campo `numero` = licitacao; family_descr
--                        vem VAZIO nessa fonte)
--   itens                a tabela do app, ligada a `licitacoes` — e a UNICA que
--                        traz nome (familia_descricao)
-- Sem a segunda, o catalogo nasce sem nome nenhum.
INSERT INTO familias_catalogo
  (codigo, codigo_origem, nome, segmento, licitacoes, itens,
   primeira_vez_em, ultima_vez_em, fontes, medido_em)
WITH bruto AS (
  SELECT f_codigo_crc(p.family) AS codigo,
         p.family               AS codigo_origem,
         nullif(btrim(coalesce(p.family_descr, '')), '') AS nome,
         p.numero               AS licitacao,
         p.captured_at          AS visto_em,
         'petronect_lic_items'  AS fonte
    FROM petronect_lic_items p
   WHERE f_codigo_crc(p.family) IS NOT NULL
  UNION ALL
  SELECT f_codigo_crc(i.familia),
         i.familia,
         nullif(btrim(coalesce(i.familia_descricao, '')), ''),
         -- `numero` da licitacao, NAO o uuid: o raspao cru chaveia por numero, e
         -- contar UUID de um lado e numero do outro faria a MESMA licitacao
         -- contar duas vezes em `licitacoes` e inflar a demanda observada.
         l.numero,
         i.criado_em,
         'itens'
    FROM itens i
    JOIN licitacoes l ON l.id = i.licitacao_id
   WHERE f_codigo_crc(i.familia) IS NOT NULL
)
SELECT codigo,
       min(codigo_origem),
       -- max() ignora NULL: pega qualquer nome disponivel entre as duas fontes.
       max(nome),
       CASE WHEN codigo LIKE '98%' THEN 'MATERIAL'
            WHEN codigo LIKE '99%' THEN 'SERVICO'
            ELSE 'OUTRO' END,
       count(DISTINCT licitacao),
       count(*),
       min(visto_em),
       max(visto_em),
       array_agg(DISTINCT fonte),
       now()
  FROM bruto
 GROUP BY codigo
ON CONFLICT (codigo) DO UPDATE
   SET codigo_origem   = excluded.codigo_origem,
       -- nao apaga nome ja conhecido se a rodada nova nao trouxer nenhum
       nome            = coalesce(excluded.nome, familias_catalogo.nome),
       segmento        = excluded.segmento,
       licitacoes      = excluded.licitacoes,
       itens           = excluded.itens,
       primeira_vez_em = least(excluded.primeira_vez_em, familias_catalogo.primeira_vez_em),
       ultima_vez_em   = greatest(excluded.ultima_vez_em, familias_catalogo.ultima_vez_em),
       fontes          = excluded.fontes,
       medido_em       = excluded.medido_em;
--> statement-breakpoint

-- Expurgo do que nao foi tocado nesta rodada — MENOS o catalogo oficial.
-- Sem o `AND NOT oficial`, toda familia oficial que nunca apareceu numa licitacao
-- nossa seria apagada a cada `make migrate`, e o quadrante "nao ativas que
-- conseguimos aprovar" perderia justamente as candidatas que ninguem exigiu
-- ainda de nos.
DELETE FROM familias_catalogo
 WHERE NOT oficial
   AND medido_em < (SELECT max(medido_em) FROM familias_catalogo WHERE NOT oficial);
--> statement-breakpoint

ANALYZE familias_catalogo;
