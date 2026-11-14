import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Db } from "./client.js";
import { migrate } from "./client.js";
import * as schema from "./schema.js";

/** Conexión de producción. La URL viene del entorno, nunca del código. */
export async function connectPostgres(url: string): Promise<{ db: Db; pool: pg.Pool }> {
  const pool = new pg.Pool({ connectionString: url });
  // int8 → string; Drizzle convierte a bigint en columnas mode "bigint".
  const db = drizzle(pool, { schema }) as unknown as Db;
  return { db, pool };
}

export async function migratePostgres(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    return await migrate({
      exec: (sql) => client.query(sql),
      query: (sql, params) => client.query(sql, params as unknown[]),
    });
  } finally {
    client.release();
  }
}
