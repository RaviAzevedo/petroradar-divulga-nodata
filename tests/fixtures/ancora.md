# Corpus-âncora do RAG (WP12 §3.4 / §1.2)

5 chunks conhecidos em `acervo_chunks` (criados por `seed.sql`), usados para
provar **recall do top-K** e **anti-IDOR** sem depender de IA não-determinística.

| Chunk | origem_tipo | origem_id | Uso no teste |
|---|---|---|---|
| CHK-1 | DOC_HABILITACAO | FAM-1 | Recall: query "atestado de refino REF-A" DEVE citar CHK-1 |
| CHK-2 | ANEXO_EDITAL | LIC-A | Recall: query de escopo cita CHK-2 |
| CHK-3 | DOC_HABILITACAO | FAM-2 | Distrator (não deve dominar o top-K) |
| CHK-4 | ANEXO_EDITAL | LIC-B | Recall de circular |
| CHK-5 | DOC_HABILITACAO | FAM-1 | **Anti-IDOR**: papel EXTERNO/sem-acesso NÃO pode receber este trecho |

## Assertions

- **Dimensão**: o embedding da query tem **1024** (BGE-m3 via `embeddings-local`),
  não 1536 (Voyage). Casa com `acervo_chunks.embedding vector(1024)` (migration 0015).
- **Recall**: para `query="atestado de capacidade técnica em refino REF-A"`, o top-K
  (`ACERVO_TOP_K=8`, `ACERVO_SIMILARIDADE_MIN=0.35`) contém `origem=DOC_HABILITACAO/FAM-1`.
- **Anti-IDOR** (`ROTAS.md` §1, `requireAcervo`+`assertAcessoObjeto`): papel `EXTERNO`
  recebe `403`; papel sem acesso ao objeto NÃO recebe CHK-5.
- **Paridade Next≡BFF**: `POST /api/acervo/buscar` e `POST /bff/acervo/buscar`
  aplicam o mesmo gate de papel e o mesmo filtro por origem.
