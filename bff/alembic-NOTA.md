# Por que o BFF FastAPI **NÃO** usa Alembic

> **Decisão travada:** o schema do PostgreSQL é administrado **exclusivamente pelo
> Drizzle** (lado Node). O FastAPI **lê e escreve dados**, mas **não cria nem altera
> estrutura**. **Não há, e não deve haver, Alembic neste serviço.**

Esta nota explica o porquê, e mostra **como o schema é aplicado** (via `drizzle-kit`)
e **como o FastAPI consome** as tabelas existentes.

---

## 1. O problema: dois donos do schema = drift garantido

Durante o estrangulamento (strangler-fig), Next e FastAPI vivem **sobre o mesmo
banco** ao mesmo tempo. Se **ambos** tivessem ferramenta de migration:

- **Ordem de aplicação ambígua.** Quem roda primeiro no deploy, `drizzle-kit push`
  ou `alembic upgrade`? Qualquer ordem cria janelas em que o banco não bate com um
  dos serviços.
- **Histórico de migrations duplicado e divergente.** Drizzle tem o seu diretório de
  migrations; o Alembic teria a tabela `alembic_version`. Os dois "acham" que são
  donos — e podem tentar criar/dropar a **mesma** tabela.
- **Tipos que o Alembic não conhece.** A coluna `acervo_chunks.embedding` é
  `vector(1536)` (pgvector). O autogenerate do Alembic não reconhece `vector`
  nativamente: ele veria a coluna como tipo desconhecido e poderia propor um
  `ALTER COLUMN`/`DROP` espúrio. Index HNSW/IVFFlat idem.
- **`autogenerate` destrutivo.** Como os modelos SQLAlchemy do BFF são um **reflexo
  parcial** (mapeamos só o que cada onda precisa), um `alembic revision
  --autogenerate` enxergaria "tabelas/colunas faltando" e proporia **DROP** do que o
  Drizzle administra mas o SQLAlchemy ainda não mapeou. Um único `upgrade` aplicado
  por engano = perda de schema.

Resultado inevitável: **drift** (banco real ≠ o que cada serviço espera),
exatamente o que a arquitetura do estrangulador precisa evitar enquanto os dois
coexistem.

## 2. A regra

- **Fonte única de verdade do schema = Drizzle (Node).** Toda DDL (CREATE/ALTER/DROP
  de tabela, coluna, índice, constraint, extensão) passa **só** por `drizzle-kit`.
- **FastAPI = consumidor de dados.** SQLAlchemy 2 (async + asyncpg) executa apenas
  **DML** (SELECT/INSERT/UPDATE/DELETE). Nunca DDL.
- **Modelos SQLAlchemy descrevem, não definem.** Eles são o mapeamento Python das
  tabelas que **já existem**; se divergirem do banco, conserta-se o **mapeamento**,
  nunca o banco.
- **Proibido neste repositório:** `alembic`, `alembic.ini`, pasta `migrations/` do
  Alembic, `Base.metadata.create_all()`, qualquer `CREATE TABLE`/`ALTER TABLE`
  emitido pelo BFF.

---

## 3. Como o schema é aplicado — **drizzle-kit (lado Node)**

Tudo acontece no projeto Node (o app Next.js), **não** aqui:

```bash
# No container/projeto Next.js — fluxo de schema:

# 1. Editar o schema em Drizzle (TypeScript), ex.: src/db/schema.ts

# 2. Gerar o SQL de migration a partir do diff do schema
npx drizzle-kit generate           # cria ./drizzle/XXXX_*.sql + snapshot

# 3. Aplicar no banco
npx drizzle-kit migrate            # aplica migrations versionadas (prod)
# ou, em dev:
npx drizzle-kit push               # empurra o schema direto (sem arquivo)

# 4. Inspecionar
npx drizzle-kit studio             # GUI para conferir o estado real
```

- A extensão **pgvector** e a coluna `vector(1536)` de `acervo_chunks` são criadas e
  versionadas **aqui**, no Drizzle. O BFF assume que já existem.
- O **deploy** roda a migration do Drizzle **antes** de subir/atualizar o BFF. Ordem
  do pipeline: `drizzle-kit migrate` → restart Next → (depois) restart BFF.

---

## 4. Como o FastAPI **consome** as tabelas existentes

O BFF mapeia as tabelas já criadas pelo Drizzle. Duas abordagens, ambas **sem DDL**:

### 4.1. Mapeamento declarativo "espelho" (preferido)

Para cada tabela que uma onda precisa, declara-se um modelo SQLAlchemy que **espelha**
exatamente as colunas que o Drizzle criou. Não se chama `create_all()` — o modelo só
serve para o ORM saber ler/escrever.

```python
# app/db/models/acervo.py  (exemplo ilustrativo)
from sqlalchemy import String, Text, Integer
from sqlalchemy.orm import Mapped, mapped_column
from pgvector.sqlalchemy import Vector
from app.db.session import Base   # DeclarativeBase, usado SÓ p/ mapear

class AcervoChunk(Base):
    __tablename__ = "acervo_chunks"   # tabela criada pelo Drizzle
    id:        Mapped[int]  = mapped_column(Integer, primary_key=True)
    documento: Mapped[str]  = mapped_column(String)
    conteudo:  Mapped[str]  = mapped_column(Text)
    # casa com a coluna vector(1536) que o Drizzle/pgvector criou:
    embedding: Mapped[list[float]] = mapped_column(Vector(1536))
```

> O tipo `Vector` vem de `pgvector.sqlalchemy` (pacote pip `pgvector`). Ele só
> **mapeia** uma coluna `vector` pré-existente — não a cria. Buscas de similaridade
> usam os operadores do pgvector (`<->`, `<=>`) via `.op()` ou os helpers
> `embedding.l2_distance(...)` / `.cosine_distance(...)`.

### 4.2. Introspecção / reflection (quando útil)

Para tabelas grandes/estáveis que o BFF só **lê**, dá para refletir o schema em
tempo de execução, evitando manter o espelho à mão:

```python
from sqlalchemy import MetaData, Table
meta = MetaData()
# reflete a definição que JÁ existe no banco (criada pelo Drizzle):
licitacoes = Table("licitacoes", meta, autoload_with=sync_engine)
```

> Reflection lê o catálogo do Postgres; não emite DDL. Tipos custom como `vector`
> podem precisar de registro de tipo para refletir corretamente — por isso, para
> tabelas com `vector`, prefira o mapeamento declarativo da §4.1.

### 4.3. Quando o Drizzle muda o schema

1. Migration roda **no Node** (`drizzle-kit migrate`).
2. Só então atualiza-se o **mapeamento** SQLAlchemy correspondente no BFF (adicionar
   a coluna no modelo espelho, ou nada a fazer se for reflection de leitura).
3. Deploy: schema primeiro (Node), código do BFF depois.

Nunca o inverso. O BFF **nunca** lidera uma mudança de estrutura.

---

## 5. "E quando o login/auth migrar para o FastAPI?"

Mesmo nesse cenário futuro (fora das 5 ondas atuais — ver `MIGRACAO-ROTAS-ONDAS.md`),
a regra **não muda**: o schema das tabelas de auth continuaria sendo criado pelo
Drizzle. Se um dia o Node sair de cena por completo e o FastAPI virar o único dono do
banco, **aí sim** se reavalia introduzir Alembic — com uma migration inicial de
*baseline* (`stamp`) refletindo o estado deixado pelo Drizzle. **Hoje não é esse o
caso**, e introduzir Alembic agora reintroduziria o drift que esta nota existe para
evitar.

---

## TL;DR

- Schema: **só Drizzle** (`drizzle-kit generate/migrate/push`), no Node.
- FastAPI: **só DML** via SQLAlchemy; modelos **espelham** tabelas existentes
  (incl. `vector(1536)` via `pgvector.sqlalchemy`).
- **Sem Alembic, sem `create_all()`, sem DDL** no BFF — para não criar dois donos do
  mesmo banco e gerar drift.
- Ordem de deploy: **migration do Drizzle primeiro**, BFF depois.
