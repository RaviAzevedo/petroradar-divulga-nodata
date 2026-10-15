# `shared/` — Contrato de IA compartilhado

Artefatos compartilhados entre os três serviços que falam com a IA (`web`, `bff`, `worker`), para
que todos usem **os mesmos modelos, os mesmos prompts e o mesmo preço por token** — evitando drift
entre a análise feita pelo Next e a feita pelo BFF.

## Arquivo

| Arquivo | Conteúdo |
|---|---|
| `ai-contract.json` | Contrato único de IA: nome da tool (`registrar_analise_edital`), **modelos** por tarefa (`analise` = Sonnet, `ocr` = Haiku), **tabela de preços** (USD por 1k tokens, com cache read/write) e as **instruções/prompt-system** da análise de edital (regras de extração de habilitação + defesa anti-prompt-injection do bloco `<documento_nao_confiavel>`). |

## Por que existe

A análise de edital acontece hoje no app (`route.ts`) e, migrada, no BFF (`bff/app/...`). Manter
prompt/modelos/pricing num JSON único garante **paridade byte-a-byte** da IA entre as duas
implementações e um só lugar para atualizar modelo ou preço. O BFF lê este contrato via
`bff/app/core/ai_contract.py`; o orçamento de tokens é controlado em `bff/app/core/ia_budget.py`.

> Ao trocar de modelo Claude ou ajustar preço, edite **só** este arquivo. Consulte a `/claude-api`
> skill para IDs/pricing atuais dos modelos antes de alterar.
