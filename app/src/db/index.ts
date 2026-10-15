// Driver de banco: node-postgres (Pool TCP) para o on-prem (container `db` pgvector/pg16).
// Substitui o antigo driver Neon HTTP (@neondatabase/serverless + drizzle-orm/neon-http),
// que não fala TCP nem suporta transações reais.
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

const DATABASE_URL = process.env.DATABASE_URL;

// Pool TCP do node-postgres. On-prem aponta para o container `db` (pgvector/pg16)
// via DATABASE_URL=postgres://USER:PASS@db:5432/petro_radar.
// `max` limita conexões por instância web; ajustar via DB_POOL_MAX se necessário.
let _pool: Pool | null = null;
// Lazy init para o build (next build) funcionar SEM DATABASE_URL.
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

// NOTA (2026-07-02): o SHIM db.batch (compatibilidade com o legado neon-http)
// foi REMOVIDO. Todos os call-sites foram convertidos para transações reais
// via db.transaction(async (tx) => ...) — atomicidade de verdade no driver pg.
// Não reintroduzir db.batch: escreva multi-statements dentro de db.transaction.
type Db = ReturnType<typeof drizzle<typeof schema>>;

function getDb(): Db {
  if (!_db) {
    if (!DATABASE_URL) throw new Error("DATABASE_URL nao definida");
    _pool = new Pool({
      connectionString: DATABASE_URL,
      max: Number(process.env.DB_POOL_MAX ?? 10),
      // On-prem é rede interna sem TLS por padrão; habilite via DATABASE_URL
      // (?sslmode=require) se o Postgres exigir. Aqui não forçamos ssl.
    });
    _db = drizzle(_pool, { schema });
  }
  return _db;
}

// Proxy para manter `import { db } from "@/db"` funcionando em todo o código.
// A superfície pública (db.select/insert/update/delete/transaction) é preservada.
export const db = new Proxy({} as Db, {
  get(_, prop) {
    return (getDb() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

// (closeDb removido em 2026-07-02: era p/ scripts/CLI legados, já apagados.)
