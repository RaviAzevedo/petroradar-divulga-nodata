# Petro Radar — app (Next.js)

Frontend e camada web do Petro Radar: UI/PWA, rotas `/api`, autenticação e o **schema do banco**
(Drizzle + migrations). Visão geral do projeto no [README da raiz](../README.md).

## Estrutura

```
src/
├─ app/          App Router: páginas (painel, hoje, explorar, licitações, resultados, acervo, admin) e rotas /api
├─ components/   Componentes de UI (layout, licitações, conformidade, shared)
├─ lib/          Regras de negócio: classificação, análise por IA, briefing/dossiê, acervo (RAG), e-mail, RBAC
├─ db/           schema.ts (Drizzle), migrations SQL e migrator
└─ __tests__/    Testes unitários (vitest)
```

## Desenvolvimento

```bash
npm install
cp .env.example .env.local   # DATABASE_URL, AUTH_SECRET, storage S3, chave do LLM
npm run db:migrate           # migrations versionadas pelo Drizzle
npm run dev                  # http://localhost:3000
```

As migrations a partir da `0019` são SQL escrito à mão, fora do journal do Drizzle; aplique-as com
`db/scripts/apply-extra-migrations.sh` (o `make migrate` da raiz já faz os dois passos).

| Script | O que faz |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm test` | vitest |
| `npm run lint` | eslint |
| `npm run db:generate` / `db:migrate` / `db:studio` | Drizzle |

## Autenticação e papéis

NextAuth v5 com SSO Microsoft Entra ID (opcional) e login local por senha (bcrypt). Sete papéis:
`ADMIN`, `LIDER`, `ORCAMENTISTA`, `TECNICO`, `SGI`, `VISUALIZADOR`, `EXTERNO` — regras em
`src/lib/permissions.ts` e `src/lib/nav-access.ts`.
