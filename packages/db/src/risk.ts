import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { riskState, systemState } from "./schema.js";

/** Freno de emergencia: global (todos los comercios) o de un comercio. */
export async function setKillSwitch(db: Db, scope: { global: true } | { merchantId: string }, on: boolean): Promise<void> {
  const now = new Date();
  if ("global" in scope) {
    await db.update(systemState).set({ killSwitch: on, updatedAt: now }).where(eq(systemState.id, true));
    return;
  }
  await db
    .insert(riskState)
    .values({ merchantId: scope.merchantId, killSwitch: on })
    .onConflictDoUpdate({ target: riskState.merchantId, set: { killSwitch: on, updatedAt: now } });
}

/** Si la fila global no existe, se asume freno activado (falla cerrado). */
export async function globalKillSwitch(db: Db): Promise<boolean> {
  const [s] = await db.select({ on: systemState.killSwitch }).from(systemState);
  return s?.on ?? true;
}
