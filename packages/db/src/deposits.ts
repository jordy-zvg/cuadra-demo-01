import {
  type Deposit,
  type MatchResult,
  abonoEfectivo,
  abonoIdentificado,
  abonoSinIdentificar,
  identificarAbono,
  matchDeposit,
} from "@cuadra/core";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { ledgerBalance, postEntries } from "./ledger-repo.js";
import { charges, customerOrderingClabes, customers, deposits, journalEntries } from "./schema.js";
import { lockMerchant } from "./transfers.js";

export interface DepositOutcome {
  duplicate: boolean;
  match: MatchResult;
}

async function closePaidCharges(tx: Db, merchantId: string, customerId: string): Promise<void> {
  if ((await ledgerBalance(tx, merchantId, "1200", customerId)) > 0n) return;
  await tx
    .update(charges)
    .set({ status: "paid" })
    .where(and(eq(charges.merchantId, merchantId), eq(charges.customerId, customerId), eq(charges.status, "open")));
}

export type CashPaymentOutcome =
  | { status: "posted" | "duplicate"; balance: bigint }
  | { status: "over_balance"; balance: bigint };

/**
 * Abono de fiado en efectivo: D 1050 / H 1200, solo hasta el saldo del cliente. El saldo se vuelve a
 * leer con la tienda bloqueada (un pago por CoDi pudo llegar entre la pregunta y el «Sí»).
 * Idempotente por `idempotency_key`. Si el cliente queda sin deuda, sus cobros abiertos se cierran.
 */
export async function recordCashPayment(
  db: Db,
  merchantId: string,
  p: { customer_id: string; amount: bigint; idempotency_key: string; memo?: string },
): Promise<CashPaymentOutcome> {
  return db.transaction(async (tx) => {
    await lockMerchant(tx, merchantId);
    const balance = await ledgerBalance(tx, merchantId, "1200", p.customer_id);
    const [prev] = await tx
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(eq(journalEntries.idempotencyKey, p.idempotency_key));
    if (prev) return { status: "duplicate", balance };
    if (p.amount > balance) return { status: "over_balance", balance };
    await postEntries(tx, [
      abonoEfectivo({
        merchant_id: merchantId,
        idempotency_key: p.idempotency_key,
        amount: p.amount,
        customer_id: p.customer_id,
        customer_balance: balance,
        ...(p.memo ? { memo: p.memo } : {}),
      }),
    ]);
    await closePaidCharges(tx, merchantId, p.customer_id);
    return { status: "posted", balance: balance - p.amount };
  });
}

/** Registra un SPEI entrante: idempotente por clave_rastreo, concilia por cascada. */
export async function recordDeposit(db: Db, merchantId: string, d: Deposit): Promise<DepositOutcome> {
  return db.transaction(async (tx) => {
    await lockMerchant(tx, merchantId);
    const inserted = await tx
      .insert(deposits)
      .values({
        merchantId,
        claveRastreo: d.clave_rastreo,
        amountCents: d.amount,
        destinationClabe: d.destination_clabe ?? null,
        orderingClabe: d.ordering_clabe ?? null,
        reference: d.reference ?? null,
        concept: d.concept ?? null,
      })
      .onConflictDoNothing({ target: deposits.claveRastreo })
      .returning({ id: deposits.id });

    if (inserted.length === 0) {
      const [prev] = await tx.select().from(deposits).where(eq(deposits.claveRastreo, d.clave_rastreo));
      if (prev?.merchantId !== merchantId || prev.amountCents !== d.amount) {
        throw new Error(`clave_rastreo ${d.clave_rastreo} repetida con datos distintos`);
      }
      const match: MatchResult = prev.customerId
        ? { matched: true, customer_id: prev.customerId, method: prev.matchMethod as never }
        : { matched: false, account: "1300", reason: "Abono ya registrado por identificar." };
      return { duplicate: true, match };
    }

    const [virtual, ordering, open] = await Promise.all([
      tx.select({ clabe: customers.virtualClabe, id: customers.id }).from(customers).where(eq(customers.merchantId, merchantId)),
      tx.select().from(customerOrderingClabes).where(eq(customerOrderingClabes.merchantId, merchantId)),
      tx.select().from(charges).where(and(eq(charges.merchantId, merchantId), eq(charges.status, "open"))),
    ]);
    const match = matchDeposit(d, {
      virtual_clabes: new Map(virtual.filter((v) => v.clabe).map((v) => [v.clabe!, v.id])),
      linked_ordering_clabes: new Map(ordering.map((o) => [o.clabe, o.customerId])),
      open_charges: open.map((c) => ({
        customer_id: c.customerId,
        reference: c.reference,
        ...(c.uniqueAmountCents === null ? {} : { unique_amount: c.uniqueAmountCents }),
      })),
    });

    const key = `deposit:${d.clave_rastreo}`;
    if (match.matched) {
      const balance = await ledgerBalance(tx, merchantId, "1200", match.customer_id);
      await postEntries(tx, [
        abonoIdentificado({ merchant_id: merchantId, idempotency_key: key, amount: d.amount, customer_id: match.customer_id, customer_balance: balance }),
      ]);
      await tx
        .update(deposits)
        .set({ customerId: match.customer_id, matchMethod: match.method })
        .where(eq(deposits.claveRastreo, d.clave_rastreo));
      await closePaidCharges(tx, merchantId, match.customer_id);
    } else {
      await postEntries(tx, [abonoSinIdentificar({ merchant_id: merchantId, idempotency_key: key, amount: d.amount })]);
    }
    return { duplicate: false, match };
  });
}

/** Cola de revisión: una persona identifica un abono en 1300. D 1300 / H 1200 (+ excedente 2100). */
export async function identifyDeposit(db: Db, merchantId: string, claveRastreo: string, customerId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockMerchant(tx, merchantId);
    const [dep] = await tx
      .select()
      .from(deposits)
      .where(and(eq(deposits.claveRastreo, claveRastreo), eq(deposits.merchantId, merchantId)))
      .for("update");
    if (!dep) throw new Error(`Abono ${claveRastreo} no existe`);
    if (dep.customerId !== null) throw new Error(`Abono ${claveRastreo} ya está identificado`);
    const [c] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.merchantId, merchantId)));
    if (!c) throw new Error(`Cliente ${customerId} no existe en este comercio`);
    const balance = await ledgerBalance(tx, merchantId, "1200", customerId);
    await postEntries(tx, [
      identificarAbono({
        merchant_id: merchantId,
        idempotency_key: `deposit:${claveRastreo}:identified`,
        amount: dep.amountCents,
        customer_id: customerId,
        customer_balance: balance,
      }),
    ]);
    await tx.update(deposits).set({ customerId, matchMethod: "manual" }).where(eq(deposits.id, dep.id));
    await closePaidCharges(tx, merchantId, customerId);
  });
}

/** Abonos recibidos (digitales) del comercio desde una fecha. */
export async function depositsSince(db: Db, merchantId: string, since: Date): Promise<bigint> {
  const [r] = await db
    .select({ s: sql<string>`coalesce(sum(${deposits.amountCents}), 0)::text` })
    .from(deposits)
    .where(and(eq(deposits.merchantId, merchantId), gte(deposits.receivedAt, since)));
  return BigInt(r?.s ?? "0");
}

/** Abonos pendientes de identificar (cola de revisión). */
export async function unidentifiedDeposits(db: Db, merchantId: string) {
  return db
    .select()
    .from(deposits)
    .where(and(eq(deposits.merchantId, merchantId), isNull(deposits.customerId)))
    .orderBy(deposits.receivedAt);
}
