import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Db } from "./client.js";
import { migrate } from "./client.js";
import * as schema from "./schema.js";

let template: Promise<PGlite> | null = null;

async function migratedTemplate(): Promise<PGlite> {
  const pg = new PGlite();
  await migrate({ exec: (sql) => pg.exec(sql), query: (sql, params) => pg.query(sql, params) });
  return pg;
}

/**
 * Postgres real en memoria (PGlite) con migraciones aplicadas. Solo para tests y simulador.
 * Migra una vez por proceso y clona la plantilla para cada base nueva.
 */
export async function createTestDb(): Promise<{ db: Db; pg: PGlite }> {
  template ??= migratedTemplate();
  const pg = (await (await template).clone()) as PGlite;
  const db = drizzle(pg, { schema }) as unknown as Db;
  return { db, pg };
}
