import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Db } from "./client.js";
import { migrate } from "./client.js";
import * as schema from "./schema.js";

let template: Promise<PGlite> | null = null;
/** Bases creadas y aún abiertas (sin la plantilla). Cada una ocupa ~250 MB de memoria WASM. */
const open = new Set<PGlite>();

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
  open.add(pg);
  const db = drizzle(pg, { schema }) as unknown as Db;
  return { db, pg };
}

/**
 * Cierra las bases que creó createTestDb (la plantilla se queda para clonar más). Las pruebas lo
 * llaman después de cada test (test/setup.ts): sin esto cada base se queda en memoria y un archivo
 * con muchas pruebas llega a varios GB, lo que tumba la máquina de CI.
 */
export async function closeTestDbs(): Promise<void> {
  const all = [...open];
  open.clear();
  await Promise.allSettled(all.map((pg) => pg.close()));
}
