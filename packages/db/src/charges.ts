import { randomInt } from "node:crypto";
import { type Centavos, abonoIdentificado } from "@cuadra/core";
import { and, eq, or } from "drizzle-orm";
import type { Db } from "./client.js";
import { recordDeposit, type DepositOutcome } from "./deposits.js";
import { ledgerBalance, postEntries } from "./ledger-repo.js";
import { charges, customers, deposits } from "./schema.js";
import { lockMerchant } from "./transfers.js";

/** Referencia numérica de 7 dígitos sin cero inicial (CoDi numRef / SPEI referencia). */
export async function newChargeReference(db: Db, merchantId: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const ref = String(randomInt(1_000_000, 10_000_000));
    const [taken] = await db
      .select({ id: charges.id })
      .from(charges)
      .where(and(eq(charges.merchantId, merchantId), eq(charges.reference, ref)));
    if (!taken) return ref;
  }
  throw new Error("No se pudo generar una referencia única");
}

/** Un cobro sin proveedor (solo referencia) se considera vencido a las 72 h, como la política de recordatorios. */
export const CHARGE_DEFAULT_TTL_MS = 72 * 60 * 60 * 1000;
/** Margen antes de dar por vencido un cobro, por diferencias de reloj con el proveedor. */
export const CHARGE_EXPIRY_GRACE_MS = 2 * 60 * 1000;

export async function insertCharge(
  db: Db,
  c: {
    id: string;
    merchantId: string;
    customerId: string;
    reference: string;
    amountCents: Centavos;
    now: Date;
  },
): Promise<void> {
  await db.insert(charges).values({
    id: c.id,
    merchantId: c.merchantId,
    customerId: c.customerId,
    reference: c.reference,
    amountCents: c.amountCents,
    createdAt: c.now,
    expiresAt: new Date(c.now.getTime() + CHARGE_DEFAULT_TTL_MS),
  });
}

/**
 * Cobro abierto vigente del cliente. Los que ya vencieron en el proveedor se marcan como
 * vencidos y no bloquean un cobro nuevo.
 */
export async function openChargeFor(db: Db, customerId: string, now: Date) {
  const open = await db
    .select()
    .from(charges)
    .where(and(eq(charges.customerId, customerId), eq(charges.status, "open")));
  let live: (typeof open)[number] | null = null;
  for (const c of open) {
    if (c.expiresAt && c.expiresAt.getTime() + CHARGE_EXPIRY_GRACE_MS < now.getTime()) {
      await db.update(charges).set({ status: "expired" }).where(and(eq(charges.id, c.id), eq(charges.status, "open")));
    } else {
      live ??= c;
    }
  }
  return live;
}

export async function attachProviderCharge(
  db: Db,
  chargeId: string,
  p: {
    provider: string;
    providerChargeId: string;
    channel: "codi_pn" | "codi_qr" | "payment_link";
    paymentUrl?: string | null;
    /** Vencimiento del cobro en el proveedor. */
    expiresAt?: Date;
  },
): Promise<void> {
  await db
    .update(charges)
    .set({
      provider: p.provider,
      providerChargeId: p.providerChargeId,
      channel: p.channel,
      paymentUrl: p.paymentUrl ?? null,
      ...(p.expiresAt ? { expiresAt: p.expiresAt } : {}),
    })
    .where(eq(charges.id, chargeId));
}

export interface ProviderPayment {
  provider: string;
  /** Id de la transacción en el proveedor; se vuelve la clave de idempotencia del abono. */
  transaction_id: string;
  /** Id del recurso pagado (link, QR o notificación), si el proveedor lo da. */
  payable_id: string | null;
  /** Lo que se abona al cliente (pey: amountBreakdown.base). */
  base_cents: Centavos;
  gross_cents: Centavos;
  tip_cents: Centavos;
  fee_cents: Centavos;
  payer_clabe: string | null;
  tracking_key: string | null;
  /** Nuestro id de cobro, si viaja en la metadata del proveedor. */
  charge_id_hint: string | null;
  concept: string | null;
}

/**
 * Registra un pago confirmado por el proveedor. Primero busca el cobro que lo originó
 * (id del proveedor o metadata); si no lo hay, cae a la cascada normal. Idempotente por
 * transacción del proveedor.
 */
export async function recordProviderPayment(
  db: Db,
  fallbackMerchantId: string,
  pay: ProviderPayment,
): Promise<DepositOutcome & { charge_id: string | null; merchant_id: string }> {
  const ids = [pay.transaction_id, pay.payable_id].filter((x): x is string => !!x);
  const [byProvider] = await db
    .select()
    .from(charges)
    .where(and(eq(charges.provider, pay.provider), or(...ids.map((i) => eq(charges.providerChargeId, i)))));
  let charge = byProvider;
  if (!charge && pay.charge_id_hint) {
    [charge] = await db.select().from(charges).where(eq(charges.id, pay.charge_id_hint));
  }
  const merchantId = charge?.merchantId ?? fallbackMerchantId;
  const clave = `${pay.provider}:${pay.transaction_id}`;

  const extra = {
    provider: pay.provider,
    grossCents: pay.gross_cents,
    tipCents: pay.tip_cents,
    feeCents: pay.fee_cents,
    trackingKey: pay.tracking_key,
  };

  if (!charge) {
    const out = await recordDeposit(db, merchantId, {
      clave_rastreo: clave,
      amount: pay.base_cents,
      ...(pay.payer_clabe ? { ordering_clabe: pay.payer_clabe } : {}),
      ...(pay.concept ? { concept: pay.concept } : {}),
    });
    await db.update(deposits).set(extra).where(eq(deposits.claveRastreo, clave));
    return { ...out, charge_id: null, merchant_id: merchantId };
  }

  const found = charge;
  return db.transaction(async (tx) => {
    await lockMerchant(tx, merchantId);
    const inserted = await tx
      .insert(deposits)
      .values({
        merchantId,
        claveRastreo: clave,
        amountCents: pay.base_cents,
        orderingClabe: pay.payer_clabe,
        concept: pay.concept,
        reference: found.reference,
        customerId: found.customerId,
        matchMethod: "provider_charge",
        chargeId: found.id,
        ...extra,
      })
      .onConflictDoNothing({ target: deposits.claveRastreo })
      .returning({ id: deposits.id });
    const match = { matched: true as const, customer_id: found.customerId, method: "provider_charge" as never };
    if (inserted.length === 0) return { duplicate: true, match, charge_id: found.id, merchant_id: merchantId };

    const balance = await ledgerBalance(tx, merchantId, "1200", found.customerId);
    await postEntries(tx, [
      abonoIdentificado({
        merchant_id: merchantId,
        idempotency_key: `deposit:${clave}`,
        amount: pay.base_cents,
        customer_id: found.customerId,
        customer_balance: balance,
        memo: `Abono CoDi ref ${found.reference}`,
      }),
    ]);
    await tx.update(charges).set({ status: "paid" }).where(eq(charges.id, found.id));
    return { duplicate: false, match, charge_id: found.id, merchant_id: merchantId };
  });
}

export async function customerPhone10(db: Db, customerId: string): Promise<string | null> {
  const [c] = await db.select({ phone: customers.phone }).from(customers).where(eq(customers.id, customerId));
  return realPhone10(c?.phone);
}

/**
 * Celular mexicano de 10 dígitos o null. Acepta solo 10 dígitos, +52 y 10 dígitos, o +52 1 y 10
 * dígitos: cualquier otra longitud es un error de captura y nunca se recorta (mandaría el cobro a
 * otra persona). Los números que empiezan con 0 no existen en México: se usan como ficticios en la
 * demo y nunca se les envía nada.
 */
export function realPhone10(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  const m = /^(?:52|521)?([1-9]\d{9})$/.exec(digits);
  return m ? m[1]! : null;
}
