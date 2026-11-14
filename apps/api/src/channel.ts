/**
 * Canales de salida (WhatsApp, SMS, …). Cuadra guarda cada mensaje en `messages` y además lo
 * entrega a cada canal configurado. Un canal solo traduce: nunca decide ni mueve dinero.
 */
import { type Db, type MessageAction, schema } from "@cuadra/db";
import { and, eq } from "drizzle-orm";

export interface OutboundMessage {
  merchantId: string;
  /** "comercio", id de cliente o "tanda:<id>:<posición>". */
  thread: string;
  /** Celular de 10 dígitos del destinatario. */
  phone10: string;
  body: string;
  /** Botones: confirm/cancel llevan proposal_id; pay/approve/link llevan url; qr lleva imagen. */
  actions: MessageAction[];
}

export interface OutboundChannel {
  readonly name: string;
  send(msg: OutboundMessage): Promise<void>;
}

const ten = (p: string | null | undefined) => {
  const d = (p ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
};

/** Celular del destinatario de una conversación, tomado de la base (nunca del texto). */
export async function resolveThreadPhone(db: Db, merchantId: string, ownerId: string, thread: string): Promise<string | null> {
  if (thread === "comercio") {
    const [u] = await db.select({ phone: schema.merchantUsers.phone }).from(schema.merchantUsers).where(eq(schema.merchantUsers.id, ownerId));
    return ten(u?.phone);
  }
  const tanda = /^tanda:([^:]+):(\d+)$/.exec(thread);
  if (tanda) {
    const [m] = await db
      .select({ phone: schema.tandaMembers.phone })
      .from(schema.tandaMembers)
      .where(and(eq(schema.tandaMembers.tandaId, tanda[1]!), eq(schema.tandaMembers.position, Number(tanda[2]))));
    return ten(m?.phone);
  }
  const [c] = await db
    .select({ phone: schema.customers.phone })
    .from(schema.customers)
    .where(and(eq(schema.customers.id, thread), eq(schema.customers.merchantId, merchantId)));
  return ten(c?.phone);
}
