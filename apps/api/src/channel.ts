/**
 * Canales de salida (WhatsApp, SMS, …). Cuadra guarda cada mensaje en `messages` y además lo
 * entrega a cada canal configurado. Un canal solo traduce: nunca decide ni mueve dinero.
 */
import { type Db, type MessageAction, realPhone10, schema } from "@cuadra/db";
import { and, eq } from "drizzle-orm";
import type { TemplateRef } from "./whatsapp-templates.js";

export interface OutboundMessage {
  merchantId: string;
  /** "comercio", id de cliente o "tanda:<id>:<posición>". */
  thread: string;
  /** Celular de 10 dígitos del destinatario. */
  phone10: string;
  body: string;
  /** Botones: confirm/cancel llevan proposal_id; pay/approve/link llevan url; qr lleva imagen. */
  actions: MessageAction[];
  /** Plantilla aprobada para cuando el mensaje lo inicia el negocio (fuera de la ventana de 24 h). */
  template?: TemplateRef;
}

export interface OutboundChannel {
  readonly name: string;
  send(msg: OutboundMessage): Promise<void>;
}

const ten = realPhone10;

/**
 * Celular del destinatario de una conversación, tomado de la base (nunca del texto). Solo se entrega
 * por WhatsApp/SMS cuando la tienda probó que el celular de su dueño es suyo (le escribió a Cuadra):
 * así nadie puede registrarse con el celular de otra persona y hacer que le lleguen mensajes, ni
 * mandar mensajes a nombre de una tienda sin dueño verificado. A un cliente, además, solo con su
 * permiso (opt-in); a un integrante, solo si la tanda es de esta tienda.
 */
export async function resolveThreadPhone(db: Db, merchantId: string, ownerId: string, thread: string): Promise<string | null> {
  const [owner] = await db
    .select({ phone: schema.merchantUsers.phone, verified: schema.merchantUsers.phoneVerified })
    .from(schema.merchantUsers)
    .where(and(eq(schema.merchantUsers.id, ownerId), eq(schema.merchantUsers.merchantId, merchantId)));
  if (!owner?.verified) return null;
  if (thread === "comercio") return ten(owner.phone);
  const tanda = /^tanda:([^:]+):(\d+)$/.exec(thread);
  if (tanda) {
    const [m] = await db
      .select({ phone: schema.tandaMembers.phone })
      .from(schema.tandaMembers)
      .innerJoin(schema.tandas, eq(schema.tandas.id, schema.tandaMembers.tandaId))
      .where(and(eq(schema.tandaMembers.tandaId, tanda[1]!), eq(schema.tandaMembers.position, Number(tanda[2])), eq(schema.tandas.merchantId, merchantId)));
    return ten(m?.phone);
  }
  const [c] = await db
    .select({ phone: schema.customers.phone, optIn: schema.customers.optIn })
    .from(schema.customers)
    .where(and(eq(schema.customers.id, thread), eq(schema.customers.merchantId, merchantId)));
  return c?.optIn ? ten(c.phone) : null;
}
