/**
 * Borrado de cuentas del portal por orden del dueño (p. ej. olvidó su NIP: el NIP está cifrado y no
 * se puede recuperar). Se pide con la variable PORTAL_RESET="<celular>@<fecha ISO>[,...]": al
 * arrancar se borran las cuentas de ese celular creadas ANTES de esa fecha (y sus sesiones, en
 * cascada). Una cuenta nueva registrada después no se toca aunque la variable siga puesta.
 * En logs solo van los últimos 4 dígitos.
 */
import { type Db, schema } from "@cuadra/db";
import { and, eq, lt } from "drizzle-orm";

export interface PortalReset {
  phone10: string;
  before: Date;
}

export function parsePortalReset(raw: string | undefined): { entries: PortalReset[]; invalid: string[] } {
  const entries: PortalReset[] = [];
  const invalid: string[] = [];
  for (const part of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d{10})@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z)$/.exec(part);
    const before = m ? new Date(m[2]!) : null;
    if (m && before && !Number.isNaN(before.getTime())) entries.push({ phone10: m[1]!, before });
    else invalid.push(part.replace(/\d(?=\d{4})/g, "•"));
  }
  return { entries, invalid };
}

export async function resetPortalAccounts(db: Db, merchantId: string, entries: PortalReset[]): Promise<Array<{ phone_last4: string; deleted: number }>> {
  const out: Array<{ phone_last4: string; deleted: number }> = [];
  for (const e of entries) {
    const gone = await db
      .delete(schema.portalAccounts)
      .where(and(eq(schema.portalAccounts.merchantId, merchantId), eq(schema.portalAccounts.phone, e.phone10), lt(schema.portalAccounts.createdAt, e.before)))
      .returning({ id: schema.portalAccounts.id });
    out.push({ phone_last4: e.phone10.slice(-4), deleted: gone.length });
  }
  return out;
}
