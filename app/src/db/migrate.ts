/**
 * Migrator de produção — aplica as migrações geradas pelo drizzle-kit.
 *
 * Uso: `npm run db:migrate` (lê DATABASE_URL do ambiente).
 *
 * node-postgres: cada migração roda em TRANSAÇÃO — se falhar no meio, há rollback
 * automático (estado parcial não persiste). On-prem aponta para o container `db`.
 */

import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

async function main() {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) throw new Error("DATABASE_URL nao definida");

  const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
  const db = drizzle(pool);

  console.log("Aplicando migrações de ./src/db/migrations ...");
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  console.log("Migrações aplicadas com sucesso.");

  await pool.end(); // encerra o processo CLI sem pendurar o pool
}

main().catch((err) => {
  console.error("Falha ao aplicar migrações:", err);
  process.exit(1);
});
