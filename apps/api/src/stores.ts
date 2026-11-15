/**
 * Una tienda por persona (decisión 14-nov-2026). Cada petición trabaja con la tienda de quien la
 * hace: su CuadraService, su dueño y su pasarela. Solo la tienda marcada como `live_payments` (la
 * demo, con su cuenta receptora en pey) cobra en vivo; las demás cobran y pagan en modo simulado
 * para que el dinero de una tienda nunca llegue a la cuenta de otra.
 */
import { type PeyTransaction, WebhookSignatureError, parsePeyWebhook } from "@cuadra/adapters";
import { type Db, schema, storeOwner } from "@cuadra/db";
import { and, eq, inArray, or } from "drizzle-orm";
import type { ChargeGateway } from "./gateway.js";
import type { CuadraService } from "./service.js";

export interface Store {
  merchantId: string;
  ownerId: string;
  live: boolean;
  gateway: ChargeGateway;
  service: CuadraService;
}

export interface StoreRegistryDeps {
  db: Db;
  /** Pasarela de la tienda en vivo (pey). Si no hay llave, la simulada. */
  liveGateway: ChargeGateway;
  simulatedGateway: ChargeGateway;
  build: (s: { merchantId: string; ownerId: string; gateway: ChargeGateway; live: boolean }) => CuadraService;
}

export class StoreRegistry {
  private readonly cache = new Map<string, Promise<Store | null>>();
  constructor(private readonly d: StoreRegistryDeps) {}

  /** La tienda (con su servicio) o null si no existe o no tiene dueño. */
  get(merchantId: string): Promise<Store | null> {
    let s = this.cache.get(merchantId);
    if (!s) {
      s = this.load(merchantId);
      this.cache.set(merchantId, s);
      // Si no existe todavía, no se recuerda el null (puede crearse después).
      void s.then((v) => { if (!v) this.cache.delete(merchantId); }, () => this.cache.delete(merchantId));
    }
    return s;
  }

  private async load(merchantId: string): Promise<Store | null> {
    const [m] = await this.d.db.select().from(schema.merchants).where(eq(schema.merchants.id, merchantId));
    if (!m) return null;
    const owner = await storeOwner(this.d.db, merchantId);
    if (!owner) return null;
    const live = m.livePayments && !this.d.liveGateway.simulated;
    const gateway = live ? this.d.liveGateway : this.d.simulatedGateway;
    return { merchantId, ownerId: owner.id, live, gateway, service: this.d.build({ merchantId, ownerId: owner.id, gateway, live }) };
  }
}

/** Tienda a la que pertenece una transacción del proveedor (por su cobro o aportación de tanda). */
export async function merchantOfTransaction(db: Db, tx: PeyTransaction): Promise<string | null> {
  const chargeId = tx.external_metadata.cuadra_charge_id;
  if (chargeId) {
    const [c] = await db.select({ m: schema.charges.merchantId }).from(schema.charges).where(eq(schema.charges.id, chargeId));
    if (c) return c.m;
  }
  const tandaChargeId = tx.external_metadata.cuadra_tanda_charge_id;
  if (tandaChargeId) {
    const [t] = await db
      .select({ m: schema.tandas.merchantId })
      .from(schema.tandaCharges)
      .innerJoin(schema.tandas, eq(schema.tandas.id, schema.tandaCharges.tandaId))
      .where(eq(schema.tandaCharges.id, tandaChargeId));
    if (t) return t.m;
  }
  const ids = [tx.id, tx.payable_id].filter((x): x is string => !!x);
  if (ids.length) {
    const [c] = await db
      .select({ m: schema.charges.merchantId })
      .from(schema.charges)
      .where(or(inArray(schema.charges.providerChargeId, ids)));
    if (c) return c.m;
  }
  return null;
}

/**
 * Webhook de pey para todas las tiendas: verifica la firma, deduplica, confirma cada pago contra la
 * API y lo aplica en la tienda dueña del cobro. Lo que no se puede ligar a un cobro va a la tienda
 * en vivo (la dueña de la cuenta receptora), que lo deja en "por identificar" si no lo reconoce.
 */
export async function handlePeyWebhookForStores(
  d: { db: Db; registry: StoreRegistry; secret: string | null; gateway: ChargeGateway; liveMerchantId: string },
  rawBody: string,
  headers: Record<string, string | undefined>,
): Promise<{ status: number; body: unknown }> {
  if (!d.secret) return { status: 503, body: { error: "pey no configurado" } };
  let evt;
  try {
    evt = parsePeyWebhook(rawBody, headers, d.secret);
  } catch (e) {
    if (e instanceof WebhookSignatureError) return { status: 400, body: { error: "firma inválida" } };
    throw e;
  }
  const fresh = await d.db
    .insert(schema.webhookEvents)
    .values({ provider: "pey", eventId: evt.event_id, payload: JSON.parse(rawBody) })
    .onConflictDoNothing()
    .returning({ id: schema.webhookEvents.eventId });
  if (fresh.length === 0) return { status: 200, body: { duplicate: true } };
  if (evt.kind === "ignored") return { status: 200, body: { ignored: evt.original_type } };
  try {
    for (const txId of evt.transaction_ids) {
      // "Confirma el pago desde el servidor": no confiamos en el monto del webhook.
      const tx = await d.gateway.getTransaction(txId);
      if (tx.status !== "PAID") continue;
      const merchantId = (await merchantOfTransaction(d.db, tx)) ?? d.liveMerchantId;
      const store = (await d.registry.get(merchantId)) ?? (await d.registry.get(d.liveMerchantId));
      if (!store) throw new Error("No hay tienda para aplicar el pago");
      await store.service.applyPayment(tx);
    }
  } catch (e) {
    // Se borra el registro del evento para que el reintento de pey lo vuelva a procesar.
    await d.db.delete(schema.webhookEvents).where(and(eq(schema.webhookEvents.provider, "pey"), eq(schema.webhookEvents.eventId, evt.event_id)));
    throw e;
  }
  return { status: 200, body: { ok: true } };
}
