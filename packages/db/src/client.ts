import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema.js";

/** Base de datos o transacción de Drizzle (node-postgres en producción, PGlite en tests). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Cliente crudo capaz de ejecutar SQL con varias sentencias (para migraciones). */
export interface RawExec {
  exec(sql: string): Promise<unknown>;
}

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/** Aplica migrations/*.sql en orden, una sola vez cada una, dentro de una transacción. */
export async function migrate(
  raw: RawExec & { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> },
): Promise<string[]> {
  await raw.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const done = new Set(
    ((await raw.query("SELECT name FROM schema_migrations")).rows as { name: string }[]).map((r) => r.name),
  );
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const body = await readFile(MIGRATIONS_DIR + f, "utf8");
    const name = f.replace(/'/g, "''");
    await raw.exec(`BEGIN;\n${body}\nINSERT INTO schema_migrations (name) VALUES ('${name}');\nCOMMIT;`);
    applied.push(f);
  }
  return applied;
}
